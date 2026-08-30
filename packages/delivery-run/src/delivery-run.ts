import type { FrozenCandidate, WriterWorkspace } from "@usine/candidate-workspace";
import type {
  CodingSessionObservation,
  ImplementerOutput,
  RolePolicy,
  SessionArchiveCaptureStatus,
  SessionObservation,
  SessionRequest,
} from "@usine/coding-session";
import type { ReviewAttemptObservation } from "@usine/quality-gate";
import { DeliveryQuarantineError, ForgeAuthenticationError } from "@usine/forge-delivery";
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
  type TaskObservation,
  type TaskResult,
  type TaskObservationEventInput,
  type TaskWaiting,
} from "@usine/task-authority";
import { activateImplementer } from "./coding-activation.js";
import {
  blockTask,
  effectiveProfileObservation,
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
  recordWaiting(observation: TaskObservation, waiting: TaskWaiting): Promise<TaskResult>;
  recordDelivery(observation: TaskObservation, delivery: DeliveryEffect): Promise<TaskResult>;
  block(observation: TaskObservation, blocker: string): Promise<TaskResult>;
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
        usage?: { inputTokens?: number; outputTokens?: number } | null;
        archiveId?: string;
        archiveStatus?: SessionArchiveCaptureStatus;
        requestedProfile?: string;
        effectiveProfile?: SessionObservation<ImplementerOutput>["effectiveProfile"];
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
  for (;;) {
    if (isTerminalState(result.state)) return result;
    if (deadlineExpired(result.deadlineEpochMs))
      return blockTask(services, result, "elapsed budget exhausted");

    if (isWaitingState(result.state)) return result;

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
      const cycle = Math.min(
        input.contract.budget.maxReviewCycles,
        Math.max(1, result.evidence.reviewCycles + 1),
      );
      let review: ReviewVerdict;
      let reviewArchive: ReviewAttemptObservation["archive"];
      let reviewRequestedProfile: string | undefined;
      let reviewEffectiveProfile = effectiveProfileObservation(undefined);
      let reviewUsage: ReviewAttemptObservation["usage"] = null;
      const reviewObservationCounter = { value: 0 };
      const reviewSessionId = `review-session:${cycle}:${input.reviewer?.role ?? "reviewer"}`;
      await emitObservation(services, result.taskId, {
        eventId: `review:${cycle}:session-started`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "coding_session_started",
          role: input.reviewer?.role ?? "reviewer",
          activation: result.candidateFence,
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
              result.candidateFence!,
              reviewSessionId,
              `review:${cycle}`,
              reviewObservationCounter,
              sessionObservation,
            ),
        );
        reviewArchive = observation.archive;
        reviewRequestedProfile = observation.requestedProfile;
        reviewEffectiveProfile = effectiveProfileObservation(observation.effectiveProfile);
        reviewUsage = observation.usage;
        if (observation.interruption)
          await emitCodingInterruption(
            services,
            result.taskId,
            input.reviewer?.role ?? "reviewer",
            result.candidateFence,
            reviewSessionId,
            `review:${cycle}`,
            reviewObservationCounter,
            observation.interruption,
          );
        review = observation.review;
        throwIfAborted(input.signal);
      } catch (error) {
        await emitObservation(services, result.taskId, {
          eventId: `review:${cycle}:session-completed`,
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_completed",
            role: input.reviewer?.role ?? "reviewer",
            activation: result.candidateFence,
            outcome: input.signal?.aborted ? "cancelled" : "failed",
            sessionId: reviewSessionId,
            requestedProfile: input.reviewer?.profile,
            effectiveProfile: effectiveProfileObservation(undefined),
            usage: null,
          },
        });
        if (input.signal?.aborted) throw error;
        return blockTask(services, result, error instanceof Error ? error.message : String(error));
      }
      await emitObservation(services, result.taskId, {
        eventId: `review:${cycle}:session-completed`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "coding_session_completed",
          role: input.reviewer?.role ?? "reviewer",
          activation: result.candidateFence,
          outcome: review.verdict === "inconclusive" ? "failed" : "succeeded",
          sessionId: reviewSessionId,
          requestedProfile: reviewRequestedProfile ?? input.reviewer?.profile,
          effectiveProfile: reviewEffectiveProfile,
          usage: reviewUsage,
          ...(reviewArchive ? { archive: reviewArchive } : {}),
        },
      });
      result = await services.authority.recordReview(
        { taskId: result.taskId, revision: result.revision },
        review,
      );
      continue;
    }

    if (result.state === "reviewed") {
      if (!result.review || !result.check || !result.candidateSha)
        return blockTask(services, result, "reviewed phase is incomplete");
      if (result.review.verdict === "changes_requested") {
        if (
          result.evidence.changesRequestedBatches > result.evidence.reviewCycles ||
          result.evidence.reviewCycles >= input.contract.budget.maxReviewCycles ||
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
        )
          return blockTask(
            services,
            result,
            "review changes requested after recovery budget was exhausted",
          );
        // This marker is durable, so a restart cannot count the same finding
        // batch twice before activating its repair writer.
        const candidateSha = result.candidateSha;
        const findings = result.review.findings;
        if (result.evidence.changesRequestedBatches < result.evidence.reviewCycles) {
          result = await services.authority.recordRepairBatch({
            taskId: result.taskId,
            revision: result.revision,
          });
        }
        result = await activateImplementer(input, services, result, candidateSha, null, findings);
        continue;
      }
      if (result.review.verdict === "inconclusive")
        return blockTask(services, result, `review inconclusive: ${result.review.summary}`);
      // ForgeDelivery probes before every effect, so a restart after an
      // uncertain PR/comment write reconciles the same approved bundle.  Keep
      // the approved review durable if delivery throws; the next run retries
      // this exact bundle without another implementer.
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
        throw error;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("task execution cancelled");
}
