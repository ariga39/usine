import type { FrozenCandidate, WriterWorkspace } from "@usine/candidate-workspace";
import type {
  ImplementerOutput,
  RolePolicy,
  SessionObservation,
  SessionRequest,
} from "@usine/coding-session";
import type { ReviewAttemptObservation } from "@usine/quality-gate";
import { DeliveryQuarantineError } from "@usine/forge-delivery";
import {
  deadlineExpired,
  type AuthorityInput,
  type CandidateFact,
  type CheckResult,
  type DeliveryEffect,
  type ReviewVerdict,
  type ResolvedTaskContract,
  type TaskObservation,
  type TaskProgress,
  type TaskResult,
  type TaskHistoryRecordInput,
  type TaskHistoryTokenUsage,
} from "@usine/task-authority";
import { activateImplementer } from "./coding-activation.js";
import { blockTask, recordHistory, reportProgress } from "./delivery-progress.js";

export interface DeliveryRunInput {
  contract: ResolvedTaskContract;
  contractHash: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
  implementer: RolePolicy;
  reviewer?: RolePolicy;
  signal?: AbortSignal;
}

interface DeliveryRunAuthority {
  admit(input: AuthorityInput): Promise<TaskResult>;
  reserveActivation(
    taskId: string,
    budget: number,
  ): Promise<{ result: TaskResult; activation: number }>;
  recordCandidate(observation: TaskObservation, candidate: CandidateFact): Promise<TaskResult>;
  recordCheck(observation: TaskObservation, check: CheckResult): Promise<TaskResult>;
  recordReview(observation: TaskObservation, review: ReviewVerdict): Promise<TaskResult>;
  recordRepairBatch(observation: TaskObservation): Promise<TaskResult>;
  recordDelivery(observation: TaskObservation, delivery: DeliveryEffect): Promise<TaskResult>;
  block(observation: TaskObservation, blocker: string): Promise<TaskResult>;
  appendHistory(input: TaskHistoryRecordInput): Promise<unknown>;
}

interface DeliveryRunWorkspace {
  quarantinePriorWriters(taskId: string, activation: number): Promise<void>;
  prepareWriter(taskId: string, activation: number, baseSha: string): Promise<WriterWorkspace>;
  freeze(
    workspace: WriterWorkspace,
    previousSha: string,
    contract: ResolvedTaskContract,
  ): Promise<FrozenCandidate>;
  quarantine(workspace: WriterWorkspace): Promise<void>;
}

interface DeliveryRunSession {
  run(request: SessionRequest<ImplementerOutput>): Promise<
    Pick<SessionObservation<ImplementerOutput>, "status" | "output"> &
      Pick<SessionObservation<ImplementerOutput>, "summary" | "failure"> & {
        usage?: TaskHistoryTokenUsage | null;
      }
  >;
}

interface DeliveryRunQuality {
  check(contract: ResolvedTaskContract, sha: string, cycle: number): Promise<CheckResult>;
  reviewWithObservation(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    cycle: number,
  ): Promise<ReviewAttemptObservation>;
}

interface DeliveryRunForge {
  deliver(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect>;
}

export interface DeliveryRunServices {
  authority: DeliveryRunAuthority;
  workspace: DeliveryRunWorkspace;
  session: DeliveryRunSession;
  quality: DeliveryRunQuality;
  forge: DeliveryRunForge;
  onProgress?: (progress: TaskProgress) => void;
}

export async function executeDeliveryRun(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
): Promise<TaskResult> {
  throwIfAborted(input.signal);
  let result = await services.authority.admit({
    contract: input.contract,
    contractHash: input.contractHash,
    repositoryIdentity: input.repositoryIdentity,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  throwIfAborted(input.signal);
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
      const startedAtEpochMs = Date.now();
      let check: CheckResult;
      try {
        check = await runServices.quality.check(input.contract, result.candidateSha, cycle);
        throwIfAborted(input.signal);
      } catch (error) {
        await recordHistory(runServices, {
          taskId: result.taskId,
          kind: "project_check",
          activation: result.candidateFence,
          cycle,
          role: null,
          profile: null,
          observedModel: null,
          observedProvider: null,
          startedAtEpochMs,
          endedAtEpochMs: Date.now(),
          outcome: input.signal?.aborted ? "cancelled" : "failed",
          failure: error instanceof Error ? error.message : String(error),
          candidateSha: result.candidateSha,
          candidateFence: result.candidateFence,
          tokenUsage: null,
        });
        if (input.signal?.aborted) throw error;
        return blockTask(
          runServices,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      await recordHistory(runServices, {
        taskId: result.taskId,
        kind: "project_check",
        activation: result.candidateFence,
        cycle,
        role: null,
        profile: null,
        observedModel: null,
        observedProvider: null,
        startedAtEpochMs,
        endedAtEpochMs: Date.now(),
        outcome: check.status === "passed" ? "succeeded" : "failed",
        failure:
          check.status === "passed" ? null : `project check exited with code ${check.exitCode}`,
        candidateSha: result.candidateSha,
        candidateFence: result.candidateFence,
        tokenUsage: null,
      });
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
      const startedAtEpochMs = Date.now();
      let review: ReviewVerdict;
      let reviewUsage: TaskHistoryTokenUsage | null = null;
      try {
        const observation = await runServices.quality.reviewWithObservation(
          input.contract,
          result.candidateSha,
          result.check,
          cycle,
        );
        review = observation.review;
        reviewUsage = observation.usage;
        throwIfAborted(input.signal);
      } catch (error) {
        await recordHistory(runServices, {
          taskId: result.taskId,
          kind: "fresh_review",
          activation: result.candidateFence,
          cycle,
          role: input.reviewer?.role ?? "reviewer",
          profile: input.reviewer?.profile ?? null,
          observedModel: null,
          observedProvider: null,
          startedAtEpochMs,
          endedAtEpochMs: Date.now(),
          outcome: input.signal?.aborted ? "cancelled" : "failed",
          failure: error instanceof Error ? error.message : String(error),
          candidateSha: result.candidateSha,
          candidateFence: result.candidateFence,
          tokenUsage: reviewUsage,
        });
        if (input.signal?.aborted) throw error;
        return blockTask(
          runServices,
          result,
          error instanceof Error ? error.message : String(error),
        );
      }
      await recordHistory(runServices, {
        taskId: result.taskId,
        kind: "fresh_review",
        activation: result.candidateFence,
        cycle,
        role: input.reviewer?.role ?? "reviewer",
        profile: input.reviewer?.profile ?? null,
        observedModel: null,
        observedProvider: null,
        startedAtEpochMs,
        endedAtEpochMs: Date.now(),
        outcome:
          review.verdict === "approved"
            ? "succeeded"
            : review.verdict === "changes_requested"
              ? "failed"
              : "blocked",
        failure: review.verdict === "approved" ? null : review.summary,
        candidateSha: result.candidateSha,
        candidateFence: result.candidateFence,
        tokenUsage: reviewUsage,
      });
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
      let delivery: Awaited<ReturnType<DeliveryRunForge["deliver"]>>;
      const startedAtEpochMs = Date.now();
      try {
        delivery = await runServices.forge.deliver(
          input.contract,
          result.candidateSha,
          result.check,
          result.review,
        );
        throwIfAborted(input.signal);
      } catch (error) {
        await recordHistory(runServices, {
          taskId: result.taskId,
          kind: "forge_delivery",
          activation: null,
          cycle: null,
          role: null,
          profile: null,
          observedModel: null,
          observedProvider: null,
          startedAtEpochMs,
          endedAtEpochMs: Date.now(),
          outcome: input.signal?.aborted
            ? "cancelled"
            : error instanceof DeliveryQuarantineError
              ? "blocked"
              : "failed",
          failure: error instanceof Error ? error.message : String(error),
          candidateSha: result.candidateSha,
          candidateFence: result.candidateFence,
          tokenUsage: null,
        });
        if (input.signal?.aborted) throw error;
        if (error instanceof DeliveryQuarantineError)
          return blockTask(runServices, result, error.message);
        throw error;
      }
      await recordHistory(runServices, {
        taskId: result.taskId,
        kind: "forge_delivery",
        activation: null,
        cycle: null,
        role: null,
        profile: null,
        observedModel: null,
        observedProvider: null,
        startedAtEpochMs,
        endedAtEpochMs: Date.now(),
        outcome: "succeeded",
        failure: null,
        candidateSha: result.candidateSha,
        candidateFence: result.candidateFence,
        tokenUsage: null,
      });
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("task execution cancelled");
}
