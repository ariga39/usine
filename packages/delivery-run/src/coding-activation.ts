import type { WriterWorkspace } from "@usine/candidate-workspace";
import { implementerOutputSchema } from "@usine/coding-session";
import type {
  CheckResult,
  TaskHistoryOutcome,
  TaskHistoryTokenUsage,
  TaskResult,
} from "@usine/task-authority";
import type { DeliveryRunInput, DeliveryRunServices } from "./delivery-run.js";
import { blockTask, recordHistory, reportProgress } from "./delivery-progress.js";

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
  reportProgress(services, reservation.result);
  await services.workspace.quarantinePriorWriters(input.contract.id, reservation.activation);
  const workspace = await services.workspace.prepareWriter(
    input.contract.id,
    reservation.activation,
    previousSha,
  );
  const startedAtEpochMs = Date.now();
  const record = async (detail: {
    outcome: TaskHistoryOutcome;
    endedAtEpochMs?: number;
    failure?: string | null;
    candidateSha?: string | null;
    tokenUsage?: TaskHistoryTokenUsage | null;
  }): Promise<void> =>
    recordHistory(services, {
      taskId: reservation.result.taskId,
      kind: "implementer",
      activation: reservation.activation,
      cycle: null,
      role: input.implementer.role,
      profile: input.implementer.profile,
      observedModel: null,
      observedProvider: null,
      startedAtEpochMs,
      endedAtEpochMs: detail.endedAtEpochMs ?? Date.now(),
      outcome: detail.outcome,
      failure: detail.failure ?? null,
      candidateSha: detail.candidateSha ?? null,
      candidateFence: reservation.activation,
      tokenUsage: detail.tokenUsage ?? null,
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
  });
  if (input.signal?.aborted) {
    await services.workspace.quarantine(workspace);
    await record({ outcome: "cancelled", failure: "coding session cancelled" });
    throw new Error("task execution cancelled");
  }
  if (observation.status !== "completed" || !observation.output) {
    await services.workspace.quarantine(workspace);
    await record({
      outcome: observation.status === "cancelled" ? "cancelled" : "failed",
      failure: observation.failure ?? observation.summary,
      tokenUsage: observation.usage,
    });
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer failed: ${observation.failure ?? observation.summary}`,
    };
  }
  const output = observation.output;
  if (output.status === "blocked") {
    await services.workspace.quarantine(workspace);
    await record({ outcome: "blocked", failure: output.summary, tokenUsage: observation.usage });
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer blocked: ${output.summary}`,
    };
  }
  try {
    const candidate = await services.workspace.freeze(workspace, previousSha, input.contract);
    const accepted = await services.authority.recordCandidate(
      { taskId: reservation.result.taskId, revision: reservation.result.revision },
      {
        sha: candidate.sha,
        baseSha: candidate.baseSha,
        fence: reservation.activation,
      },
    );
    reportProgress(services, accepted);
    await record({
      outcome: "succeeded",
      candidateSha: candidate.sha,
      tokenUsage: observation.usage,
    });
    return {
      status: "succeeded",
      result: accepted,
      candidate: { ...candidate, workspace },
    };
  } catch (error) {
    if (input.signal?.aborted) {
      await services.workspace.quarantine(workspace);
      throw error;
    }
    await services.workspace.quarantine(workspace);
    await record({
      outcome: "failed",
      failure: error instanceof Error ? error.message : String(error),
      tokenUsage: observation.usage,
    });
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
