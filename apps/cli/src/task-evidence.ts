import type { TaskResource } from "@usine/task-authority";

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
  readonly phase: "startup" | "thread" | "turn" | "output" | null;
  readonly failureClass:
    | "transport"
    | "network"
    | "rate_limit"
    | "timeout"
    | "cancellation"
    | "configuration"
    | "authority"
    | "unknown"
    | null;
  readonly observations: readonly {
    readonly type:
      | "thread_started"
      | "turn_started"
      | "turn_completed"
      | "tool_completed"
      | "mcp_tool_completed"
      | "mcp_unavailable";
    readonly turn?: number;
    readonly tool?: string;
    readonly outcome?: string;
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
    `    effort=${run.effort.observations.length} observations phase=${run.effort.phase ?? "unknown"}`,
  ].join("\n");
}
