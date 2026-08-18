import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace, type WriterWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { TaskAuthority, type TaskResult } from "./task-authority.js";

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

function failedResult(result: TaskResult, blocker: string): TaskResult {
  return { ...result, state: "blocked", blocker };
}

function implementerPrompt(
  input: DeliveryRunInput,
  previousSha: string,
  findings: string[],
): string {
  return [
    "Role: implementer. Work only on the frozen authorized Task Contract.",
    `Task Contract: ${JSON.stringify(input.contract)}`,
    `Current candidate parent SHA: ${previousSha}`,
    findings.length > 0
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
    prompt: implementerPrompt(input, previousSha, findings),
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
    services.authority.acceptCandidate(reservation.result, {
      sha: candidate.sha,
      baseSha: candidate.baseSha,
      generation: reservation.result.writer.generation,
      fence: workspace.fence,
    });
    return {
      status: "succeeded",
      result: reservation.result,
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
    return services.authority.save(failedResult(result, "elapsed budget exhausted"));
  if (input.stopAfterAdmitted) return result;

  // This is intentionally a reducer over the durable result.  A restart must
  // resume the phase represented by PostgreSQL, never infer progress from a
  // worker process or start from the contract base again.
  for (;;) {
    if (Date.now() >= result.deadlineEpochMs)
      return services.authority.save(failedResult(result, "elapsed budget exhausted"));

    if (result.state === "admitted" || result.state === "checked" || result.state === "reviewed") {
      const checkFailed = result.state === "checked" && result.check?.status === "failed";
      const reviewNeedsRepair =
        result.state === "reviewed" && result.review?.verdict === "changes_requested";
      if (
        reviewNeedsRepair &&
        result.evidence.changesRequestedBatches < result.evidence.reviewCycles
      ) {
        if (
          result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles ||
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
        )
          return services.authority.save(
            failedResult(result, "review changes requested after recovery budget was exhausted"),
          );
        // This marker is durable, so a restart cannot count the same finding
        // batch twice before activating its repair writer.
        result = await services.authority.save({
          ...result,
          evidence: {
            ...result.evidence,
            changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
          },
        });
        continue;
      }
      if (result.state === "admitted" || checkFailed || reviewNeedsRepair) {
        const previousSha = result.candidateSha ?? input.contract.baseSha;
        const findings =
          result.state === "checked"
            ? [result.check?.stderr || "project check failed"]
            : (result.review?.findings ?? []);
        let attempt: Awaited<ReturnType<typeof runCodingAttempt>>;
        try {
          attempt = await runCodingAttempt(input, services, previousSha, findings);
        } catch (error) {
          return services.authority.save(
            failedResult(result, error instanceof Error ? error.message : String(error)),
          );
        }
        result = attempt.result;
        if (attempt.status === "failed") {
          if (
            result.evidence.implementerActivations >=
            input.contract.budget.maxImplementerActivations
          )
            return services.authority.save(failedResult(result, attempt.reason));
          continue;
        }
        const candidate = attempt.candidate;
        result = await services.authority.save({
          ...result,
          state: "candidate",
          candidateSha: candidate.sha,
          candidateFence: candidate.workspace.fence,
          check: null,
          review: null,
          delivery: null,
          blocker: null,
          activeActivation: null,
        });
        await services.workspace.quarantine(candidate.workspace);
        continue;
      }
    }

    if (result.state === "candidate" || result.state === "checked") {
      if (result.state === "checked" && !result.check)
        return services.authority.save(failedResult(result, "checked phase has no check fact"));
      if (result.state === "checked" && result.check?.status === "failed") continue;
      if (!result.candidateSha)
        return services.authority.save(
          failedResult(result, `${result.state} phase has no exact SHA`),
        );
      if (result.state === "candidate")
        await services.workspace.quarantinePriorWriters(input.contract.id, Number.MAX_SAFE_INTEGER);
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let evaluation: Awaited<ReturnType<QualityGate["evaluate"]>>;
      try {
        evaluation = await services.quality.evaluate(input.contract, result.candidateSha, cycle);
      } catch (error) {
        return services.authority.save(
          failedResult(result, error instanceof Error ? error.message : String(error)),
        );
      }
      result = await services.authority.save({
        ...result,
        state: "checked",
        check: evaluation.check,
        review: null,
      });
      if (evaluation.check.status !== "passed") continue;
      result = await services.authority.save({
        ...result,
        state: "reviewed",
        review: evaluation.review,
        evidence: { ...result.evidence, reviewCycles: cycle },
      });
      continue;
    }

    if (result.state === "reviewed") {
      if (!result.review || !result.check || !result.candidateSha)
        return services.authority.save(failedResult(result, "reviewed phase is incomplete"));
      if (result.review.verdict === "inconclusive")
        return services.authority.save(
          failedResult(result, `review inconclusive: ${result.review.summary}`),
        );
      if (result.review.verdict === "changes_requested") {
        return services.authority.save(
          failedResult(result, "review repair reducer did not advance"),
        );
      }
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
      return services.authority.save({ ...result, state: "reviewed_pr", delivery });
    }

    return services.authority.save(failedResult(result, "unknown durable task phase"));
  }
}

export async function writeTaskResult(stateDirectory: string, result: TaskResult): Promise<void> {
  const path = resolve(stateDirectory, "results", `${result.taskId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}
