import { Schema } from "effect";
import type { TaskHistoryRecord, TaskResult, TaskStatus } from "./task-state.js";

export const TASK_RESULT_SCHEMA_VERSION = 1 as const;
export const TASK_STATE_QUARANTINE_DIAGNOSTIC = "durable task state quarantined";

export class TaskStateQuarantinedError extends Error {
  readonly code = "task_state_quarantined";

  constructor() {
    super(TASK_STATE_QUARANTINE_DIAGNOSTIC);
    this.name = "TaskStateQuarantinedError";
  }
}

export function isTaskStateQuarantinedError(error: unknown): error is TaskStateQuarantinedError {
  return (
    error instanceof Error &&
    error.name === "TaskStateQuarantinedError" &&
    "code" in error &&
    error.code === "task_state_quarantined"
  );
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
const historyRecord = Schema.Struct({
  id: Schema.Natural,
  taskId: Schema.String,
  kind: Schema.Literals([
    "implementer",
    "project_check",
    "fresh_review",
    "forge_delivery",
    "coordinator_restart",
    "execution_owner_change",
  ]),
  activation: Schema.NullOr(Schema.Natural),
  cycle: Schema.NullOr(Schema.Natural),
  role: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  executionOwner: Schema.NullOr(Schema.String),
  previousExecutionOwner: Schema.NullOr(Schema.String),
  startedAtEpochMs: Schema.Int,
  endedAtEpochMs: Schema.NullOr(Schema.Int),
  outcome: Schema.Literals(["running", "succeeded", "failed", "cancelled", "blocked", "observed"]),
  failure: Schema.NullOr(Schema.String),
  candidateSha: Schema.NullOr(exactSha),
  candidateFence: Schema.NullOr(Schema.Natural),
  tokenUsage: Schema.NullOr(
    Schema.Struct({
      inputTokens: Schema.optional(Schema.Natural),
      outputTokens: Schema.optional(Schema.Natural),
      totalTokens: Schema.optional(Schema.Natural),
    }),
  ),
});
type DecodedHistoryRecord = Schema.Schema.Type<typeof historyRecord>;
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
const currentTaskStatus = Schema.Struct({
  schemaVersion: Schema.Literal(TASK_RESULT_SCHEMA_VERSION),
  ...taskResultFields,
  history: Schema.Array(historyRecord),
});

/** The unversioned result written by the current main branch. */
const priorTaskResult = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Undefined),
  ...taskResultFields,
});

const persistedTaskResult = Schema.Union([currentTaskResult, priorTaskResult]);
type DecodedPersistedTaskResult = Schema.Schema.Type<typeof persistedTaskResult>;

function projectHistoryRecord(decoded: DecodedHistoryRecord): TaskHistoryRecord {
  return {
    id: decoded.id,
    taskId: decoded.taskId,
    kind: decoded.kind,
    activation: decoded.activation,
    cycle: decoded.cycle,
    role: decoded.role,
    model: decoded.model,
    executionOwner: decoded.executionOwner,
    previousExecutionOwner: decoded.previousExecutionOwner,
    startedAtEpochMs: decoded.startedAtEpochMs,
    endedAtEpochMs: decoded.endedAtEpochMs,
    outcome: decoded.outcome,
    failure: decoded.failure,
    candidateSha: decoded.candidateSha,
    candidateFence: decoded.candidateFence,
    tokenUsage: decoded.tokenUsage
      ? {
          inputTokens: decoded.tokenUsage.inputTokens,
          outputTokens: decoded.tokenUsage.outputTokens,
          totalTokens: decoded.tokenUsage.totalTokens,
        }
      : null,
  };
}

export function decodeTaskHistoryRecord(input: unknown): TaskHistoryRecord {
  try {
    return projectHistoryRecord(Schema.decodeUnknownSync(historyRecord)(input));
  } catch {
    throw new TaskStateQuarantinedError();
  }
}

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

export function decodeRawPersistedTaskResult(input: string): TaskResult {
  try {
    return decodePersistedTaskResult(JSON.parse(input));
  } catch {
    throw new TaskStateQuarantinedError();
  }
}

export function decodeCurrentTaskResult(input: unknown): TaskResult {
  return projectDecodedResult(Schema.decodeUnknownSync(currentTaskResult)(input));
}

export function decodeCurrentTaskStatus(input: unknown): TaskStatus {
  const decoded = Schema.decodeUnknownSync(currentTaskStatus)(input);
  const result = projectDecodedResult(decoded);
  return {
    ...result,
    history: decoded.history.map(projectHistoryRecord),
  };
}
