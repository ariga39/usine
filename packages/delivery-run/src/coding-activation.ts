import type { WriterWorkspace } from "@usine/candidate-workspace";
import { implementerOutputSchema } from "@usine/coding-session";
import type { CheckResult, TaskObservationEventData, TaskResult } from "@usine/task-authority";
import type { DeliveryRunInput, DeliveryRunServices } from "./delivery-run.js";
import { blockTask, emitCodingInterruption, emitCodingObservation } from "./delivery-progress.js";

function implementerPrompt(
  input: DeliveryRunInput,
  previousSha: string,
  check: CheckResult | null,
  findings: string[],
): string {
  return [
    "Role: implementer. Work only on the frozen authorized Task Contract.",
    `Task Contract: ${JSON.stringify(input.contract)}`,
    `Current candidate parent SHA: ${previousSha}`,
    check
      ? `Failed project check evidence: ${JSON.stringify(check)}`
      : findings.length > 0
        ? `Aggregated findings to repair: ${findings.join("; ")}`
        : "No prior findings.",
    "Implement the requested production behavior and its real tests. Leave the workspace with the complete change; the host will finalize the commit.",
    "Return a schema-valid proposed or blocked result. Do not claim task completion; the coordinator owns authority.",
  ].join("\n");
}

type CodingAttempt =
  | {
      status: "succeeded";
      result: TaskResult;
      candidate: { sha: string; baseSha: string; workspace: WriterWorkspace };
    }
  | { status: "failed"; result: TaskResult; reason: string };

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
  });
  const observation = await services.session.run({
    role: input.implementer.role,
    workspace: workspace.path,
    contract: input.contract,
    prompt: implementerPrompt(input, previousSha, check, findings),
    profile: input.implementer.profile,
    sandbox: input.implementer.sandbox,
    deadlineEpochMs: reservation.result.deadlineEpochMs,
    outputSchema: implementerOutputSchema,
    execution: {
      taskId: reservation.result.taskId,
      role: input.implementer.role,
      attempt: String(reservation.activation),
    },
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
        { phase: observation.phase, failureClass: observation.failureClass },
      );
    await emit({
      type: "coding_session_completed",
      role: input.implementer.role,
      activation: reservation.activation,
      outcome: observation.status === "cancelled" ? "cancelled" : "failed",
      sessionId,
    });
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer coding session failed",
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
    });
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer coding session blocked",
    };
  }
  await emit({
    type: "coding_session_completed",
    role: input.implementer.role,
    activation: reservation.activation,
    outcome: "succeeded",
    sessionId,
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
    };
  }
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
    if (
      attempt.result.evidence.implementerActivations >=
      input.contract.budget.maxImplementerActivations
    )
      return blockTask(services, attempt.result, attempt.reason);
    return attempt.result;
  }
  await services.workspace.quarantine(attempt.candidate.workspace);
  return attempt.result;
}
