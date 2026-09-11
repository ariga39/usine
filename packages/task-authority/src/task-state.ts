import { createHash } from "node:crypto";
import type { TaskContract } from "./contract.js";
import type { RepositorySnapshot, TaskRepositorySnapshot } from "./repository.js";

export type TaskState =
  | "admitted"
  | "waiting"
  | "candidate"
  | "checked"
  | "reviewing"
  | "reviewed"
  | "reviewed_pr"
  | "merged"
  | "blocked";

export const PUBLIC_TASK_STATES = [
  "admitted",
  "waiting",
  "candidate",
  "checked",
  "reviewed",
  "reviewed_pr",
  "merged",
  "blocked",
] as const;
export type PublicTaskState = (typeof PUBLIC_TASK_STATES)[number];

export interface CheckResult {
  sha: string;
  status: "passed" | "failed";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReviewVerdict {
  sha: string;
  verdict: "approved" | "changes_requested" | "inconclusive";
  summary: string;
  findings: string[];
  /** Sanitized provider interruption evidence, when review did not complete. */
  failureClass?: TaskFailureClass;
}

export interface ReviewAttemptReservation {
  ownerId: string;
}

export interface DeliveryEffect {
  sha: string;
  effect: "github";
  prNumber: number;
  url: string;
  attestationId: string;
  merge?: MergeEffect | null;
}

export interface MergeEffect {
  prNumber: number;
  approvedHeadSha: string;
  mergeCommitSha: string;
  observedState: "merged";
}

export interface TaskResult {
  /** Version of the durable Task Authority result projection. */
  schemaVersion: 4;
  taskId: string;
  contractHash: string;
  /** Durable compare-and-set identity for this observation. */
  revision: number;
  /** The first admission deadline, reused for every recovery. */
  deadlineEpochMs?: number;
  state: TaskState;
  /** Immutable Campaign projection when the coordinator admitted this leaf. */
  campaign?: TaskCampaignAssociation;
  /** Immutable projection of Task Contract authorization.merge. */
  mergeAuthorized: boolean;
  candidateSha: string | null;
  candidateFence: number | null;
  check: CheckResult | null;
  review: ReviewVerdict | null;
  /** Authority-owned idempotency fact for the current changes-requested review. */
  repairBatchRecorded: boolean;
  /** Internal durable reviewer ownership; omitted from public Task projections. */
  reviewAttempt?: ReviewAttemptReservation | null;
  delivery: DeliveryEffect | null;
  /** Exact coordinator diagnostic; this never crosses into public projections. */
  blocker: string | null;
  /** Durable public-safe classification of the terminal blocker. */
  blockerClassification: TaskBlockerClassification | null;
  waiting: TaskWaiting | null;
  activeActivation: number | null;
  writer: { repositoryIdentity: string };
  /** Resolved repository facts frozen at admission for restart and audit. */
  repository?: TaskRepositorySnapshot;
  evidence: {
    implementerActivations: number;
    reviewCycles: number;
    changesRequestedBatches: number;
    restartRecoveries: number;
  };
}

export interface TaskCampaignAssociation {
  campaignId: string;
  goalId: string;
  goalVersion: number;
  outcomeId: string;
}

export type TaskWaitingReason =
  | "network_interruption"
  | "project_check_capability"
  | "delivery_reconciliation"
  | "external_review"
  | "pipeline_checks"
  | "review_interruption";
export const PUBLIC_TASK_WAITING_REASONS = [
  "network_interruption",
  "project_check_capability",
  "delivery_reconciliation",
  "external_review",
  "pipeline_checks",
] as const;
export type PublicTaskWaitingReason = (typeof PUBLIC_TASK_WAITING_REASONS)[number];
export type TaskWaitingResumeState =
  | "admitted"
  | "candidate"
  | "checked"
  | "reviewed"
  | "reviewing";
export interface TaskWaiting {
  reason: TaskWaitingReason;
  resumeState: TaskWaitingResumeState;
  activation: number;
  failureClass?: TaskFailureClass;
  /** Public-safe explanation for a mutable external constraint, when present. */
  diagnostic?: string;
}

export interface TaskRepositoryResource {
  id: string;
  owner: string;
  name: string;
  baseBranch: string;
}

export interface PublicCheckResult {
  sha: string;
  status: "passed" | "failed";
  exitCode: number;
}

/** Stable, bounded provider failure classes owned by Task Authority. */
export const TASK_FAILURE_CLASSES = [
  "transient_capacity",
  "transient_transport",
  "network",
  "timeout",
  "configuration",
  "authority",
  "protocol",
  "cancellation",
  "unknown",
] as const;
export type TaskFailureClass = (typeof TASK_FAILURE_CLASSES)[number];

export type TaskTerminalFailureClass = Exclude<TaskFailureClass, "cancellation">;
export const TASK_TERMINAL_FAILURE_CLASSES = TASK_FAILURE_CLASSES.filter(
  (failureClass): failureClass is TaskTerminalFailureClass => failureClass !== "cancellation",
);

export const TASK_BLOCKER_CLASSIFICATIONS = [
  "elapsed_budget",
  "implementation_budget",
  "invalid_phase",
  "missing_evidence",
  "provider_failure",
  ...TASK_TERMINAL_FAILURE_CLASSES,
  "project_check_failure",
  "review_inconclusive",
  "delivery_failure",
] as const;
export type TaskBlockerClassification = (typeof TASK_BLOCKER_CLASSIFICATIONS)[number];

/** Convert Coding Session's adapter-local vocabulary at the Task boundary. */
export function taskFailureClassFromProvider(value: string): TaskFailureClass {
  switch (value) {
    case "rate_limit":
      return "transient_capacity";
    case "transport":
      return "protocol";
    case "transient_transport":
    case "network":
    case "timeout":
    case "configuration":
    case "authority":
    case "cancellation":
    case "unknown":
    case "transient_capacity":
    case "protocol":
      return value;
    default:
      return "unknown";
  }
}

export interface PublicReviewVerdict {
  sha: string;
  verdict: ReviewVerdict["verdict"];
  classification: ReviewVerdict["verdict"];
  findingCount: number;
  failureClass?: TaskFailureClass;
}

export interface PublicBlockerDiagnostic {
  classification: TaskBlockerClassification;
}

export interface PublicTaskWaiting {
  reason: PublicTaskWaitingReason;
  diagnostic?: string;
}

export interface TaskResource {
  schemaVersion: 3;
  taskId: string;
  contractHash: string;
  revision: number;
  deadlineEpochMs?: number;
  state: PublicTaskState;
  campaign?: TaskCampaignAssociation;
  mergeAuthorized: boolean;
  candidateSha: string | null;
  candidateFence: number | null;
  check: PublicCheckResult | null;
  review: PublicReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: PublicBlockerDiagnostic | null;
  waiting: PublicTaskWaiting | null;
  retryable: boolean;
  activeActivation: number | null;
  writer: { repositoryIdentity: string };
  repository?: TaskRepositoryResource;
  evidence: TaskResult["evidence"];
}

export function publicTaskStateFromResult(
  result: Pick<TaskResult, "state" | "waiting">,
): PublicTaskState {
  return result.state === "reviewing" || result.waiting?.reason === "review_interruption"
    ? "checked"
    : result.state;
}

export function publicTaskWaitingFromResult(
  result: Pick<TaskResult, "waiting">,
): PublicTaskWaiting | null {
  return result.waiting && result.waiting.reason !== "review_interruption"
    ? {
        reason: result.waiting.reason,
        ...(result.waiting.diagnostic ? { diagnostic: result.waiting.diagnostic } : {}),
      }
    : null;
}

export function publicTaskRetryableFromResult(result: Pick<TaskResult, "waiting">): boolean {
  return (
    result.waiting?.reason === "network_interruption" ||
    result.waiting?.reason === "project_check_capability" ||
    result.waiting?.reason === "delivery_reconciliation" ||
    result.waiting?.reason === "external_review" ||
    result.waiting?.reason === "pipeline_checks"
  );
}

export function taskResourceFromResult(result: TaskResult): TaskResource {
  return {
    schemaVersion: 3,
    taskId: result.taskId,
    contractHash: result.contractHash,
    revision: result.revision,
    deadlineEpochMs: result.deadlineEpochMs,
    // `reviewing` is an internal reservation state. Public schema v3 keeps
    // exposing the existing checked projection while history carries the
    // distinct reviewer-run evidence.
    state: publicTaskStateFromResult(result),
    ...(result.campaign ? { campaign: { ...result.campaign } } : {}),
    mergeAuthorized: result.mergeAuthorized,
    candidateSha: result.candidateSha,
    candidateFence: result.candidateFence,
    check: result.check
      ? { sha: result.check.sha, status: result.check.status, exitCode: result.check.exitCode }
      : null,
    review: result.review
      ? {
          sha: result.review.sha,
          verdict: result.review.verdict,
          classification: result.review.verdict,
          findingCount: result.review.findings.length,
          ...(result.review.failureClass ? { failureClass: result.review.failureClass } : {}),
        }
      : null,
    delivery: result.delivery
      ? {
          sha: result.delivery.sha,
          effect: result.delivery.effect,
          prNumber: result.delivery.prNumber,
          url: result.delivery.url,
          attestationId: result.delivery.attestationId,
          merge: result.delivery.merge ? { ...result.delivery.merge } : null,
        }
      : null,
    blocker: result.blockerClassification ? { classification: result.blockerClassification } : null,
    waiting: publicTaskWaitingFromResult(result),
    retryable: publicTaskRetryableFromResult(result),
    activeActivation: result.activeActivation,
    writer: { ...result.writer },
    repository: result.repository
      ? {
          id: result.repository.id,
          owner: result.repository.owner,
          name: result.repository.name,
          baseBranch: result.repository.baseBranch,
        }
      : undefined,
    evidence: { ...result.evidence },
  };
}

export function classifyTaskBlocker(diagnostic: string): TaskBlockerClassification {
  const normalized = diagnostic.toLowerCase();
  if (normalized.includes("implementer activation") && normalized.includes("budget"))
    return "implementation_budget";
  return normalized.includes("elapsed") ||
    normalized.includes("deadline") ||
    normalized.includes("budget")
    ? "elapsed_budget"
    : normalized.includes("invalid phase")
      ? "invalid_phase"
      : normalized.includes("missing") && normalized.includes("evidence")
        ? "missing_evidence"
        : normalized.includes("provider") || normalized.includes("coding session")
          ? "provider_failure"
          : normalized.includes("project check") || normalized.includes("check failure")
            ? "project_check_failure"
            : normalized.includes("review") && normalized.includes("inconclusive")
              ? "review_inconclusive"
              : normalized.includes("delivery") ||
                  normalized.includes("forge") ||
                  normalized.includes("merge")
                ? "delivery_failure"
                : normalized.includes("phase") || normalized.includes("evidence")
                  ? "invalid_phase"
                  : "unknown";
}

export function isTerminalState(state: TaskState): boolean {
  return state === "reviewed_pr" || state === "merged" || state === "blocked";
}

export function isWaitingState(state: TaskState): boolean {
  return state === "waiting";
}

export function isPipelineChecksWaiting(result: Pick<TaskResult, "waiting">): boolean {
  return result.waiting?.reason === "pipeline_checks";
}

export interface CandidateFact {
  sha: string;
  baseSha: string;
  fence: number;
}

export interface TaskObservation {
  taskId: string;
  revision: number;
}

export type TaskFact =
  | { type: "candidate"; candidate: CandidateFact }
  | { type: "check"; check: CheckResult }
  | { type: "review"; review: ReviewVerdict; ownerId: string }
  | {
      type: "review_started";
      ownerId: string;
      takeover?: boolean;
    }
  | { type: "review_released"; ownerId: string }
  | {
      type: "review_interrupted";
      sha: string;
      failureClass: TaskFailureClass;
      ownerId: string;
    }
  | { type: "delivery"; delivery: DeliveryEffect }
  | { type: "repair_batch" }
  | { type: "waiting"; waiting: TaskWaiting }
  | { type: "retry" }
  | { type: "blocked"; blocker: string; classification?: TaskBlockerClassification };

export interface AuthorityInput {
  contract: TaskContract;
  contractHash: string;
  repositoryIdentity: string;
  repository?: RepositorySnapshot;
  deadlineEpochMs?: number;
}

/** Local input needed to re-enter an admitted task after a server restart. */
export interface TaskExecutionInput {
  contractPath: string | null;
  rawContract: string;
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  admitted: ["admitted", "candidate", "waiting", "blocked"],
  waiting: ["waiting", "reviewing", "blocked"],
  candidate: ["candidate", "checked", "waiting", "blocked"],
  checked: ["checked", "candidate", "reviewing", "reviewed", "waiting", "blocked"],
  reviewing: ["reviewing", "checked", "reviewed", "waiting", "blocked"],
  reviewed: ["reviewed", "candidate", "reviewed_pr", "merged", "waiting", "blocked"],
  merged: ["merged"],
  reviewed_pr: ["reviewed_pr"],
  blocked: ["blocked"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to);
}

function requireExactSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("candidate SHA is not exact");
}

/** Apply one authority-owned fact without persistence or database knowledge. */
export function applyTaskFact(result: TaskResult, fact: TaskFact): TaskResult {
  switch (fact.type) {
    case "candidate": {
      if (!canTransition(result.state, "candidate"))
        throw new Error(`illegal task state transition: ${result.state} -> candidate`);
      if (
        fact.candidate.fence <= 0 ||
        !Number.isSafeInteger(fact.candidate.fence) ||
        fact.candidate.fence !== result.activeActivation
      )
        throw new Error("candidate fence is stale");
      if (result.candidateSha && fact.candidate.baseSha !== result.candidateSha)
        throw new Error("candidate base is stale");
      requireExactSha(fact.candidate.sha);
      return {
        ...result,
        state: "candidate",
        candidateSha: fact.candidate.sha,
        candidateFence: fact.candidate.fence,
        check: null,
        review: null,
        repairBatchRecorded: false,
        delivery: null,
        blocker: null,
        blockerClassification: null,
        activeActivation: null,
      };
    }
    case "check": {
      if (!canTransition(result.state, "checked"))
        throw new Error(`illegal task state transition: ${result.state} -> checked`);
      if (!result.candidateSha || fact.check.sha !== result.candidateSha)
        throw new Error("check belongs to a stale candidate");
      requireExactSha(fact.check.sha);
      return {
        ...result,
        state: "checked",
        check: fact.check,
        review: null,
        repairBatchRecorded: false,
        delivery: null,
      };
    }
    case "review": {
      if (fact.review.failureClass !== undefined && fact.review.verdict !== "inconclusive")
        throw new Error("review failure class requires an inconclusive verdict");
      if (result.state !== "reviewing")
        throw new Error("review requires an owned reviewing reservation");
      if (!result.reviewAttempt || result.reviewAttempt.ownerId !== fact.ownerId)
        throw new Error("review attempt is not owned by this reviewer");
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        fact.review.sha !== result.candidateSha ||
        fact.review.sha !== result.check.sha
      )
        throw new Error("review belongs to a stale or unchecked candidate");
      requireExactSha(fact.review.sha);
      return {
        ...result,
        state: "reviewed",
        review: fact.review,
        repairBatchRecorded: false,
        reviewAttempt: null,
        delivery: null,
      };
    }
    case "review_started": {
      if (!canTransition(result.state, "reviewing"))
        throw new Error(`illegal task state transition: ${result.state} -> reviewing`);
      if (!fact.ownerId) throw new Error("review attempt reservation is invalid");
      const takeover = fact.takeover === true;
      if (takeover !== (result.state === "reviewing"))
        throw new Error("review attempt takeover is invalid");
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        result.check.sha !== result.candidateSha ||
        (result.state === "waiting" &&
          (result.waiting?.reason !== "review_interruption" ||
            result.waiting.activation !== result.candidateFence)) ||
        (!takeover && result.reviewAttempt != null)
      )
        throw new Error("review attempt belongs to a stale or unchecked candidate");
      return {
        ...result,
        state: "reviewing",
        waiting: null,
        review: null,
        repairBatchRecorded: false,
        reviewAttempt: { ownerId: fact.ownerId },
        delivery: null,
        blocker: null,
        blockerClassification: null,
        evidence: {
          ...result.evidence,
          reviewCycles: result.evidence.reviewCycles + 1,
        },
      };
    }
    case "review_released": {
      if (!canTransition(result.state, "checked"))
        throw new Error(`illegal task state transition: ${result.state} -> checked`);
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        result.check.sha !== result.candidateSha ||
        !result.reviewAttempt ||
        result.reviewAttempt.ownerId !== fact.ownerId
      )
        throw new Error("review release belongs to a stale or unchecked candidate");
      return {
        ...result,
        state: "checked",
        waiting: null,
        review: null,
        repairBatchRecorded: false,
        reviewAttempt: null,
        delivery: null,
        blocker: null,
        blockerClassification: null,
        evidence: {
          ...result.evidence,
          reviewCycles: Math.max(0, result.evidence.reviewCycles - 1),
        },
      };
    }
    case "review_interrupted": {
      if (result.state !== "reviewing")
        throw new Error(`illegal task state transition: ${result.state} -> waiting`);
      if (!result.reviewAttempt || result.reviewAttempt.ownerId !== fact.ownerId)
        throw new Error("review attempt is not owned by this reviewer");
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        fact.sha !== result.candidateSha ||
        fact.sha !== result.check.sha ||
        result.candidateFence === null
      )
        throw new Error("review interruption belongs to a stale or unchecked candidate");
      requireExactSha(fact.sha);
      return {
        ...result,
        state: "waiting",
        review: null,
        repairBatchRecorded: false,
        reviewAttempt: null,
        waiting: {
          reason: "review_interruption",
          resumeState: "reviewing",
          activation: result.candidateFence,
          failureClass: fact.failureClass,
        },
        activeActivation: null,
      };
    }
    case "delivery": {
      const mergeEffect = fact.delivery.merge;
      const merged = mergeEffect != null;
      const nextState = merged ? "merged" : "reviewed_pr";
      if (!canTransition(result.state, nextState))
        throw new Error(`illegal task state transition: ${result.state} -> ${nextState}`);
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        !result.review ||
        result.review.verdict !== "approved" ||
        fact.delivery.sha !== result.candidateSha ||
        fact.delivery.sha !== result.review.sha ||
        (result.mergeAuthorized && !merged) ||
        (merged && !result.mergeAuthorized) ||
        (merged && mergeEffect.approvedHeadSha !== fact.delivery.sha) ||
        (merged && mergeEffect.prNumber !== fact.delivery.prNumber)
      )
        throw new Error("delivery is not bound to an exact approved candidate");
      requireExactSha(fact.delivery.sha);
      if (merged) {
        requireExactSha(mergeEffect.approvedHeadSha);
        requireExactSha(mergeEffect.mergeCommitSha);
      }
      return {
        ...result,
        state: nextState,
        delivery: { ...fact.delivery, merge: fact.delivery.merge ?? null },
      };
    }
    case "repair_batch":
      if (result.state !== "reviewed" || result.review?.verdict !== "changes_requested")
        throw new Error("review repair batch is not current");
      if (result.repairBatchRecorded) return result;
      return {
        ...result,
        repairBatchRecorded: true,
        evidence: {
          ...result.evidence,
          changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
        },
      };
    case "waiting":
      if (!canTransition(result.state, "waiting"))
        throw new Error(`illegal task state transition: ${result.state} -> waiting`);
      const validActivation =
        fact.waiting.reason === "network_interruption"
          ? result.activeActivation === fact.waiting.activation && fact.waiting.activation > 0
          : fact.waiting.reason === "project_check_capability"
            ? result.state === "candidate" &&
              result.activeActivation === null &&
              result.candidateFence === fact.waiting.activation &&
              result.candidateSha !== null &&
              result.check === null &&
              fact.waiting.activation > 0
            : fact.waiting.reason === "delivery_reconciliation" ||
                fact.waiting.reason === "external_review" ||
                fact.waiting.reason === "pipeline_checks"
              ? result.state === "reviewed" &&
                result.activeActivation === null &&
                result.candidateFence === fact.waiting.activation &&
                result.candidateSha !== null &&
                result.check?.sha === result.candidateSha &&
                result.check.status === "passed" &&
                result.review?.sha === result.candidateSha &&
                result.review.verdict === "approved" &&
                fact.waiting.activation > 0
              : false;
      if (
        !validActivation ||
        !Number.isSafeInteger(fact.waiting.activation) ||
        fact.waiting.resumeState !== result.state
      )
        throw new Error("waiting activation is stale");
      return {
        ...result,
        state: "waiting",
        waiting: { ...fact.waiting },
        activeActivation: null,
      };
    case "retry":
      if (result.state !== "waiting" || !result.waiting)
        throw new Error("task is not waiting for an explicit retry");
      return {
        ...result,
        state: result.waiting.resumeState,
        waiting: null,
        activeActivation: null,
      };
    case "blocked":
      if (!canTransition(result.state, "blocked"))
        throw new Error(`illegal task state transition: ${result.state} -> blocked`);
      return {
        ...result,
        state: "blocked",
        blocker: fact.blocker,
        blockerClassification: fact.classification ?? classifyTaskBlocker(fact.blocker),
        waiting: null,
        activeActivation: null,
        reviewAttempt: null,
      };
  }
  throw new Error("unknown task fact");
}

export function hashTaskContract(rawContract: string): string {
  return createHash("sha256").update(rawContract).digest("hex");
}
