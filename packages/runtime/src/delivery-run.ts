import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace, type WriterWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { TaskAuthority, type CheckResult, type TaskResult } from "./task-authority.js";

export interface DeliveryRunInput {
  contract: TaskContract;
  contractHash: string;
  repository: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
  implementerModel: string;
  stopAfterAdmitted: boolean;
}

export interface DeliveryRunServices {
  authority: TaskAuthority;
  workspace: CandidateWorkspace;
  session: CodexCodingSession;
  quality: QualityGate;
  forge: ForgeDelivery;
}

const implementerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["proposed", "blocked"] },
    summary: { type: "string" },
  },
};

function blockTask(
  authority: TaskAuthority,
  result: TaskResult,
  blocker: string,
): Promise<TaskResult> {
  return authority.block({ taskId: result.taskId, revision: result.revision }, blocker);
}

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
  const observation = await services.session.run({
    role: "implementer",
    workspace: workspace.path,
    contract: input.contract,
    prompt: implementerPrompt(input, previousSha, check, findings),
    model: input.implementerModel,
    reasoningEffort: "high",
    sandbox: "workspace-write",
    deadlineEpochMs: reservation.result.deadlineEpochMs,
    outputSchema: implementerSchema,
  });
  if (observation.status !== "completed") {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer failed: ${observation.failure ?? observation.summary}`,
    };
  }
  const output =
    typeof observation.output === "string"
      ? (() => {
          try {
            return JSON.parse(observation.output) as { status?: string; summary?: string };
          } catch {
            return {};
          }
        })()
      : (observation.output as { status?: string; summary?: string } | null);
  if (output?.status === "blocked") {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer blocked: ${output.summary ?? "no reason"}`,
    };
  }
  if (!output || output.status !== "proposed" || typeof output.summary !== "string") {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer returned invalid terminal observation",
    };
  }
  try {
    const candidate = await services.workspace.freeze(workspace, previousSha);
    const accepted = await services.authority.recordCandidate(
      { taskId: reservation.result.taskId, revision: reservation.result.revision },
      {
        sha: candidate.sha,
        baseSha: candidate.baseSha,
        generation: reservation.result.writer.generation,
        fence: workspace.fence,
      },
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

async function activateImplementer(
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
    return blockTask(
      services.authority,
      result,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (attempt.status === "failed") {
    if (
      attempt.result.evidence.implementerActivations >=
      input.contract.budget.maxImplementerActivations
    )
      return blockTask(services.authority, attempt.result, attempt.reason);
    return attempt.result;
  }
  await services.workspace.quarantine(attempt.candidate.workspace);
  return attempt.result;
}

export async function executeDeliveryRun(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
): Promise<TaskResult> {
  let result = await services.authority.admit({
    contract: input.contract,
    contractHash: input.contractHash,
    repository: input.repository,
    repositoryIdentity: input.repositoryIdentity,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  if (result.state === "reviewed_pr" || result.state === "blocked") return result;
  if (Date.now() >= result.deadlineEpochMs)
    return blockTask(services.authority, result, "elapsed budget exhausted");
  if (input.stopAfterAdmitted) return result;

  // This is intentionally a reducer over the durable result.  A restart must
  // resume the phase represented by SQLite, never infer progress from a
  // worker process or start from the contract base again.
  for (;;) {
    if (Date.now() >= result.deadlineEpochMs)
      return blockTask(services.authority, result, "elapsed budget exhausted");

    if (result.state === "admitted") {
      result = await activateImplementer(input, services, result, input.contract.baseSha, null, []);
      continue;
    }

    if (result.state === "candidate") {
      if (!result.candidateSha)
        return blockTask(services.authority, result, "candidate phase has no exact SHA");
      await services.workspace.quarantinePriorWriters(input.contract.id, Number.MAX_SAFE_INTEGER);
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let check: CheckResult;
      try {
        check = await services.quality.check(input.contract, result.candidateSha, cycle);
      } catch (error) {
        return blockTask(
          services.authority,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      result = await services.authority.recordCheck(
        { taskId: result.taskId, revision: result.revision },
        check,
      );
      continue;
    }

    if (result.state === "checked") {
      if (!result.check || !result.candidateSha)
        return blockTask(services.authority, result, "checked phase is incomplete");
      if (result.check.status === "failed") {
        result = await activateImplementer(
          input,
          services,
          result,
          result.candidateSha,
          result.check,
          [],
        );
        continue;
      }
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let review: Awaited<ReturnType<QualityGate["review"]>>;
      try {
        review = await services.quality.review(
          input.contract,
          result.candidateSha,
          result.check,
          cycle,
        );
      } catch (error) {
        return blockTask(
          services.authority,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      result = await services.authority.recordReview(
        { taskId: result.taskId, revision: result.revision },
        review,
      );
      continue;
    }

    if (result.state === "reviewed") {
      if (!result.review || !result.check || !result.candidateSha)
        return blockTask(services.authority, result, "reviewed phase is incomplete");
      if (result.review.verdict === "changes_requested") {
        if (
          result.evidence.changesRequestedBatches > result.evidence.reviewCycles ||
          result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles ||
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
        )
          return blockTask(
            services.authority,
            result,
            "review changes requested after recovery budget was exhausted",
          );
        // This marker is durable, so a restart cannot count the same finding
        // batch twice before activating its repair writer.
        const candidateSha = result.candidateSha;
        const findings = result.review.findings;
        if (result.evidence.changesRequestedBatches < result.evidence.reviewCycles)
          result = await services.authority.recordRepairBatch({
            taskId: result.taskId,
            revision: result.revision,
          });
        result = await activateImplementer(input, services, result, candidateSha, null, findings);
        continue;
      }
      if (result.review.verdict === "inconclusive")
        return blockTask(
          services.authority,
          result,
          `review inconclusive: ${result.review.summary}`,
        );
      // ForgeDelivery probes before every effect, so a restart after an
      // uncertain PR/comment write reconciles the same approved bundle.  Keep
      // the approved review durable if delivery throws; the next run retries
      // this exact bundle without another implementer.
      const delivery = await services.forge.deliver(
        input.contract,
        result.candidateSha,
        result.check,
        result.review,
      );
      return services.authority.recordDelivery(
        { taskId: result.taskId, revision: result.revision },
        delivery,
      );
    }

    return blockTask(services.authority, result, "unknown durable task phase");
  }
}

export async function writeTaskResult(stateDirectory: string, result: TaskResult): Promise<void> {
  const path = resolve(stateDirectory, "results", `${result.taskId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}
