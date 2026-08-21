import { createHash } from "node:crypto";
import type { TaskContract } from "./contract.js";
import type { RepositorySnapshot, TaskRepositorySnapshot } from "./repository.js";

export type TaskState =
  | "admitted"
  | "candidate"
  | "checked"
  | "reviewed"
  | "reviewed_pr"
  | "merged"
  | "blocked";

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
  schemaVersion: 2;
  taskId: string;
  contractHash: string;
  /** Durable compare-and-set identity for this observation. */
  revision: number;
  /** The first admission deadline, reused for every recovery. */
  deadlineEpochMs: number;
  state: TaskState;
  /** Immutable projection of Task Contract authorization.merge. */
  mergeAuthorized: boolean;
  candidateSha: string | null;
  candidateFence: number | null;
  check: CheckResult | null;
  review: ReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: string | null;
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

export type TaskBlockerClassification =
  | "elapsed_budget"
  | "invalid_phase"
  | "missing_evidence"
  | "provider_failure"
  | "project_check_failure"
  | "review_inconclusive"
  | "delivery_failure"
  | "unknown";

export interface PublicReviewVerdict {
  sha: string;
  verdict: ReviewVerdict["verdict"];
  classification: ReviewVerdict["verdict"];
  findingCount: number;
}

export interface PublicBlockerDiagnostic {
  classification: TaskBlockerClassification;
}

export interface TaskResource {
  schemaVersion: 2;
  taskId: string;
  contractHash: string;
  revision: number;
  deadlineEpochMs: number;
  state: TaskState;
  mergeAuthorized: boolean;
  candidateSha: string | null;
  candidateFence: number | null;
  check: PublicCheckResult | null;
  review: PublicReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: PublicBlockerDiagnostic | null;
  activeActivation: number | null;
  writer: { repositoryIdentity: string };
  repository?: TaskRepositoryResource;
  evidence: TaskResult["evidence"];
}

export function taskResourceFromResult(result: TaskResult): TaskResource {
  return {
    schemaVersion: 2,
    taskId: result.taskId,
    contractHash: result.contractHash,
    revision: result.revision,
    deadlineEpochMs: result.deadlineEpochMs,
    state: result.state,
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
    blocker: result.blocker ? publicBlockerFromText(result.blocker) : null,
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

export function publicBlockerFromText(blocker: string): PublicBlockerDiagnostic {
  const normalized = blocker.toLowerCase();
  const classification: TaskBlockerClassification =
    normalized.includes("elapsed") ||
    normalized.includes("deadline") ||
    normalized.includes("budget")
      ? "elapsed_budget"
      : normalized.includes("invalid phase")
        ? "invalid_phase"
        : normalized.includes("missing") && normalized.includes("evidence")
          ? "missing_evidence"
          : normalized.includes("provider")
            ? "provider_failure"
            : normalized.includes("project check") || normalized.includes("check failure")
              ? "project_check_failure"
              : normalized.includes("review") && normalized.includes("inconclusive")
                ? "review_inconclusive"
                : normalized.includes("delivery") || normalized.includes("merge")
                  ? "delivery_failure"
                  : "unknown";
  return { classification };
}

export function isTerminalState(state: TaskState): boolean {
  return state === "reviewed_pr" || state === "merged" || state === "blocked";
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
  | { type: "review"; review: ReviewVerdict }
  | { type: "delivery"; delivery: DeliveryEffect }
  | { type: "repair_batch" }
  | { type: "blocked"; blocker: string };

export interface AuthorityInput {
  contract: TaskContract;
  contractHash: string;
  repositoryIdentity: string;
  repository?: RepositorySnapshot;
  deadlineEpochMs: number;
}

/** Local input needed to re-enter an admitted task after a server restart. */
export interface TaskExecutionInput {
  contractPath: string;
  rawContract: string;
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  admitted: ["admitted", "candidate", "blocked"],
  candidate: ["candidate", "checked", "blocked"],
  checked: ["checked", "candidate", "reviewed", "blocked"],
  reviewed: ["reviewed", "candidate", "reviewed_pr", "merged", "blocked"],
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
        delivery: null,
        blocker: null,
        activeActivation: null,
      };
    }
    case "check": {
      if (!canTransition(result.state, "checked"))
        throw new Error(`illegal task state transition: ${result.state} -> checked`);
      if (!result.candidateSha || fact.check.sha !== result.candidateSha)
        throw new Error("check belongs to a stale candidate");
      requireExactSha(fact.check.sha);
      return { ...result, state: "checked", check: fact.check, review: null, delivery: null };
    }
    case "review": {
      if (!canTransition(result.state, "reviewed"))
        throw new Error(`illegal task state transition: ${result.state} -> reviewed`);
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
        delivery: null,
        evidence: { ...result.evidence, reviewCycles: result.evidence.reviewCycles + 1 },
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
      return {
        ...result,
        evidence: {
          ...result.evidence,
          changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
        },
      };
    case "blocked":
      if (!canTransition(result.state, "blocked"))
        throw new Error(`illegal task state transition: ${result.state} -> blocked`);
      return { ...result, state: "blocked", blocker: fact.blocker };
  }
  throw new Error("unknown task fact");
}

export function hashTaskContract(rawContract: string): string {
  return createHash("sha256").update(rawContract).digest("hex");
}
