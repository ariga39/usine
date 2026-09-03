import { Schema } from "effect";
import {
  TASK_BLOCKER_CLASSIFICATIONS,
  type TaskBlockerClassification,
  type TaskResult,
} from "./task-state.js";

export const TASK_RESULT_SCHEMA_VERSION = 4 as const;
export const TASK_STATE_QUARANTINE_DIAGNOSTIC = "durable task state quarantined";

export class TaskStateQuarantinedError extends Error {
  readonly code = "task_state_quarantined";

  constructor(readonly taskId?: string) {
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
  "waiting",
  "candidate",
  "checked",
  "reviewed",
  "reviewed_pr",
  "merged",
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
const mergeEffect = Schema.Struct({
  prNumber: Schema.Natural,
  approvedHeadSha: exactSha,
  mergeCommitSha: exactSha,
  observedState: Schema.Literal("merged"),
});
const deliveryEffect = Schema.Struct({
  sha: exactSha,
  effect: Schema.Literal("github"),
  prNumber: Schema.Natural,
  url: Schema.String,
  attestationId: Schema.String,
  merge: Schema.NullOr(mergeEffect),
});
const legacyDeliveryEffect = Schema.Struct({
  sha: exactSha,
  effect: Schema.Literal("github"),
  prNumber: Schema.Natural,
  url: Schema.String,
  attestationId: Schema.String,
});
const repositorySnapshot = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  baseBranch: Schema.String,
  projectCheck: Schema.Struct({ command: Schema.String, timeoutMs: Schema.Int }),
  gitAuthor: Schema.Struct({ name: Schema.String, email: Schema.String }),
});
const taskWaiting = Schema.Struct({
  reason: Schema.Literals(["network_interruption", "delivery_reconciliation"]),
  resumeState: Schema.Literals(["admitted", "checked", "reviewed"]),
  activation: Schema.Natural,
});
const taskBlockerClassification = Schema.Literals(TASK_BLOCKER_CLASSIFICATIONS);
const taskResultFields = {
  taskId: Schema.String,
  contractHash: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: taskState,
  mergeAuthorized: Schema.Boolean,
  candidateSha: Schema.NullOr(exactSha),
  candidateFence: Schema.NullOr(Schema.Natural),
  check: Schema.NullOr(checkResult),
  review: Schema.NullOr(reviewVerdict),
  delivery: Schema.NullOr(deliveryEffect),
  blocker: Schema.NullOr(Schema.String),
  blockerClassification: Schema.NullOr(taskBlockerClassification),
  waiting: Schema.NullOr(taskWaiting),
  activeActivation: Schema.NullOr(Schema.Natural),
  writer: Schema.Struct({ repositoryIdentity: Schema.String }),
  evidence: Schema.Struct({
    implementerActivations: Schema.Natural,
    reviewCycles: Schema.Natural,
    changesRequestedBatches: Schema.Natural,
    restartRecoveries: Schema.Natural,
  }),
  repository: Schema.optional(repositorySnapshot),
} as const;

const currentTaskResult = Schema.Struct({
  schemaVersion: Schema.Literal(TASK_RESULT_SCHEMA_VERSION),
  ...taskResultFields,
});

const previousTaskResult = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  ...taskResultFields,
  blocker: Schema.NullOr(Schema.String),
  blockerClassification: Schema.optional(Schema.NullOr(taskBlockerClassification)),
});

const priorVersionTwoTaskResult = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  taskId: Schema.String,
  contractHash: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: Schema.Literals([
    "admitted",
    "candidate",
    "checked",
    "reviewed",
    "reviewed_pr",
    "merged",
    "blocked",
  ]),
  mergeAuthorized: Schema.Boolean,
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
  repository: Schema.optional(repositorySnapshot),
});

export const taskListItemSchema = Schema.Struct({
  taskId: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: taskState,
  candidateSha: Schema.NullOr(exactSha),
  activeActivation: Schema.NullOr(Schema.Natural),
  retryable: Schema.Boolean,
  writer: Schema.Struct({ repositoryIdentity: Schema.String }),
  evidence: Schema.Struct({
    implementerActivations: Schema.Natural,
    reviewCycles: Schema.Natural,
    changesRequestedBatches: Schema.Natural,
    restartRecoveries: Schema.Natural,
  }),
});

export const taskListPageSchema = Schema.Struct({
  tasks: Schema.Array(taskListItemSchema),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const publicCheckResult = Schema.Struct({
  sha: exactSha,
  status: Schema.Literals(["passed", "failed"]),
  exitCode: Schema.Int,
});
const publicReviewVerdict = Schema.Struct({
  sha: exactSha,
  verdict: Schema.Literals(["approved", "changes_requested", "inconclusive"]),
  classification: Schema.Literals(["approved", "changes_requested", "inconclusive"]),
  findingCount: Schema.Natural,
});
const publicBlockerDiagnostic = Schema.Struct({
  classification: taskBlockerClassification,
});
const publicTaskWaiting = Schema.Struct({
  reason: Schema.Literals(["network_interruption", "delivery_reconciliation"]),
});
const publicTaskRepository = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  baseBranch: Schema.String,
});
export const taskResourceSchema = Schema.Struct({
  schemaVersion: Schema.Literals([2, 3]),
  taskId: Schema.String,
  contractHash: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: taskState,
  mergeAuthorized: Schema.Boolean,
  candidateSha: Schema.NullOr(exactSha),
  candidateFence: Schema.NullOr(Schema.Natural),
  check: Schema.NullOr(publicCheckResult),
  review: Schema.NullOr(publicReviewVerdict),
  delivery: Schema.NullOr(deliveryEffect),
  blocker: Schema.NullOr(publicBlockerDiagnostic),
  waiting: Schema.optional(Schema.NullOr(publicTaskWaiting)),
  retryable: Schema.optional(Schema.Boolean),
  activeActivation: Schema.NullOr(Schema.Natural),
  writer: Schema.Struct({ repositoryIdentity: Schema.String }),
  repository: Schema.optional(publicTaskRepository),
  evidence: Schema.Struct({
    implementerActivations: Schema.Natural,
    reviewCycles: Schema.Natural,
    changesRequestedBatches: Schema.Natural,
    restartRecoveries: Schema.Natural,
  }),
});

export type TaskListItem = Schema.Schema.Type<typeof taskListItemSchema>;
export type TaskListPage = Schema.Schema.Type<typeof taskListPageSchema>;
const legacyTaskResultFields = {
  taskId: Schema.String,
  contractHash: Schema.String,
  revision: Schema.Natural,
  deadlineEpochMs: Schema.Int,
  state: Schema.Literals([
    "admitted",
    "candidate",
    "checked",
    "reviewed",
    "reviewed_pr",
    "blocked",
  ]),
  candidateSha: Schema.NullOr(exactSha),
  candidateFence: Schema.NullOr(Schema.Natural),
  check: Schema.NullOr(checkResult),
  review: Schema.NullOr(reviewVerdict),
  delivery: Schema.NullOr(legacyDeliveryEffect),
  blocker: Schema.NullOr(Schema.String),
  activeActivation: Schema.NullOr(Schema.Natural),
  writer: Schema.Struct({ repositoryIdentity: Schema.String }),
  evidence: Schema.Struct({
    implementerActivations: Schema.Natural,
    reviewCycles: Schema.Natural,
    changesRequestedBatches: Schema.Natural,
    restartRecoveries: Schema.Natural,
  }),
  repository: Schema.optional(repositorySnapshot),
} as const;
const legacyTaskResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...legacyTaskResultFields,
});
/** The unversioned result written by the pre-versioned main branch. */
const priorTaskResult = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Undefined),
  ...legacyTaskResultFields,
});

const persistedTaskResult = Schema.Union([
  currentTaskResult,
  previousTaskResult,
  priorVersionTwoTaskResult,
  legacyTaskResult,
  priorTaskResult,
]);
type DecodedPersistedTaskResult = Schema.Schema.Type<typeof persistedTaskResult>;

const LEGACY_BLOCKER_CLASSIFICATION: TaskBlockerClassification = "unknown";

function projectBlockerClassification(
  blocker: string | null,
  classification: TaskResult["blockerClassification"] | undefined,
  state: TaskResult["state"],
): TaskResult["blockerClassification"] {
  if (state !== "blocked" || blocker === null) return null;
  return classification ?? LEGACY_BLOCKER_CLASSIFICATION;
}

function projectDecodedResult(decoded: DecodedPersistedTaskResult): TaskResult {
  return {
    schemaVersion: TASK_RESULT_SCHEMA_VERSION,
    taskId: decoded.taskId,
    contractHash: decoded.contractHash,
    revision: decoded.revision,
    deadlineEpochMs: decoded.deadlineEpochMs,
    state: decoded.state,
    mergeAuthorized: "mergeAuthorized" in decoded ? decoded.mergeAuthorized : false,
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
    delivery: decoded.delivery
      ? {
          sha: decoded.delivery.sha,
          effect: decoded.delivery.effect,
          prNumber: decoded.delivery.prNumber,
          url: decoded.delivery.url,
          attestationId: decoded.delivery.attestationId,
          merge: "merge" in decoded.delivery ? decoded.delivery.merge : null,
        }
      : null,
    blocker: decoded.blocker,
    blockerClassification: projectBlockerClassification(
      decoded.blocker,
      "blockerClassification" in decoded ? decoded.blockerClassification : undefined,
      decoded.state,
    ),
    waiting: "waiting" in decoded ? decoded.waiting : null,
    activeActivation: decoded.activeActivation,
    writer: { repositoryIdentity: decoded.writer.repositoryIdentity },
    repository: decoded.repository
      ? {
          id: decoded.repository.id,
          path: decoded.repository.path,
          owner: decoded.repository.owner,
          name: decoded.repository.name,
          baseBranch: decoded.repository.baseBranch,
          projectCheck: { ...decoded.repository.projectCheck },
          gitAuthor: { ...decoded.repository.gitAuthor },
        }
      : undefined,
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

export function taskListItemFromResult(result: TaskResult): TaskListItem {
  return {
    taskId: result.taskId,
    revision: result.revision,
    deadlineEpochMs: result.deadlineEpochMs,
    state: result.state,
    candidateSha: result.candidateSha,
    activeActivation: result.activeActivation,
    retryable: result.waiting != null,
    writer: { repositoryIdentity: result.writer.repositoryIdentity },
    evidence: { ...result.evidence },
  };
}
