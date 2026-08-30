import type { TaskEvent, TaskResource } from "@usine/task-authority";

export type EvidenceRole = "implementer" | "reviewer";
export type EvidenceOutcomeStatus = "succeeded" | "failed" | "cancelled" | "blocked" | "unknown";
export type EvidenceArchiveStatus = "complete" | "partial" | "unavailable";
export type EvidenceAdapter = "sdk" | "app-server" | null;
export type EvidenceReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | null;

export interface EffectiveRoleProfile {
  readonly profileName: string | null;
  readonly configSha256: string | null;
  readonly adapter: EvidenceAdapter;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly reasoningEffort: EvidenceReasoningEffort;
  readonly developerInstructionsSha256: string | null;
}

export interface RoleRunEffort {
  phase: "startup" | "thread" | "turn" | "output" | null;
  failureClass:
    | "transport"
    | "network"
    | "rate_limit"
    | "timeout"
    | "cancellation"
    | "configuration"
    | "authority"
    | "unknown"
    | null;
  observations: {
    type:
      | "thread_started"
      | "turn_started"
      | "turn_completed"
      | "tool_completed"
      | "mcp_tool_completed"
      | "mcp_unavailable";
    turn?: number;
    tool?: string;
    outcome?: string;
  }[];
}

export interface RoleRunEvidence {
  readonly role: EvidenceRole;
  readonly activation: number | null;
  readonly requestedProfile: string | null;
  readonly effectiveProfile: EffectiveRoleProfile;
  readonly effort: RoleRunEffort;
  readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number } | null;
  readonly archive: { readonly archiveId: string | null; readonly status: EvidenceArchiveStatus };
  readonly outcome: {
    readonly status: EvidenceOutcomeStatus;
    readonly candidateSha: string | null;
    readonly taskRelation:
      | "accepted_exact_sha"
      | "different_sha"
      | "not_yet_accepted"
      | "not_observed"
      | "unavailable";
  };
}

export interface TaskEvidence {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly roleRuns: {
    readonly implementer: readonly RoleRunEvidence[];
    readonly reviewer: readonly RoleRunEvidence[];
  };
  readonly task: {
    readonly state: TaskResource["state"];
    readonly candidateSha: string | null;
    readonly relation:
      | "accepted_exact_sha"
      | "not_yet_accepted"
      | "stale_or_unavailable"
      | "blocked";
  };
}

export function deriveTaskEvidence(
  task: TaskResource,
  events: readonly TaskEvent[],
): TaskEvidence {
  const uniqueEvents = [...new Map(events.map((event) => [event.eventId, event])).values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  );
  const runs = new Map<string, MutableRoleRun>();
  const candidateByActivation = new Map<number, string>();
  const reviewByCycle = new Map<number, string>();
  const observedOutcomeIds = new Set<string>();

  for (const event of uniqueEvents) {
    if (event.data.type === "candidate_frozen") {
      candidateByActivation.set(event.data.fence, event.data.sha);
      continue;
    }
    if (event.data.type === "review_completed") {
      reviewByCycle.set(event.data.cycle, event.data.sha);
      continue;
    }
    const data = event.data;
    if (!isRoleRunEvent(data)) continue;
    const outcomeId =
      data.type === "coding_tool_completed" ||
      data.type === "coding_mcp_tool_completed" ||
      data.type === "coding_turn_completed"
        ? data.outcomeId
        : undefined;
    if (outcomeId) {
      const identity = `${data.role}:${data.activation}:${data.sessionId}:${outcomeId}`;
      if (observedOutcomeIds.has(identity)) continue;
      observedOutcomeIds.add(identity);
    }
    const key = `${data.role}:${data.activation}:${data.sessionId}`;
    const run = runs.get(key) ?? mutableRoleRun(data.role, data.activation, data.sessionId);
    if (data.type === "coding_session_started") {
      run.requestedProfile = data.requestedProfile ?? run.requestedProfile;
    } else if (data.type === "coding_session_completed") {
      run.requestedProfile = data.requestedProfile ?? run.requestedProfile;
      run.effectiveProfile = data.effectiveProfile ?? run.effectiveProfile;
      run.usage = data.usage ?? run.usage;
      run.archive = data.archive ? archiveEvidence(data.archive) : run.archive;
      run.outcome.status = data.outcome;
    } else if (data.type === "coding_session_interrupted") {
      run.effort.phase = data.phase;
      run.effort.failureClass = data.failureClass;
      run.outcome.status = data.failureClass === "cancellation" ? "cancelled" : "failed";
    } else {
      run.effort.observations.push(effortObservation(data));
      if (data.type === "coding_turn_started") run.effort.phase = "turn";
      if (data.type === "coding_turn_completed") run.effort.phase = "output";
    }
    runs.set(key, run);
  }

  for (const run of runs.values()) {
    const candidateSha =
      run.role === "implementer"
        ? candidateByActivation.get(run.activation ?? -1) ?? null
        : run.activation === null
          ? null
          : reviewByCycle.get(reviewCycle(run.sessionId) ?? -1) ?? null;
    run.outcome.candidateSha = candidateSha;
    run.outcome.taskRelation = relationToTask(candidateSha, task);
  }

  const roleRuns = { implementer: [] as RoleRunEvidence[], reviewer: [] as RoleRunEvidence[] };
  for (const run of runs.values()) roleRuns[run.role].push(toPublicRoleRun(run));
  roleRuns.implementer.sort(roleRunOrder);
  roleRuns.reviewer.sort(roleRunOrder);
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    roleRuns,
    task: {
      state: task.state,
      candidateSha: task.candidateSha,
      relation: taskRelation(task),
    },
  };
}

export const taskEvidenceFrom = deriveTaskEvidence;

interface MutableRoleRun {
  role: EvidenceRole;
  activation: number | null;
  sessionId: string;
  requestedProfile: string | null;
  effectiveProfile: EffectiveRoleProfile;
  effort: RoleRunEffort;
  usage: RoleRunEvidence["usage"];
  archive: RoleRunEvidence["archive"];
  outcome: {
    status: EvidenceOutcomeStatus;
    candidateSha: string | null;
    taskRelation: RoleRunEvidence["outcome"]["taskRelation"];
  };
}

function mutableRoleRun(role: EvidenceRole, activation: number, sessionId = "unknown"): MutableRoleRun {
  return {
    role,
    activation,
    sessionId,
    requestedProfile: null,
    effectiveProfile: unavailableEffectiveProfile(),
    effort: { phase: null, failureClass: null, observations: [] },
    usage: null,
    archive: { archiveId: null, status: "unavailable" },
    outcome: { status: "unknown", candidateSha: null, taskRelation: "not_observed" },
  };
}

function toPublicRoleRun(run: MutableRoleRun): RoleRunEvidence {
  const { sessionId: _sessionId, ...publicRun } = run;
  return publicRun;
}

function reviewCycle(sessionId: string): number | null {
  const match = /^review-session:([0-9]+):/.exec(sessionId);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function isRoleRunEvent(
  data: TaskEvent["data"],
): data is RoleRunEvent {
  return (
    (data.type === "coding_session_started" ||
      data.type === "coding_thread_started" ||
      data.type === "coding_turn_started" ||
      data.type === "coding_tool_completed" ||
      data.type === "coding_mcp_tool_completed" ||
      data.type === "coding_mcp_unavailable" ||
      data.type === "coding_turn_completed" ||
      data.type === "coding_session_completed" ||
      data.type === "coding_session_interrupted") &&
    data.role !== "coordinator"
  );
}

type RoleRunEvent =
  | (Extract<TaskEvent["data"], { type: "coding_session_started" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_thread_started" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_turn_started" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_tool_completed" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_mcp_tool_completed" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_mcp_unavailable" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_turn_completed" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_session_completed" }> & { role: EvidenceRole })
  | (Extract<TaskEvent["data"], { type: "coding_session_interrupted" }> & { role: EvidenceRole });

function effortObservation(data: RoleRunEvent) {
  switch (data.type) {
    case "coding_thread_started":
      return { type: "thread_started" as const };
    case "coding_turn_started":
      return { type: "turn_started" as const, turn: data.turn };
    case "coding_turn_completed":
      return { type: "turn_completed" as const, turn: data.turn, outcome: data.outcome };
    case "coding_tool_completed":
      return { type: "tool_completed" as const, tool: data.tool, outcome: data.outcome };
    case "coding_mcp_tool_completed":
      return { type: "mcp_tool_completed" as const, tool: data.tool, outcome: data.outcome };
    case "coding_mcp_unavailable":
      return { type: "mcp_unavailable" as const, tool: data.server, outcome: data.reason };
    default:
      return { type: "thread_started" as const };
  }
}

function archiveEvidence(archive: { archiveId: string; status: "stored" | "truncated" | "failed" | "pruned" }) {
  return {
    archiveId: archive.archiveId,
    status:
      archive.status === "stored"
        ? ("complete" as const)
        : archive.status === "failed"
          ? ("unavailable" as const)
          : ("partial" as const),
  };
}

function relationToTask(candidateSha: string | null, task: TaskResource): RoleRunEvidence["outcome"]["taskRelation"] {
  if (!candidateSha) return "not_observed";
  if (!task.candidateSha) return "unavailable";
  if (candidateSha !== task.candidateSha) return "different_sha";
  return taskHasAcceptedOutcome(task) ? "accepted_exact_sha" : "not_yet_accepted";
}

function taskRelation(task: TaskResource): TaskEvidence["task"]["relation"] {
  if (task.state === "blocked") return "blocked";
  return taskHasAcceptedOutcome(task) ? "accepted_exact_sha" : "not_yet_accepted";
}

function taskHasAcceptedOutcome(task: TaskResource): boolean {
  const candidateSha = task.candidateSha;
  return (
    (task.state === "reviewed" || task.state === "reviewed_pr" || task.state === "merged") &&
    candidateSha !== null &&
    task.check?.sha === candidateSha &&
    task.check.status === "passed" &&
    task.review?.sha === candidateSha &&
    task.review.verdict === "approved"
  );
}

function unavailableEffectiveProfile(): EffectiveRoleProfile {
  return {
    profileName: null,
    configSha256: null,
    adapter: null,
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    developerInstructionsSha256: null,
  };
}

function roleRunOrder(left: RoleRunEvidence, right: RoleRunEvidence): number {
  return (left.activation ?? Number.MAX_SAFE_INTEGER) - (right.activation ?? Number.MAX_SAFE_INTEGER);
}

export function renderTaskEvidence(evidence: TaskEvidence, json: boolean): string {
  if (json) return `${JSON.stringify(evidence)}\n`;
  return [
    `Task ${evidence.taskId} evidence: ${evidence.task.state}`,
    `Task outcome: ${evidence.task.relation} (${evidence.task.candidateSha ?? "unavailable"})`,
    "IMPLEMENTER ROLE RUNS",
    ...evidence.roleRuns.implementer.map(renderRoleRun),
    "REVIEWER ROLE RUNS",
    ...evidence.roleRuns.reviewer.map(renderRoleRun),
    "",
  ].join("\n");
}

function renderRoleRun(run: RoleRunEvidence): string {
  return [
    `  activation=${run.activation ?? "unknown"} requested-profile=${run.requestedProfile ?? "unknown"}`,
    `    effective=${run.effectiveProfile.profileName ?? "unavailable"} model=${run.effectiveProfile.model ?? "unavailable"} provider=${run.effectiveProfile.modelProvider ?? "unavailable"} adapter=${run.effectiveProfile.adapter ?? "unavailable"} reasoning=${run.effectiveProfile.reasoningEffort ?? "unavailable"}`,
    `    status=${run.outcome.status} usage=${run.usage ? JSON.stringify(run.usage) : "unavailable"} archive=${run.archive.archiveId ?? "unavailable"} (${run.archive.status})`,
    `    effort=${run.effort.observations.map((observation) => observation.type).join(",") || "unavailable"} phase=${run.effort.phase ?? "unknown"}`,
    `    relation=${run.outcome.taskRelation}`,
  ].join("\n");
}
