import { createHash } from "node:crypto";
import type { TaskContract } from "./contract.js";

export type TaskState =
  | "admitted"
  | "candidate"
  | "checked"
  | "reviewed"
  | "reviewed_pr"
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
}

export interface TaskResult {
  /** Version of the durable Task Authority result projection. */
  schemaVersion: 1;
  taskId: string;
  contractHash: string;
  /** Durable compare-and-set identity for this observation. */
  revision: number;
  /** The first admission deadline, reused for every recovery. */
  deadlineEpochMs: number;
  state: TaskState;
  candidateSha: string | null;
  candidateFence: number | null;
  check: CheckResult | null;
  review: ReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: string | null;
  activeActivation: number | null;
  writer: { repositoryIdentity: string };
  evidence: {
    implementerActivations: number;
    reviewCycles: number;
    changesRequestedBatches: number;
    restartRecoveries: number;
  };
}

export interface TaskProgress {
  event: "progress";
  taskId: string;
  revision: number;
  state: TaskState;
  activeActivation: number | null;
  candidateSha: string | null;
}

export function taskProgressFromResult(result: TaskResult): TaskProgress {
  return {
    event: "progress",
    taskId: result.taskId,
    revision: result.revision,
    state: result.state,
    activeActivation: result.activeActivation,
    candidateSha: result.candidateSha,
  };
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
  deadlineEpochMs: number;
}

/** Local input needed to re-enter an admitted task after a server restart. */
export interface TaskExecutionInput {
  contractPath: string;
  repositoryPath: string;
  rawContract: string;
}

export type TaskHistoryKind =
  | "implementer"
  | "project_check"
  | "fresh_review"
  | "forge_delivery"
  | "coordinator_restart"
  | "execution_owner_change";

export type TaskHistoryOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked"
  | "observed";

export interface TaskHistoryTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TaskHistoryRecordInput {
  taskId: string;
  kind: TaskHistoryKind;
  activation: number | null;
  cycle: number | null;
  role: string | null;
  model: string | null;
  startedAtEpochMs: number;
  endedAtEpochMs: number | null;
  outcome: TaskHistoryOutcome;
  failure: string | null;
  candidateSha: string | null;
  candidateFence: number | null;
  tokenUsage: TaskHistoryTokenUsage | null;
}

export interface TaskHistoryRecord extends TaskHistoryRecordInput {
  id: number;
}

export interface TaskStatus extends TaskResult {
  history: TaskHistoryRecord[];
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  admitted: ["admitted", "candidate", "blocked"],
  candidate: ["candidate", "checked", "blocked"],
  checked: ["checked", "candidate", "reviewed", "blocked"],
  reviewed: ["reviewed", "candidate", "reviewed_pr", "blocked"],
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
      if (!canTransition(result.state, "reviewed_pr"))
        throw new Error(`illegal task state transition: ${result.state} -> reviewed_pr`);
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        !result.review ||
        result.review.verdict !== "approved" ||
        fact.delivery.sha !== result.candidateSha ||
        fact.delivery.sha !== result.review.sha
      )
        throw new Error("delivery is not bound to an exact approved candidate");
      requireExactSha(fact.delivery.sha);
      return { ...result, state: "reviewed_pr", delivery: fact.delivery };
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
