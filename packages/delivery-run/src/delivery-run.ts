import { randomUUID } from "node:crypto";
import type { FrozenCandidate, WriterWorkspace } from "@usine/candidate-workspace";
import type {
  CodingSessionObservation,
  ImplementerOutput,
  RolePolicy,
  SessionArchiveCaptureStatus,
  SessionObservation,
  SessionRequest,
  RoleOutputNormalizerObservation,
} from "@usine/coding-session";
import type { ReviewAttemptObservation } from "@usine/quality-gate";
import {
  DeliveryQuarantineError,
  ExternalReviewPendingError,
  ForgeAuthenticationError,
  ForgeDeliveryReconciliationError,
} from "@usine/forge-delivery";
import {
  deadlineExpired,
  isTerminalState,
  isWaitingState,
  type AuthorityInput,
  type CandidateFact,
  type CheckResult,
  type DeliveryEffect,
  type ReviewVerdict,
  type ResolvedTaskContract,
  type TaskBlockerClassification,
  type TaskFailureClass,
  type TaskObservation,
  type TaskResult,
  type TaskObservationEventInput,
  type TaskWaiting,
} from "@usine/task-authority";
import { activateImplementer } from "./coding-activation.js";
import {
  blockTask,
  emitCodingInterruption,
  emitCodingObservation,
  emitObservation,
} from "./delivery-progress.js";

export interface DeliveryRunInput {
  contract: ResolvedTaskContract;
  contractHash: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
  implementer: RolePolicy;
  reviewer?: RolePolicy;
  signal?: AbortSignal;
  executionOwnerId?: string;
}

interface DeliveryRunAuthority {
  admit(input: AuthorityInput): Promise<TaskResult>;
  reserveActivation(
    taskId: string,
    budget: number,
  ): Promise<{ result: TaskResult; activation: number }>;
  recordCandidate(observation: TaskObservation, candidate: CandidateFact): Promise<TaskResult>;
  recordCheck(observation: TaskObservation, check: CheckResult): Promise<TaskResult>;
  recordReview(
    observation: TaskObservation,
    review: ReviewVerdict,
    ownerId: string,
  ): Promise<TaskResult>;
  recordReviewInterruption(
    observation: TaskObservation,
    sha: string,
    failureClass: TaskFailureClass,
    ownerId: string,
  ): Promise<TaskResult>;
  releaseReviewAttempt(observation: TaskObservation, ownerId: string): Promise<TaskResult>;
  reserveReviewAttempt(
    taskId: string,
    budget: number,
    ownerId: string,
  ): Promise<{ result: TaskResult; claimed: boolean; cycle: number | null }>;
  takeOverReviewAttempt(
    taskId: string,
    budget: number,
    ownerId: string,
  ): Promise<{
    result: TaskResult;
    claimed: boolean;
    cycle: number | null;
    status: "claimed" | "budget_exhausted";
  }>;
  recordRepairBatch(observation: TaskObservation): Promise<TaskResult>;
  recordWaiting(observation: TaskObservation, waiting: TaskWaiting): Promise<TaskResult>;
  recordDelivery(observation: TaskObservation, delivery: DeliveryEffect): Promise<TaskResult>;
  block(
    observation: TaskObservation,
    blocker: string,
    classification?: TaskBlockerClassification,
  ): Promise<TaskResult>;
  appendObservation(taskId: string, input: TaskObservationEventInput): Promise<unknown>;
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
        phase?: SessionObservation<ImplementerOutput>["phase"];
        failureClass?: SessionObservation<ImplementerOutput>["failureClass"];
        usage?: SessionObservation<ImplementerOutput>["usage"];
        archiveId?: string;
        archiveStatus?: SessionArchiveCaptureStatus;
        archiveCompleteness?: "complete" | "partial";
        requestedProfile?: string;
        effectiveProfile?: SessionObservation<ImplementerOutput>["effectiveProfile"];
        normalizer?: RoleOutputNormalizerObservation;
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
    onObservation?: (observation: CodingSessionObservation) => Promise<void> | void,
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
}

export async function executeDeliveryRun(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
): Promise<TaskResult> {
  throwIfAborted(input.signal);
  const executionOwnerId = input.executionOwnerId ?? randomUUID();
  let result = await services.authority.admit({
    contract: input.contract,
    contractHash: input.contractHash,
    repositoryIdentity: input.repositoryIdentity,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  throwIfAborted(input.signal);
  if (isTerminalState(result.state)) return result;
  if (deadlineExpired(result.deadlineEpochMs))
    return blockTask(services, result, "elapsed budget exhausted");
  // This is intentionally a reducer over the durable result.  A restart must
  // resume the phase represented by SQLite, never infer progress from a
  // worker process or start from the contract base again.
  let claimedReviewCycle: number | null = null;
  for (;;) {
    if (isTerminalState(result.state)) return result;
    if (deadlineExpired(result.deadlineEpochMs))
      return blockTask(services, result, "elapsed budget exhausted");

    if (isWaitingState(result.state)) {
      if (result.waiting?.reason !== "review_interruption") return result;
      const failureClass = result.waiting.failureClass;
      if (!failureClass || !isTransientReviewerFailure(failureClass))
        return blockTask(
          services,
          result,
          "review interruption is not retryable",
          reviewBlockerClassification(failureClass),
        );
      if (result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles)
        return blockTask(services, result, "review budget exhausted", "elapsed_budget");
      const recovery = await services.authority.reserveReviewAttempt(
        result.taskId,
        input.contract.budget.maxReviewCycles,
        executionOwnerId,
      );
      if (!recovery.claimed) return recovery.result;
      result = recovery.result;
      claimedReviewCycle = recovery.cycle;
      continue;
    }

    if (result.state === "admitted") {
      result = await activateImplementer(input, services, result, input.contract.baseSha, null, []);
      continue;
    }

    if (result.state === "candidate") {
      if (!result.candidateSha)
        return blockTask(services, result, "candidate phase has no exact SHA");
      await services.workspace.quarantinePriorWriters(input.contract.id, Number.MAX_SAFE_INTEGER);
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let check: CheckResult;
      try {
        check = await services.quality.check(input.contract, result.candidateSha, cycle);
        throwIfAborted(input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return blockTask(services, result, error instanceof Error ? error.message : String(error));
      }
      result = await services.authority.recordCheck(
        { taskId: result.taskId, revision: result.revision },
        check,
      );
      continue;
    }

    if (result.state === "checked") {
      if (!result.check || !result.candidateSha)
        return blockTask(services, result, "checked phase is incomplete");
      if (!result.candidateFence)
        return blockTask(services, result, "checked phase has no coding activation fence");
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
      if (result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles)
        return blockTask(services, result, "review budget exhausted", "elapsed_budget");
      const reservation = await services.authority.reserveReviewAttempt(
        result.taskId,
        input.contract.budget.maxReviewCycles,
        executionOwnerId,
      );
      if (!reservation.claimed) return reservation.result;
      result = reservation.result;
      claimedReviewCycle = reservation.cycle;
      continue;
    }

    if (result.state === "reviewing") {
      if (claimedReviewCycle === null) {
        const takeover = await services.authority.takeOverReviewAttempt(
          result.taskId,
          input.contract.budget.maxReviewCycles,
          executionOwnerId,
        );
        if (!takeover.claimed) {
          if (takeover.status === "budget_exhausted")
            return blockTask(
              services,
              takeover.result,
              "review budget exhausted",
              "elapsed_budget",
            );
          return takeover.result;
        }
        result = takeover.result;
        claimedReviewCycle = takeover.cycle;
      }
      const cycle = claimedReviewCycle;
      if (cycle === null) return result;
      claimedReviewCycle = null;
      if (!result.check || !result.candidateSha)
        return blockTask(services, result, "reviewing phase is incomplete");
      let review: ReviewVerdict | undefined;
      let reviewInterruption: ReviewAttemptObservation["interruption"];
      let reviewArchive: ReviewAttemptObservation["archive"];
      let reviewRequestedProfile: string | undefined;
      let reviewEffectiveProfile: ReviewAttemptObservation["effectiveProfile"];
      let reviewUsage: ReviewAttemptObservation["usage"] = null;
      let reviewNormalizer: ReviewAttemptObservation["normalizer"];
      const reviewObservationCounter = { value: 0 };
      const reviewInvocationId = randomUUID();
      const reviewSessionId = `review-session:${cycle}:${reviewInvocationId}`;
      const reviewEventPrefix = `review:${cycle}:${reviewInvocationId}`;
      const reviewActivation = 0;
      await emitObservation(services, result.taskId, {
        eventId: `${reviewEventPrefix}:session-started`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "coding_session_started",
          role: input.reviewer?.role ?? "reviewer",
          activation: reviewActivation,
          reviewCycle: cycle,
          sessionId: reviewSessionId,
          requestedProfile: input.reviewer?.profile,
        },
      });
      try {
        const observation = await services.quality.reviewWithObservation(
          input.contract,
          result.candidateSha,
          result.check,
          cycle,
          (sessionObservation) =>
            emitCodingObservation(
              services,
              result.taskId,
              input.reviewer?.role ?? "reviewer",
              reviewActivation,
              reviewSessionId,
              reviewEventPrefix,
              reviewObservationCounter,
              sessionObservation,
              cycle,
            ),
        );
        reviewArchive = observation.archive;
        reviewRequestedProfile = observation.requestedProfile;
        reviewEffectiveProfile = observation.effectiveProfile;
        reviewUsage = observation.usage;
        reviewNormalizer = observation.normalizer;
        if (observation.interruption)
          await emitCodingInterruption(
            services,
            result.taskId,
            input.reviewer?.role ?? "reviewer",
            reviewActivation,
            reviewSessionId,
            reviewEventPrefix,
            reviewObservationCounter,
            observation.interruption,
          );
        review = observation.review ?? undefined;
        reviewInterruption = observation.interruption;
        throwIfAborted(input.signal);
      } catch (error) {
        await emitObservation(services, result.taskId, {
          eventId: `${reviewEventPrefix}:session-completed`,
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_completed",
            role: input.reviewer?.role ?? "reviewer",
            activation: reviewActivation,
            reviewCycle: cycle,
            outcome: input.signal?.aborted ? "cancelled" : "failed",
            sessionId: reviewSessionId,
            requestedProfile: input.reviewer?.profile,
            usage: reviewUsage,
            ...(reviewNormalizer ? { normalizer: reviewNormalizer } : {}),
          },
        });
        if (input.signal?.aborted) {
          await services.authority.releaseReviewAttempt(
            { taskId: result.taskId, revision: result.revision },
            executionOwnerId,
          );
          throw error;
        }
        return blockTask(services, result, error instanceof Error ? error.message : String(error));
      }
      await emitObservation(services, result.taskId, {
        eventId: `${reviewEventPrefix}:session-completed`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "coding_session_completed",
          role: input.reviewer?.role ?? "reviewer",
          activation: reviewActivation,
          reviewCycle: cycle,
          outcome:
            reviewInterruption || !review
              ? "failed"
              : review.verdict === "inconclusive"
                ? "failed"
                : "succeeded",
          sessionId: reviewSessionId,
          requestedProfile: reviewRequestedProfile ?? input.reviewer?.profile,
          ...(reviewEffectiveProfile ? { effectiveProfile: reviewEffectiveProfile } : {}),
          usage: reviewUsage,
          ...(reviewNormalizer ? { normalizer: reviewNormalizer } : {}),
          ...(reviewArchive ? { archive: reviewArchive } : {}),
        },
      });
      if (reviewInterruption) {
        result = await services.authority.recordReviewInterruption(
          { taskId: result.taskId, revision: result.revision },
          result.candidateSha,
          reviewInterruption.failureClass,
          executionOwnerId,
        );
      } else if (review) {
        result = await services.authority.recordReview(
          { taskId: result.taskId, revision: result.revision },
          review,
          executionOwnerId,
        );
      } else {
        return blockTask(services, result, "review produced no verdict");
      }
      continue;
    }

    if (result.state === "reviewed") {
      if (!result.review || !result.check || !result.candidateSha)
        return blockTask(services, result, "reviewed phase is incomplete");
      if (result.review.verdict === "changes_requested") {
        const implementationBudgetExhausted =
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations;
        const reviewBudgetExhausted =
          result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles;
        if (implementationBudgetExhausted || reviewBudgetExhausted)
          return blockTask(
            services,
            result,
            "review changes requested after recovery budget was exhausted",
            implementationBudgetExhausted ? "implementation_budget" : "elapsed_budget",
          );
        // This marker is durable, so a restart cannot count the same finding
        // batch twice before activating its repair writer.
        const candidateSha = result.candidateSha;
        const findings = result.review.findings;
        result = await services.authority.recordRepairBatch({
          taskId: result.taskId,
          revision: result.revision,
        });
        result = await activateImplementer(input, services, result, candidateSha, null, findings);
        continue;
      }
      if (result.review.verdict === "inconclusive") {
        if (result.review.failureClass === "cancellation") return result;
        return blockTask(
          services,
          result,
          `review inconclusive: ${result.review.summary}`,
          result.review.failureClass ?? "review_inconclusive",
        );
      }
      // ForgeDelivery probes before every effect. Its typed unresolved outcome
      // keeps the approved review durable for explicit retry of this exact
      // bundle without another implementer or reviewer.
      let delivery: Awaited<ReturnType<DeliveryRunForge["deliver"]>>;
      try {
        delivery = await services.forge.deliver(
          input.contract,
          result.candidateSha,
          result.check,
          result.review,
        );
        throwIfAborted(input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (error instanceof DeliveryQuarantineError || error instanceof ForgeAuthenticationError)
          return blockTask(services, result, error.message);
        if (error instanceof ExternalReviewPendingError && result.candidateFence !== null)
          return services.authority.recordWaiting(
            { taskId: result.taskId, revision: result.revision },
            {
              reason: "external_review",
              resumeState: "reviewed",
              activation: result.candidateFence,
              diagnostic: error.diagnostic,
            },
          );
        if (error instanceof ForgeDeliveryReconciliationError && result.candidateFence !== null)
          return services.authority.recordWaiting(
            { taskId: result.taskId, revision: result.revision },
            {
              reason: "delivery_reconciliation",
              resumeState: "reviewed",
              activation: result.candidateFence,
            },
          );
        return blockTask(services, result, error instanceof Error ? error.message : String(error));
      }
      const delivered = await services.authority.recordDelivery(
        { taskId: result.taskId, revision: result.revision },
        delivery,
      );
      return delivered;
    }

    return blockTask(services, result, "unknown durable task phase");
  }
}

function isTransientReviewerFailure(
  failureClass: TaskFailureClass,
): failureClass is "transient_capacity" | "transient_transport" | "network" | "timeout" {
  return (
    failureClass === "transient_capacity" ||
    failureClass === "transient_transport" ||
    failureClass === "network" ||
    failureClass === "timeout"
  );
}

function reviewBlockerClassification(
  failureClass: TaskFailureClass | undefined,
): TaskBlockerClassification {
  return failureClass === "cancellation" || failureClass === undefined
    ? "review_inconclusive"
    : failureClass;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("task execution cancelled");
}
