import type { WriterWorkspace } from "@usine/candidate-workspace";
import { implementerOutputSchema, type SessionArchiveCaptureStatus } from "@usine/coding-session";
import {
  deadlineExpired,
  countBudgetExhausted,
  type CheckResult,
  type TaskObservationEventData,
  type TaskFailureClass,
  type TaskResult,
  type TaskWaitingResumeState,
  taskFailureClassFromProvider,
  originalTaskContract,
} from "@usine/task-authority";
import type { DeliveryRunInput, DeliveryRunServices } from "./delivery-run.js";
import { blockTask, emitCodingInterruption, emitCodingObservation } from "./delivery-progress.js";

function implementerPrompt(
  input: DeliveryRunInput,
  previousSha: string,
  check: CheckResult | null,
  findings: string[],
): string {
  const taskContract = originalTaskContract(input.contract);
  return [
    `Task Contract: ${JSON.stringify(taskContract)}`,
    `Current candidate parent SHA: ${previousSha}`,
    check
      ? `Failed project check evidence: ${JSON.stringify(check)}`
      : findings.length > 0
        ? `Aggregated findings to repair: ${findings.join("; ")}`
        : "No prior findings.",
    "Return a schema-valid proposed or blocked result; the host will finalize the Candidate and the coordinator owns authority.",
  ].join("\n");
}

type CodingAttempt =
  | {
      status: "succeeded";
      result: TaskResult;
      candidate: { sha: string; baseSha: string; workspace: WriterWorkspace };
    }
  | {
      status: "failed";
      result: TaskResult;
      reason: string;
      retryable: boolean;
      failureClass?: TaskFailureClass;
    };

async function runCodingAttempt(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
  previousSha: string,
  check: CheckResult | null,
  findings: string[],
): Promise<CodingAttempt> {
  if (input.signal?.aborted) throw new Error("task execution cancelled");
  const reservation = await services.authority.reserveActivation(
    input.contract.id,
    input.contract.budget.maxImplementerActivations,
  );
  await services.workspace.quarantinePriorWriters(input.contract.id, reservation.activation);
  const workspace = await services.workspace.prepareWriter(
    input.contract.id,
    reservation.activation,
    previousSha,
  );
  const observationCounter = { value: 0 };
  const sessionId = `coding-session:${reservation.activation}:${input.implementer.role}`;
  const emit = async (data: TaskObservationEventData): Promise<void> => {
    await services.authority.appendObservation(reservation.result.taskId, {
      eventId: `coding:${reservation.activation}:${observationCounter.value++}:${data.type}`,
      occurredAtEpochMs: Date.now(),
      data,
    });
  };
  const emitSessionObservation = (observation: Parameters<typeof emitCodingObservation>[7]) =>
    emitCodingObservation(
      services,
      reservation.result.taskId,
      input.implementer.role,
      reservation.activation,
      sessionId,
      `coding:${reservation.activation}`,
      observationCounter,
      observation,
    );
  await emit({
    type: "coding_session_started",
    role: input.implementer.role,
    activation: reservation.activation,
    sessionId,
    requestedProfile: input.implementer.profile,
  });
  const observation = await services.session.run({
    role: input.implementer.role,
    attempt: String(reservation.activation),
    workspace: workspace.path,
    contract: originalTaskContract(input.contract),
    prompt: implementerPrompt(input, previousSha, check, findings),
    profile: input.implementer.profile,
    sandbox: input.implementer.sandbox,
    deadlineEpochMs: reservation.result.deadlineEpochMs,
    outputSchema: implementerOutputSchema,
    signal: input.signal,
    onObservation: emitSessionObservation,
  });
  if (input.signal?.aborted) {
    await services.workspace.quarantine(workspace);
    await emitCodingInterruption(
      services,
      reservation.result.taskId,
      input.implementer.role,
      reservation.activation,
      sessionId,
      `coding:${reservation.activation}`,
      observationCounter,
      {
        phase: observation.phase ?? "turn",
        failureClass: "cancellation",
      },
    );
    await emit({
      type: "coding_session_completed",
      role: input.implementer.role,
      activation: reservation.activation,
      outcome: "cancelled",
      sessionId,
      requestedProfile: observation.requestedProfile ?? input.implementer.profile,
      ...(observation.effectiveProfile ? { effectiveProfile: observation.effectiveProfile } : {}),
      usage: observation.usage ?? null,
      ...(observation.usageCompleteness
        ? { usageCompleteness: observation.usageCompleteness }
        : {}),
      ...(observation.normalizer ? { normalizer: observation.normalizer } : {}),
      ...archiveReference(observation),
    });
    throw new Error("task execution cancelled");
  }
  if (observation.status !== "completed" || !observation.output) {
    await services.workspace.quarantine(workspace);
    if (observation.phase && observation.failureClass)
      await emitCodingInterruption(
        services,
        reservation.result.taskId,
        input.implementer.role,
        reservation.activation,
        sessionId,
        `coding:${reservation.activation}`,
        observationCounter,
        {
          phase: observation.phase,
          failureClass: taskFailureClassFromProvider(observation.failureClass),
        },
      );
    await emit({
      type: "coding_session_completed",
      role: input.implementer.role,
      activation: reservation.activation,
      outcome: observation.status === "cancelled" ? "cancelled" : "failed",
      sessionId,
      requestedProfile: observation.requestedProfile ?? input.implementer.profile,
      ...(observation.effectiveProfile ? { effectiveProfile: observation.effectiveProfile } : {}),
      usage: observation.usage ?? null,
      ...(observation.usageCompleteness
        ? { usageCompleteness: observation.usageCompleteness }
        : {}),
      ...(observation.normalizer ? { normalizer: observation.normalizer } : {}),
      ...archiveReference(observation),
    });
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer coding session failed",
      failureClass: observation.failureClass
        ? taskFailureClassFromProvider(observation.failureClass)
        : undefined,
      retryable:
        input.implementer.role === "implementer" &&
        observation.phase === "turn" &&
        (observation.failureClass === "network" ||
          observation.failureClass === "transient_transport"),
    };
  }
  const output = observation.output;
  if (output.status === "blocked") {
    await services.workspace.quarantine(workspace);
    await emit({
      type: "coding_session_completed",
      role: input.implementer.role,
      activation: reservation.activation,
      outcome: "blocked",
      sessionId,
      requestedProfile: observation.requestedProfile ?? input.implementer.profile,
      ...(observation.effectiveProfile ? { effectiveProfile: observation.effectiveProfile } : {}),
      usage: observation.usage ?? null,
      ...(observation.usageCompleteness
        ? { usageCompleteness: observation.usageCompleteness }
        : {}),
      ...(observation.normalizer ? { normalizer: observation.normalizer } : {}),
      ...archiveReference(observation),
    });
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer coding session blocked",
      retryable: false,
    };
  }
  await emit({
    type: "coding_session_completed",
    role: input.implementer.role,
    activation: reservation.activation,
    outcome: "succeeded",
    sessionId,
    requestedProfile: observation.requestedProfile ?? input.implementer.profile,
    ...(observation.effectiveProfile ? { effectiveProfile: observation.effectiveProfile } : {}),
    usage: observation.usage ?? null,
    ...(observation.usageCompleteness ? { usageCompleteness: observation.usageCompleteness } : {}),
    ...(observation.normalizer ? { normalizer: observation.normalizer } : {}),
    ...archiveReference(observation),
  });
  try {
    const candidate = await services.workspace.freeze(workspace, previousSha, input.contract);
    const accepted = await services.authority.recordCandidate(
      { taskId: reservation.result.taskId, revision: reservation.result.revision },
      { sha: candidate.sha, baseSha: candidate.baseSha, fence: reservation.activation },
    );
    return {
      status: "succeeded",
      result: accepted,
      candidate: { ...candidate, workspace },
    };
  } catch (error) {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

function archiveReference(observation: {
  archiveId?: string;
  archiveStatus?: SessionArchiveCaptureStatus;
  archiveCompleteness?: "complete" | "partial";
}): {
  archive?: {
    archiveId: string;
    status: SessionArchiveCaptureStatus;
    completeness?: "complete" | "partial";
  };
} {
  return observation.archiveId && observation.archiveStatus
    ? {
        archive: {
          archiveId: observation.archiveId,
          status: observation.archiveStatus,
          ...(observation.archiveCompleteness
            ? { completeness: observation.archiveCompleteness }
            : {}),
        },
      }
    : {};
}

export async function activateImplementer(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
  result: TaskResult,
  previousSha: string,
  check: CheckResult | null,
  findings: string[],
): Promise<TaskResult> {
  let attempt: Awaited<ReturnType<typeof runCodingAttempt>>;
  try {
    attempt = await runCodingAttempt(input, services, previousSha, check, findings);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return blockTask(services, result, error instanceof Error ? error.message : String(error));
  }
  if (attempt.status === "failed") {
    if (attempt.failureClass === "cancellation") return attempt.result;
    if (
      attempt.retryable &&
      !countBudgetExhausted(
        input.contract.budget.maxImplementerActivations,
        attempt.result.evidence.implementerActivations,
      ) &&
      !deadlineExpired(attempt.result.deadlineEpochMs)
    ) {
      const resumeState: TaskWaitingResumeState | null =
        attempt.result.state === "admitted" ||
        attempt.result.state === "checked" ||
        attempt.result.state === "reviewed"
          ? attempt.result.state
          : null;
      if (resumeState === null)
        return blockTask(services, attempt.result, "invalid task phase for retry");
      return services.authority.recordWaiting(
        { taskId: attempt.result.taskId, revision: attempt.result.revision },
        {
          reason: "network_interruption",
          resumeState,
          activation: attempt.result.evidence.implementerActivations,
        },
      );
    }
    return blockTask(services, attempt.result, attempt.reason, attempt.failureClass);
  }
  await services.workspace.quarantine(attempt.candidate.workspace);
  return attempt.result;
}
