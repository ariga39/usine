import { Schema } from "effect";
import {
  TASK_BLOCKER_CLASSIFICATIONS,
  TASK_FAILURE_CLASSES,
  taskFailureClassFromProvider,
} from "./task-state.js";
import { safeEvidenceIdentity } from "./evidence-identity.js";

const safeEventId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const safeObservationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
);
const safeProfileName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const safeEvidenceValue = Schema.String.check(
  Schema.makeFilter((value) =>
    safeEvidenceIdentity(value) !== null ? undefined : "must be a bounded non-hostname identity",
  ),
);
const exactHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const exactSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const role = Schema.Literals(["implementer", "reviewer", "coordinator"]);
const outcome = Schema.Literals(["succeeded", "failed", "cancelled", "blocked"]);
const archiveStatus = Schema.Literals(["stored", "truncated", "failed", "pruned"]);
const archiveCompleteness = Schema.Literals(["complete", "partial"]);
const archiveReference = Schema.Struct({
  archiveId: safeObservationId,
  status: archiveStatus,
  completeness: Schema.optional(archiveCompleteness),
});
const effectiveProfile = Schema.Struct({
  profileName: Schema.NullOr(safeProfileName),
  configSha256: Schema.NullOr(exactHash),
  adapter: Schema.NullOr(Schema.Literals(["sdk", "app-server", "opencode2"])),
  configuredModel: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  configuredProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  model: Schema.NullOr(safeEvidenceValue),
  modelProvider: Schema.NullOr(safeEvidenceValue),
  actualModel: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  actualProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  actualModelProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  reasoningEffort: Schema.NullOr(Schema.Literals(["minimal", "low", "medium", "high", "xhigh"])),
  developerInstructionsSha256: Schema.NullOr(exactHash),
  serviceTier: Schema.optional(Schema.NullOr(safeEvidenceValue)),
});
const usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Natural),
  cachedInputTokens: Schema.optional(Schema.Natural),
  uncachedInputTokens: Schema.optional(Schema.Natural),
  cacheWriteInputTokens: Schema.optional(Schema.Natural),
  outputTokens: Schema.optional(Schema.Natural),
  reasoningOutputTokens: Schema.optional(Schema.Natural),
});
const usageObservationSource = Schema.Literals(["provider", "role_output_normalizer"]);
const normalizer = Schema.Struct({
  status: outcome,
  adapter: Schema.Literal("role-output-normalizer"),
  model: Schema.NullOr(safeEvidenceValue),
  modelProvider: Schema.NullOr(safeEvidenceValue),
  configuredModel: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  configuredProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  actualModel: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  actualProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  actualModelProvider: Schema.optional(Schema.NullOr(safeEvidenceValue)),
  usage: Schema.NullOr(usage),
});

const tool = Schema.Literals(["shell", "apply_patch", "read", "search", "unknown"]);
const codingSessionPhase = Schema.Literals(["startup", "thread", "turn", "output"]);
// Accept the pre-401 adapter vocabulary while decoding old history. New
// observations are normalized to Task Authority's stable vocabulary below.
const codingSessionFailureClass = Schema.Literals([
  ...TASK_FAILURE_CLASSES,
  "transport",
  "rate_limit",
]);

const eventData = Schema.Union([
  Schema.Struct({ type: Schema.Literal("task_admitted"), contractHash: exactHash }),
  Schema.Struct({
    type: Schema.Literal("activation_reserved"),
    activation: Schema.Natural,
    recovery: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_started"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    sessionId: safeObservationId,
    requestedProfile: Schema.optional(safeProfileName),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_thread_started"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_usage_observed"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    sessionId: safeObservationId,
    source: usageObservationSource,
    semantics: Schema.Literals(["delta", "replacement"]),
    actualModel: Schema.optional(
      Schema.Struct({
        model: safeEvidenceValue,
        provider: safeEvidenceValue,
      }),
    ),
    usage,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_sandbox_verified"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    host: Schema.Literal("darwin-seatbelt"),
    workspaceRead: Schema.Literal("verified"),
    workspaceWrite: Schema.Literals(["verified", "denied"]),
    externalRead: Schema.Literal("denied"),
    externalWrite: Schema.Literal("denied"),
    subprocess: Schema.Literal("inherited"),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_turn_started"),
    role,
    activation: Schema.Natural,
    turn: Schema.Natural,
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_tool_completed"),
    role,
    activation: Schema.Natural,
    tool,
    outcome,
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_mcp_tool_completed"),
    role,
    activation: Schema.Natural,
    server: safeObservationId,
    tool: safeObservationId,
    outcome: Schema.Literals(["succeeded", "failed"]),
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_mcp_unavailable"),
    role,
    activation: Schema.Natural,
    server: safeObservationId,
    reason: Schema.Literals(["startup_timeout", "unavailable"]),
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_turn_completed"),
    role,
    activation: Schema.Natural,
    turn: Schema.Natural,
    outcome,
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_completed"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    outcome,
    sessionId: safeObservationId,
    requestedProfile: Schema.optional(safeProfileName),
    effectiveProfile: Schema.optional(effectiveProfile),
    usage: Schema.optional(Schema.NullOr(usage)),
    normalizer: Schema.optional(normalizer),
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_interrupted"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    phase: codingSessionPhase,
    failureClass: codingSessionFailureClass,
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({ type: Schema.Literal("candidate_frozen"), sha: exactSha, fence: Schema.Natural }),
  Schema.Struct({
    type: Schema.Literal("project_check_completed"),
    sha: exactSha,
    cycle: Schema.Natural,
    outcome: Schema.Literals(["passed", "failed"]),
    exitCode: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("review_started"),
    sha: exactSha,
    cycle: Schema.Natural,
  }),
  Schema.Struct({
    type: Schema.Literal("review_interrupted"),
    sha: exactSha,
    cycle: Schema.Natural,
    failureClass: Schema.Literals(TASK_FAILURE_CLASSES),
  }),
  Schema.Struct({
    type: Schema.Literal("review_released"),
    sha: exactSha,
    cycle: Schema.Natural,
  }),
  Schema.Struct({
    type: Schema.Literal("review_completed"),
    sha: exactSha,
    cycle: Schema.Natural,
    verdict: Schema.Literals(["approved", "changes_requested", "inconclusive"]),
    failureClass: Schema.optional(Schema.Literals(TASK_FAILURE_CLASSES)),
  }),
  Schema.Struct({ type: Schema.Literal("repair_batch_recorded"), cycle: Schema.Natural }),
  Schema.Struct({
    type: Schema.Literal("delivery_completed"),
    sha: exactSha,
    prNumber: Schema.Natural,
    merged: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("recovery_observed"),
    kind: Schema.Literals(["server_restart", "execution_owner_changed"]),
  }),
  Schema.Struct({
    type: Schema.Literal("task_blocked"),
    reason: Schema.Literals(TASK_BLOCKER_CLASSIFICATIONS),
  }),
  Schema.Struct({
    type: Schema.Literal("task_waiting"),
    reason: Schema.Literals([
      "network_interruption",
      "delivery_reconciliation",
      "external_review",
      "review_interruption",
    ]),
    activation: Schema.Natural,
    failureClass: Schema.optional(Schema.Literals(TASK_FAILURE_CLASSES)),
    diagnostic: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  }),
  Schema.Struct({
    type: Schema.Literal("task_retry_accepted"),
    reason: Schema.Literals(["network_interruption", "delivery_reconciliation", "external_review"]),
    activation: Schema.Natural,
  }),
  Schema.Struct({
    type: Schema.Literal("task_terminal"),
    state: Schema.Literals(["reviewed_pr", "merged", "blocked"]),
  }),
  Schema.Struct({
    type: Schema.Literal("legacy_observation"),
    kind: Schema.Literals([
      "implementer",
      "project_check",
      "fresh_review",
      "forge_delivery",
      "coordinator_restart",
      "execution_owner_change",
      "unknown",
    ]),
    outcome: Schema.Literals([
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "blocked",
      "observed",
      "unknown",
    ]),
    complete: Schema.Literal(false),
  }),
  Schema.Struct({
    type: Schema.Literal("legacy_import_incomplete"),
    importedCount: Schema.Natural,
    complete: Schema.Literal(false),
  }),
]);

const observationData = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("coding_session_started"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    sessionId: safeObservationId,
    requestedProfile: Schema.optional(safeProfileName),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_thread_started"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_usage_observed"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    sessionId: safeObservationId,
    source: usageObservationSource,
    semantics: Schema.Literals(["delta", "replacement"]),
    actualModel: Schema.optional(
      Schema.Struct({
        model: safeEvidenceValue,
        provider: safeEvidenceValue,
      }),
    ),
    usage,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_sandbox_verified"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    host: Schema.Literal("darwin-seatbelt"),
    workspaceRead: Schema.Literal("verified"),
    workspaceWrite: Schema.Literals(["verified", "denied"]),
    externalRead: Schema.Literal("denied"),
    externalWrite: Schema.Literal("denied"),
    subprocess: Schema.Literal("inherited"),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_turn_started"),
    role,
    activation: Schema.Natural,
    turn: Schema.Natural,
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_tool_completed"),
    role,
    activation: Schema.Natural,
    tool,
    outcome,
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_mcp_tool_completed"),
    role,
    activation: Schema.Natural,
    server: safeObservationId,
    tool: safeObservationId,
    outcome: Schema.Literals(["succeeded", "failed"]),
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_mcp_unavailable"),
    role,
    activation: Schema.Natural,
    server: safeObservationId,
    reason: Schema.Literals(["startup_timeout", "unavailable"]),
    sessionId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_turn_completed"),
    role,
    activation: Schema.Natural,
    turn: Schema.Natural,
    outcome,
    sessionId: safeObservationId,
    outcomeId: safeObservationId,
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_completed"),
    role,
    activation: Schema.Natural,
    reviewCycle: Schema.optional(Schema.Natural),
    outcome,
    sessionId: safeObservationId,
    requestedProfile: Schema.optional(safeProfileName),
    effectiveProfile: Schema.optional(effectiveProfile),
    usage: Schema.optional(Schema.NullOr(usage)),
    normalizer: Schema.optional(normalizer),
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_interrupted"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    phase: codingSessionPhase,
    failureClass: codingSessionFailureClass,
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({
    type: Schema.Literal("recovery_observed"),
    kind: Schema.Literals(["server_restart", "execution_owner_changed"]),
  }),
]);

export type TaskEventData = Schema.Schema.Type<typeof eventData>;
export type TaskObservationEventData = Schema.Schema.Type<typeof observationData>;
export type TaskArchiveReference = Schema.Schema.Type<typeof archiveReference>;

const taskObservationEventInput = Schema.Struct({
  eventId: safeEventId,
  occurredAtEpochMs: Schema.Int,
  data: observationData,
});

export const taskEventSchema = Schema.Struct({
  taskId: safeEventId,
  sequence: Schema.Natural,
  eventId: safeEventId,
  occurredAtEpochMs: Schema.Int,
  data: eventData,
});

export const taskEventPageSchema = Schema.Struct({
  taskId: safeEventId,
  events: Schema.Array(taskEventSchema),
  nextSequence: Schema.Natural,
});

export type TaskObservationEventInput = Schema.Schema.Type<typeof taskObservationEventInput>;
export type TaskEvent = Schema.Schema.Type<typeof taskEventSchema>;
export type TaskEventPage = Schema.Schema.Type<typeof taskEventPageSchema>;

export function decodeTaskObservationEventInput(input: unknown): TaskObservationEventInput {
  const decoded = Schema.decodeUnknownSync(taskObservationEventInput, {
    onExcessProperty: "error",
  })(input);
  if (decoded.data.type === "coding_session_interrupted")
    return {
      ...decoded,
      data: {
        ...decoded.data,
        failureClass: taskFailureClassFromProvider(decoded.data.failureClass),
      },
    };
  return decoded;
}

export function decodeTaskEvent(input: unknown): TaskEvent {
  const decoded = Schema.decodeUnknownSync(taskEventSchema, { onExcessProperty: "error" })(input);
  if (decoded.data.type === "coding_session_interrupted")
    return {
      ...decoded,
      data: {
        ...decoded.data,
        failureClass: taskFailureClassFromProvider(decoded.data.failureClass),
      },
    };
  return decoded;
}
