import { Schema } from "effect";
import type { UsageAmounts, UsageReportSource } from "./usage-report.js";
import { TASK_FAILURE_CLASSES, type TaskBlockerClassification } from "./task-state.js";

const exactSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

export const MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE = 200;

const usageAmounts = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Natural),
  cachedInputTokens: Schema.NullOr(Schema.Natural),
  uncachedInputTokens: Schema.NullOr(Schema.Natural),
  cacheWriteInputTokens: Schema.NullOr(Schema.Natural),
  outputTokens: Schema.NullOr(Schema.Natural),
  reasoningOutputTokens: Schema.NullOr(Schema.Natural),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
});

const evidenceRun = Schema.Struct({
  invocationId: Schema.String,
  goalVersion: Schema.Int,
  outcomeId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(Schema.Natural),
  repositoryId: Schema.String,
  repository: Schema.String,
  role: Schema.Literals(["implementer", "reviewer", "assessor", "replacement-planner"]),
  activation: Schema.NullOr(Schema.Natural),
  reviewCycle: Schema.NullOr(Schema.Natural),
  configuredProvider: Schema.String,
  configuredModel: Schema.String,
  actualModel: Schema.String,
  actualProvider: Schema.String,
  provider: Schema.String,
  adapter: Schema.String,
  profile: Schema.optional(Schema.String),
  serviceTier: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  model: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled", "blocked", "unknown"]),
  failureClass: Schema.optional(Schema.NullOr(Schema.Literals(TASK_FAILURE_CLASSES))),
  occurredAtEpochMs: Schema.Int,
  elapsedMs: Schema.NullOr(Schema.Natural),
  usage: usageAmounts,
});

const evidenceAggregate = Schema.Struct({
  goalVersion: Schema.Int,
  outcomeId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  role: Schema.Literals(["implementer", "reviewer", "assessor", "replacement-planner"]),
  configuredProvider: Schema.String,
  configuredModel: Schema.String,
  actualModel: Schema.String,
  actualProvider: Schema.String,
  model: Schema.String,
  provider: Schema.String,
  adapter: Schema.String,
  profile: Schema.optional(Schema.String),
  serviceTier: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  failureClass: Schema.optional(Schema.NullOr(Schema.Literals(TASK_FAILURE_CLASSES))),
  invocations: Schema.Natural,
  elapsedMs: Schema.NullOr(Schema.Natural),
  usage: usageAmounts,
});

const campaignTouch = Schema.Struct({
  touchId: Schema.String,
  goalVersion: Schema.Int,
  type: Schema.Literals(["plan", "decision", "warning"]),
  occurredAtEpochMs: Schema.Int,
});

const acceptedDelivery = Schema.Struct({
  taskId: Schema.String,
  goalVersion: Schema.Int,
  outcomeId: Schema.String,
  effect: Schema.Literal("github"),
  pullRequest: Schema.Natural,
  sha: exactSha,
  url: Schema.String,
  attestationId: Schema.String,
  merged: Schema.Boolean,
  mergeCommitSha: Schema.NullOr(exactSha),
  occurredAtEpochMs: Schema.NullOr(Schema.Int),
});

const campaignProgress = Schema.Struct({
  revision: Schema.Natural,
  occurredAtEpochMs: Schema.Int,
});

const terminalTaskCounts = Schema.Struct({
  elapsed_budget: Schema.Natural,
  implementation_budget: Schema.Natural,
  invalid_phase: Schema.Natural,
  missing_evidence: Schema.Natural,
  provider_failure: Schema.Natural,
  transient_capacity: Schema.optional(Schema.Natural),
  transient_transport: Schema.optional(Schema.Natural),
  network: Schema.optional(Schema.Natural),
  timeout: Schema.optional(Schema.Natural),
  configuration: Schema.optional(Schema.Natural),
  authority: Schema.optional(Schema.Natural),
  protocol: Schema.optional(Schema.Natural),
  project_check_failure: Schema.Natural,
  review_inconclusive: Schema.Natural,
  delivery_failure: Schema.Natural,
  unknown: Schema.Natural,
});

export const campaignEvidencePageSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignId: Schema.String,
  goalId: Schema.String,
  goalVersion: Schema.Int,
  cursor: Schema.NullOr(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
  progress: campaignProgress,
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
  runs: Schema.Array(evidenceRun),
  aggregates: Schema.Array(evidenceAggregate),
  totals: Schema.NullOr(
    Schema.Struct({
      invocations: Schema.Natural,
      elapsedMs: Schema.NullOr(Schema.Natural),
      reviewCycles: Schema.Natural,
      repairBatches: Schema.Natural,
      blockedProposals: Schema.Natural,
      guardianTouches: Schema.Natural,
      acceptedDeliveries: Schema.Natural,
      terminalTaskCounts: terminalTaskCounts,
      usage: usageAmounts,
    }),
  ),
  touches: Schema.Array(campaignTouch),
  deliveries: Schema.Array(acceptedDelivery),
});

export type CampaignEvidencePage = Schema.Schema.Type<typeof campaignEvidencePageSchema>;
export type CampaignEvidenceRun = CampaignEvidencePage["runs"][number];
export type CampaignEvidenceAggregate = CampaignEvidencePage["aggregates"][number];
export type CampaignEvidenceTotals = NonNullable<CampaignEvidencePage["totals"]>;
export type CampaignEvidenceTouch = CampaignEvidencePage["touches"][number];
export type CampaignAcceptedDelivery = CampaignEvidencePage["deliveries"][number];

export type CampaignEvidenceUsage = UsageAmounts;

type AllTerminalTaskCounts = {
  readonly [classification in TaskBlockerClassification]: number;
};
type LegacyTerminalTaskClassification =
  | "elapsed_budget"
  | "implementation_budget"
  | "invalid_phase"
  | "missing_evidence"
  | "provider_failure"
  | "project_check_failure"
  | "review_inconclusive"
  | "delivery_failure"
  | "unknown";
export type CampaignEvidenceTerminalTaskCounts = Pick<
  AllTerminalTaskCounts,
  LegacyTerminalTaskClassification
> &
  Partial<Omit<AllTerminalTaskCounts, LegacyTerminalTaskClassification>>;

export interface CampaignEvidenceCampaign {
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly publishedAtEpochMs: number;
  readonly revision: number;
  readonly updatedAtEpochMs: number;
}

export interface CampaignEvidenceProposal {
  readonly proposalId: string;
  readonly sequence: number;
  readonly outcomeId: string;
  readonly status: "planned" | "ready" | "blocked" | "superseded";
  readonly blocker: string | null;
  readonly taskId: string | null;
  readonly supersededByProposalId?: string;
  readonly supersedesProposalId?: string;
  readonly admittedAtEpochMs: number;
  readonly replacement?: {
    readonly assessmentId: string;
    readonly evidenceHash: string;
  };
}

export interface CampaignEvidenceDecisionTouch {
  readonly touchId: string;
  readonly goalVersion: number;
  readonly type: "decision" | "warning";
  readonly occurredAtEpochMs: number;
}

export type CampaignEvidenceSource = UsageReportSource;

export interface CampaignEvidenceSourcesPage {
  readonly campaign: CampaignEvidenceCampaign;
  readonly proposals: readonly CampaignEvidenceProposal[];
  readonly decisionTouches: readonly CampaignEvidenceDecisionTouch[];
  readonly sources: readonly CampaignEvidenceSource[];
  readonly campaignRuns: readonly CampaignEvidenceRun[];
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export interface CampaignEvidencePageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export class CampaignEvidenceCursorError extends Error {
  constructor() {
    super("campaign evidence cursor is invalid");
    this.name = "CampaignEvidenceCursorError";
  }
}
