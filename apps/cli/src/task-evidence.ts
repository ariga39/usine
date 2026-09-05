import type { TaskEvent, TaskResource } from "@usine/task-authority";

export type EvidenceRole = "implementer" | "reviewer";
export type EvidenceOutcomeStatus = "succeeded" | "failed" | "cancelled" | "blocked" | "unknown";
export type EvidenceArchiveStatus = "complete" | "partial" | "unavailable";
type CompletedSessionEvent = Extract<TaskEvent["data"], { type: "coding_session_completed" }>;
export type EvidenceAdapter = NonNullable<CompletedSessionEvent["effectiveProfile"]>["adapter"];
export type EvidenceReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | null;

export interface EffectiveRoleProfile {
  readonly profileName: string | null;
  readonly configSha256: string | null;
  readonly adapter: EvidenceAdapter;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly actualModel?: string | null;
  readonly actualModelProvider?: string | null;
  readonly reasoningEffort: EvidenceReasoningEffort;
  readonly developerInstructionsSha256: string | null;
}

export interface RoleRunEffort {
  elapsedMs: number | null;
  counts: { turns: number; tools: number; mcpTools: number };
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
  readonly reviewCycle: number | null;
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
    readonly candidateFence: number | null;
    readonly check: TaskResource["check"];
    readonly review: TaskResource["review"];
    readonly repairBatches: number | null;
    readonly delivery: {
      readonly sha: string;
      readonly prNumber: number;
      readonly merged: boolean;
    } | null;
    readonly relation: "accepted_exact_sha" | "not_yet_accepted" | "blocked";
  };
}

export function deriveTaskEvidence(task: TaskResource, events: readonly TaskEvent[]): TaskEvidence {
  const uniqueEvents = [
    ...new Map(events.map((event) => [event.eventId, event])).values(),
  ].toSorted((left, right) => left.sequence - right.sequence);
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
    const explicitReviewCycle =
      data.type === "coding_session_started" || data.type === "coding_session_completed"
        ? data.reviewCycle
        : undefined;
    const run =
      runs.get(key) ??
      mutableRoleRun(data.role, data.activation, data.sessionId, explicitReviewCycle);
    if (explicitReviewCycle !== undefined) run.reviewCycle = explicitReviewCycle;
    if (run.terminalObserved) continue;
    if (run.interruptedAtEpochMs !== null && data.type !== "coding_session_completed") continue;
    if (data.type === "coding_session_started") {
      run.sessionStartedAtEpochMs = Math.min(
        run.sessionStartedAtEpochMs ?? event.occurredAtEpochMs,
        event.occurredAtEpochMs,
      );
      run.requestedProfile = data.requestedProfile ?? run.requestedProfile;
    } else if (data.type === "coding_session_completed") {
      run.requestedProfile = data.requestedProfile ?? run.requestedProfile;
      run.effectiveProfile = data.effectiveProfile
        ? {
            ...data.effectiveProfile,
            actualModel: data.effectiveProfile.actualModel ?? null,
            actualModelProvider: data.effectiveProfile.actualModelProvider ?? null,
          }
        : run.effectiveProfile;
      run.usage = data.usage ?? run.usage;
      run.archive = data.archive ? archiveEvidence(data.archive) : run.archive;
      run.outcome.status = data.outcome;
      run.terminalAtEpochMs = event.occurredAtEpochMs;
      run.terminalObserved = true;
    } else if (data.type === "coding_session_interrupted") {
      run.effort.phase = data.phase;
      run.effort.failureClass = data.failureClass;
      run.outcome.status = data.failureClass === "cancellation" ? "cancelled" : "failed";
      run.interruptedAtEpochMs = event.occurredAtEpochMs;
      run.terminalAtEpochMs = event.occurredAtEpochMs;
    } else {
      run.effort.observations.push(effortObservation(data));
      if (data.type === "coding_turn_started") run.effort.counts.turns += 1;
      if (data.type === "coding_tool_completed") run.effort.counts.tools += 1;
      if (data.type === "coding_mcp_tool_completed") run.effort.counts.mcpTools += 1;
      if (data.type === "coding_turn_started") run.effort.phase = "turn";
      if (data.type === "coding_turn_completed") run.effort.phase = "output";
    }
    runs.set(key, run);
  }

  for (const run of runs.values()) {
    const candidateSha =
      run.role === "implementer"
        ? (candidateByActivation.get(run.activation ?? -1) ?? null)
        : (reviewByCycle.get(run.reviewCycle ?? -1) ?? null);
    run.outcome.candidateSha = candidateSha;
    run.outcome.taskRelation = relationToTask(candidateSha, task);
    run.effort.elapsedMs =
      run.sessionStartedAtEpochMs === null || run.terminalAtEpochMs === null
        ? null
        : Math.max(0, run.terminalAtEpochMs - run.sessionStartedAtEpochMs);
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
      candidateFence: task.candidateFence,
      check: task.check,
      review: task.review,
      repairBatches: task.evidence?.changesRequestedBatches ?? null,
      delivery: task.delivery
        ? {
            sha: task.delivery.sha,
            prNumber: task.delivery.prNumber,
            merged: task.delivery.merge?.observedState === "merged",
          }
        : null,
      relation: taskRelation(task),
    },
  };
}

interface MutableRoleRun {
  role: EvidenceRole;
  activation: number | null;
  reviewCycle: number | null;
  sessionId: string;
  sessionStartedAtEpochMs: number | null;
  terminalAtEpochMs: number | null;
  interruptedAtEpochMs: number | null;
  terminalObserved: boolean;
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

function mutableRoleRun(
  role: EvidenceRole,
  candidateFence: number,
  sessionId = "unknown",
  reviewCycle: number | undefined,
): MutableRoleRun {
  return {
    role,
    activation: role === "implementer" ? candidateFence : null,
    reviewCycle: role === "reviewer" ? (reviewCycle ?? null) : null,
    sessionId,
    sessionStartedAtEpochMs: null,
    terminalAtEpochMs: null,
    interruptedAtEpochMs: null,
    terminalObserved: false,
    requestedProfile: null,
    effectiveProfile: unavailableEffectiveProfile(),
    effort: {
      elapsedMs: null,
      counts: { turns: 0, tools: 0, mcpTools: 0 },
      phase: null,
      failureClass: null,
      observations: [],
    },
    usage: null,
    archive: { archiveId: null, status: "unavailable" },
    outcome: { status: "unknown", candidateSha: null, taskRelation: "not_observed" },
  };
}

function toPublicRoleRun(run: MutableRoleRun): RoleRunEvidence {
  const { sessionId: _sessionId, ...publicRun } = run;
  return publicRun;
}

function isRoleRunEvent(data: TaskEvent["data"]): data is RoleRunEvent {
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

function archiveEvidence(archive: {
  archiveId: string;
  status: "stored" | "truncated" | "failed" | "pruned";
  completeness?: "complete" | "partial";
}) {
  if (
    archive.completeness === undefined ||
    archive.status === "failed" ||
    archive.status === "pruned"
  )
    return { archiveId: archive.archiveId, status: "unavailable" as const };
  return {
    archiveId: archive.archiveId,
    status: archive.completeness === "complete" ? ("complete" as const) : ("partial" as const),
  };
}

function relationToTask(
  candidateSha: string | null,
  task: TaskResource,
): RoleRunEvidence["outcome"]["taskRelation"] {
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
    actualModel: null,
    actualModelProvider: null,
    reasoningEffort: null,
    developerInstructionsSha256: null,
  };
}

function roleRunOrder(left: RoleRunEvidence, right: RoleRunEvidence): number {
  const leftOrder = left.role === "reviewer" ? left.reviewCycle : left.activation;
  const rightOrder = right.role === "reviewer" ? right.reviewCycle : right.activation;
  return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
}

export function renderTaskEvidence(evidence: TaskEvidence, json: boolean): string {
  if (json) return `${JSON.stringify(evidence)}\n`;
  return [
    `Task ${evidence.taskId} evidence: ${evidence.task.state}`,
    `Task outcome: ${evidence.task.relation} (${evidence.task.candidateSha ?? "unavailable"})`,
    `Task candidate: ${evidence.task.candidateSha ?? "unavailable"} fence=${evidence.task.candidateFence ?? "unavailable"}`,
    `Task check: ${evidence.task.check ? `${evidence.task.check.status} ${evidence.task.check.sha} exit=${evidence.task.check.exitCode}` : "unavailable"}`,
    `Task review: ${evidence.task.review ? `${evidence.task.review.verdict} ${evidence.task.review.sha} findings=${evidence.task.review.findingCount}` : "unavailable"}`,
    `Task repair batches: ${evidence.task.repairBatches ?? "unavailable"}`,
    `Task delivery: ${evidence.task.delivery ? `github ${evidence.task.delivery.sha} pr=${evidence.task.delivery.prNumber} merged=${evidence.task.delivery.merged}` : "unavailable"}`,
    "IMPLEMENTER ROLE RUNS",
    ...evidence.roleRuns.implementer.map(renderRoleRun),
    "REVIEWER ROLE RUNS",
    ...evidence.roleRuns.reviewer.map(renderRoleRun),
    "",
  ].join("\n");
}

function renderRoleRun(run: RoleRunEvidence): string {
  return [
    `  ${run.role === "reviewer" ? `review-cycle=${run.reviewCycle ?? "unknown"}` : `activation=${run.activation ?? "unknown"}`} requested-profile=${run.requestedProfile ?? "unknown"}`,
    `    effective=${run.effectiveProfile.profileName ?? "unavailable"} configured-model=${run.effectiveProfile.model ?? "unavailable"} configured-provider=${run.effectiveProfile.modelProvider ?? "unavailable"} actual-model=${run.effectiveProfile.actualModel ?? "unavailable"} actual-provider=${run.effectiveProfile.actualModelProvider ?? "unavailable"} adapter=${run.effectiveProfile.adapter ?? "unavailable"} reasoning=${run.effectiveProfile.reasoningEffort ?? "unavailable"}`,
    `    status=${run.outcome.status} usage=${run.usage ? JSON.stringify(run.usage) : "unavailable"} archive=${run.archive.archiveId ?? "unavailable"} (${run.archive.status})`,
    `    effort=${run.effort.observations.map((observation) => observation.type).join(",") || "unavailable"} elapsed-ms=${run.effort.elapsedMs ?? "unknown"} turns=${run.effort.counts.turns} tools=${run.effort.counts.tools} mcp-tools=${run.effort.counts.mcpTools} phase=${run.effort.phase ?? "unknown"}`,
    `    relation=${run.outcome.taskRelation}`,
  ].join("\n");
}
