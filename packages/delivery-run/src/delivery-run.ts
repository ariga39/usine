import { CandidateWorkspace } from "@usine/candidate-workspace";
import { CodexCodingSession } from "@usine/coding-session";
import { DeliveryQuarantineError, ForgeDelivery } from "@usine/forge-delivery";
import { QualityGate } from "@usine/quality-gate";
import {
  deadlineExpired,
  TaskAuthority,
  type CheckResult,
  type TaskContract,
  type TaskProgress,
  type TaskResult,
} from "@usine/task-authority";
import type { RolePolicy } from "@usine/coding-session";
import { activateImplementer } from "./coding-activation.js";
import { blockTask, reportProgress } from "./delivery-progress.js";

export interface DeliveryRunInput {
  contract: TaskContract;
  contractHash: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
  implementer: RolePolicy;
}

export interface DeliveryRunServices {
  authority: TaskAuthority;
  workspace: CandidateWorkspace;
  session: CodexCodingSession;
  quality: QualityGate;
  forge: ForgeDelivery;
  onProgress?: (progress: TaskProgress) => void;
}

export async function executeDeliveryRun(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
): Promise<TaskResult> {
  let result = await services.authority.admit({
    contract: input.contract,
    contractHash: input.contractHash,
    repositoryIdentity: input.repositoryIdentity,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  if (result.state === "reviewed_pr" || result.state === "blocked") return result;
  let lastProgressRevision = result.revision;
  const runServices: DeliveryRunServices = services.onProgress
    ? {
        ...services,
        onProgress: (progress) => {
          if (progress.revision <= lastProgressRevision) return;
          lastProgressRevision = progress.revision;
          services.onProgress?.(progress);
        },
      }
    : services;
  if (deadlineExpired(result.deadlineEpochMs))
    return blockTask(runServices, result, "elapsed budget exhausted");
  // This is intentionally a reducer over the durable result.  A restart must
  // resume the phase represented by SQLite, never infer progress from a
  // worker process or start from the contract base again.
  for (;;) {
    if (result.state === "blocked") return result;
    if (deadlineExpired(result.deadlineEpochMs))
      return blockTask(runServices, result, "elapsed budget exhausted");

    if (result.state === "admitted") {
      result = await activateImplementer(
        input,
        runServices,
        result,
        input.contract.baseSha,
        null,
        [],
      );
      continue;
    }

    if (result.state === "candidate") {
      if (!result.candidateSha)
        return blockTask(runServices, result, "candidate phase has no exact SHA");
      await runServices.workspace.quarantinePriorWriters(
        input.contract.id,
        Number.MAX_SAFE_INTEGER,
      );
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let check: CheckResult;
      try {
        check = await runServices.quality.check(input.contract, result.candidateSha, cycle);
      } catch (error) {
        return blockTask(
          runServices,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      result = await runServices.authority.recordCheck(
        { taskId: result.taskId, revision: result.revision },
        check,
      );
      reportProgress(runServices, result);
      continue;
    }

    if (result.state === "checked") {
      if (!result.check || !result.candidateSha)
        return blockTask(runServices, result, "checked phase is incomplete");
      if (result.check.status === "failed") {
        result = await activateImplementer(
          input,
          runServices,
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
        review = await runServices.quality.review(
          input.contract,
          result.candidateSha,
          result.check,
          cycle,
        );
      } catch (error) {
        return blockTask(
          runServices,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      result = await runServices.authority.recordReview(
        { taskId: result.taskId, revision: result.revision },
        review,
      );
      reportProgress(runServices, result);
      continue;
    }

    if (result.state === "reviewed") {
      if (!result.review || !result.check || !result.candidateSha)
        return blockTask(runServices, result, "reviewed phase is incomplete");
      if (result.review.verdict === "changes_requested") {
        if (
          result.evidence.changesRequestedBatches > result.evidence.reviewCycles ||
          result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles ||
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
        )
          return blockTask(
            runServices,
            result,
            "review changes requested after recovery budget was exhausted",
          );
        // This marker is durable, so a restart cannot count the same finding
        // batch twice before activating its repair writer.
        const candidateSha = result.candidateSha;
        const findings = result.review.findings;
        if (result.evidence.changesRequestedBatches < result.evidence.reviewCycles) {
          result = await runServices.authority.recordRepairBatch({
            taskId: result.taskId,
            revision: result.revision,
          });
          reportProgress(runServices, result);
        }
        result = await activateImplementer(
          input,
          runServices,
          result,
          candidateSha,
          null,
          findings,
        );
        continue;
      }
      if (result.review.verdict === "inconclusive")
        return blockTask(runServices, result, `review inconclusive: ${result.review.summary}`);
      // ForgeDelivery probes before every effect, so a restart after an
      // uncertain PR/comment write reconciles the same approved bundle.  Keep
      // the approved review durable if delivery throws; the next run retries
      // this exact bundle without another implementer.
      let delivery: Awaited<ReturnType<ForgeDelivery["deliver"]>>;
      try {
        delivery = await runServices.forge.deliver(
          input.contract,
          result.candidateSha,
          result.check,
          result.review,
        );
      } catch (error) {
        if (error instanceof DeliveryQuarantineError)
          return blockTask(runServices, result, error.message);
        throw error;
      }
      const delivered = await runServices.authority.recordDelivery(
        { taskId: result.taskId, revision: result.revision },
        delivery,
      );
      reportProgress(runServices, delivered);
      return delivered;
    }

    return blockTask(runServices, result, "unknown durable task phase");
  }
}
