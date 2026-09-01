import { Predicate, Schema } from "effect";

const safeEventId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const safeObservationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
);
const safeProfileName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const safeEvidenceValue = Schema.String.check(
  Schema.makeFilter((value) =>
    isSafeEvidenceIdentity(value) ? undefined : "must be a bounded non-hostname identity",
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
  model: Schema.NullOr(safeEvidenceValue),
  modelProvider: Schema.NullOr(safeEvidenceValue),
  reasoningEffort: Schema.NullOr(Schema.Literals(["minimal", "low", "medium", "high", "xhigh"])),
  developerInstructionsSha256: Schema.NullOr(exactHash),
});
const usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Natural),
  outputTokens: Schema.optional(Schema.Natural),
});

function isSafeEvidenceIdentity(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return false;
  const labels = value.split(".");
  return labels.length < 2 || !/^[A-Za-z]+$/.test(labels.at(-1)!);
}

const tool = Schema.Literals(["shell", "apply_patch", "read", "search", "unknown"]);
const codingSessionPhase = Schema.Literals(["startup", "thread", "turn", "output"]);
const codingSessionFailureClass = Schema.Literals([
  "transport",
  "network",
  "rate_limit",
  "timeout",
  "cancellation",
  "configuration",
  "authority",
  "unknown",
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
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_interrupted"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    phase: codingSessionPhase,
    failureClass: codingSessionFailureClass,
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
    type: Schema.Literal("review_completed"),
    sha: exactSha,
    cycle: Schema.Natural,
    verdict: Schema.Literals(["approved", "changes_requested", "inconclusive"]),
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
    reason: Schema.Literals([
      "elapsed_budget",
      "invalid_phase",
      "missing_evidence",
      "provider_failure",
      "project_check_failure",
      "review_inconclusive",
      "delivery_failure",
      "unknown",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("task_waiting"),
    reason: Schema.Literal("network_interruption"),
    activation: Schema.Natural,
  }),
  Schema.Struct({
    type: Schema.Literal("task_retry_accepted"),
    reason: Schema.Literal("network_interruption"),
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
    archive: Schema.optional(archiveReference),
  }),
  Schema.Struct({
    type: Schema.Literal("coding_session_interrupted"),
    role,
    activation: Schema.Natural,
    sessionId: safeObservationId,
    phase: codingSessionPhase,
    failureClass: codingSessionFailureClass,
  }),
  Schema.Struct({
    type: Schema.Literal("recovery_observed"),
    kind: Schema.Literals(["server_restart", "execution_owner_changed"]),
  }),
]);

export type TaskEventData = Schema.Schema.Type<typeof eventData>;
export type TaskObservationEventData = Schema.Schema.Type<typeof observationData>;

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
  assertExactKeys(input, ["eventId", "occurredAtEpochMs", "data"]);
  if (Predicate.isObject(input) && Predicate.isObject(input.data)) assertExactDataKeys(input.data);
  return Schema.decodeUnknownSync(taskObservationEventInput)(input);
}

export function decodeTaskEvent(input: unknown): TaskEvent {
  assertExactKeys(input, ["taskId", "sequence", "eventId", "occurredAtEpochMs", "data"]);
  if (Predicate.isObject(input) && Predicate.isObject(input.data)) assertExactDataKeys(input.data);
  return Schema.decodeUnknownSync(taskEventSchema)(input);
}

const dataFields: Record<string, readonly string[]> = {
  task_admitted: ["type", "contractHash"],
  activation_reserved: ["type", "activation", "recovery"],
  coding_session_started: [
    "type",
    "role",
    "activation",
    "reviewCycle",
    "sessionId",
    "requestedProfile",
  ],
  coding_thread_started: ["type", "role", "activation", "sessionId"],
  coding_sandbox_verified: [
    "type",
    "role",
    "activation",
    "sessionId",
    "host",
    "workspaceRead",
    "workspaceWrite",
    "externalRead",
    "externalWrite",
    "subprocess",
  ],
  coding_turn_started: ["type", "role", "activation", "turn", "sessionId"],
  coding_tool_completed: [
    "type",
    "role",
    "activation",
    "tool",
    "outcome",
    "sessionId",
    "outcomeId",
  ],
  coding_mcp_tool_completed: [
    "type",
    "role",
    "activation",
    "server",
    "tool",
    "outcome",
    "sessionId",
    "outcomeId",
  ],
  coding_mcp_unavailable: ["type", "role", "activation", "server", "reason", "sessionId"],
  coding_turn_completed: [
    "type",
    "role",
    "activation",
    "turn",
    "outcome",
    "sessionId",
    "outcomeId",
  ],
  coding_session_completed: [
    "type",
    "role",
    "activation",
    "reviewCycle",
    "outcome",
    "sessionId",
    "requestedProfile",
    "effectiveProfile",
    "usage",
    "archive",
  ],
  coding_session_interrupted: ["type", "role", "activation", "sessionId", "phase", "failureClass"],
  candidate_frozen: ["type", "sha", "fence"],
  project_check_completed: ["type", "sha", "cycle", "outcome", "exitCode"],
  review_completed: ["type", "sha", "cycle", "verdict"],
  repair_batch_recorded: ["type", "cycle"],
  delivery_completed: ["type", "sha", "prNumber", "merged"],
  recovery_observed: ["type", "kind"],
  task_blocked: ["type", "reason"],
  task_waiting: ["type", "reason", "activation"],
  task_retry_accepted: ["type", "reason", "activation"],
  task_terminal: ["type", "state"],
  legacy_observation: ["type", "kind", "outcome", "complete"],
  legacy_import_incomplete: ["type", "importedCount", "complete"],
};

function assertExactKeys(input: unknown, expected: readonly string[]): void {
  if (!Predicate.isObject(input)) throw new Error("event must be an object");
  const actual = Object.keys(input).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index]))
    throw new Error("event contains fields outside its allowlist");
}

function assertExactDataKeys(input: Record<string, unknown>): void {
  if (typeof input.type !== "string") throw new Error("event data type is invalid");
  const expected = dataFields[input.type];
  if (!expected) throw new Error("event data type is invalid");
  const actual = Object.keys(input);
  const optional =
    input.type === "coding_session_started"
      ? new Set(["reviewCycle", "requestedProfile"])
      : input.type === "coding_session_completed"
        ? new Set(["reviewCycle", "requestedProfile", "effectiveProfile", "usage", "archive"])
        : new Set<string>();
  assertExactKeys(
    input,
    expected.filter((key) => !optional.has(key) || actual.includes(key)),
  );
}
