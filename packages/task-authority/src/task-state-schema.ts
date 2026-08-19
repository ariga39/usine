import { Schema } from "effect";
import type { TaskResult } from "./task-state.js";

export const TASK_RESULT_SCHEMA_VERSION = 1 as const;
export const TASK_STATE_QUARANTINE_DIAGNOSTIC = "durable task state quarantined";

export class TaskStateQuarantinedError extends Error {
  readonly code = "task_state_quarantined";

  constructor() {
    super(TASK_STATE_QUARANTINE_DIAGNOSTIC);
    this.name = "TaskStateQuarantinedError";
  }
}

const exactSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const taskState = Schema.Literals([
  "admitted",
  "candidate",
  "checked",
  "reviewed",
  "reviewed_pr",
  "blocked",
]);
const checkResult = Schema.Struct({
  sha: exactSha,
  status: Schema.Literals(["passed", "failed"]),
  command: Schema.String,
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
const reviewVerdict = Schema.Struct({
  sha: exactSha,
  verdict: Schema.Literals(["approved", "changes_requested", "inconclusive"]),
  summary: Schema.String,
  findings: Schema.Array(Schema.String),
});
const deliveryEffect = Schema.Struct({
  sha: exactSha,
  effect: Schema.Literal("github"),
  prNumber: Schema.Natural,
  url: Schema.String,
  attestationId: Schema.String,
});
const taskResultFields = {
  taskId: Schema.String,
  contractHash: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: taskState,
  candidateSha: Schema.NullOr(exactSha),
  candidateFence: Schema.NullOr(Schema.Natural),
  check: Schema.NullOr(checkResult),
  review: Schema.NullOr(reviewVerdict),
  delivery: Schema.NullOr(deliveryEffect),
  blocker: Schema.NullOr(Schema.String),
  activeActivation: Schema.NullOr(Schema.Natural),
  writer: Schema.Struct({ repositoryIdentity: Schema.String }),
  evidence: Schema.Struct({
    implementerActivations: Schema.Natural,
    reviewCycles: Schema.Natural,
    changesRequestedBatches: Schema.Natural,
    restartRecoveries: Schema.Natural,
  }),
} as const;

const currentTaskResult = Schema.Struct({
  schemaVersion: Schema.Literal(TASK_RESULT_SCHEMA_VERSION),
  ...taskResultFields,
});

/** The unversioned result written by the current main branch. */
const priorTaskResult = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Undefined),
  ...taskResultFields,
});

const persistedTaskResult = Schema.Union([currentTaskResult, priorTaskResult]);
type DecodedPersistedTaskResult = Schema.Schema.Type<typeof persistedTaskResult>;

function projectDecodedResult(decoded: DecodedPersistedTaskResult): TaskResult {
  return {
    schemaVersion: TASK_RESULT_SCHEMA_VERSION,
    taskId: decoded.taskId,
    contractHash: decoded.contractHash,
    revision: decoded.revision,
    deadlineEpochMs: decoded.deadlineEpochMs,
    state: decoded.state,
    candidateSha: decoded.candidateSha,
    candidateFence: decoded.candidateFence,
    check: decoded.check,
    review: decoded.review
      ? {
          sha: decoded.review.sha,
          verdict: decoded.review.verdict,
          summary: decoded.review.summary,
          findings: [...decoded.review.findings],
        }
      : null,
    delivery: decoded.delivery,
    blocker: decoded.blocker,
    activeActivation: decoded.activeActivation,
    writer: { repositoryIdentity: decoded.writer.repositoryIdentity },
    evidence: {
      implementerActivations: decoded.evidence.implementerActivations,
      reviewCycles: decoded.evidence.reviewCycles,
      changesRequestedBatches: decoded.evidence.changesRequestedBatches,
      restartRecoveries: decoded.evidence.restartRecoveries,
    },
  };
}

export function decodePersistedTaskResult(input: unknown): TaskResult {
  try {
    return projectDecodedResult(Schema.decodeUnknownSync(persistedTaskResult)(input));
  } catch {
    throw new TaskStateQuarantinedError();
  }
}

export function decodeCurrentTaskResult(input: unknown): TaskResult {
  return projectDecodedResult(Schema.decodeUnknownSync(currentTaskResult)(input));
}
