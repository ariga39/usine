import { Schema } from "effect";
import type { UsageAmounts } from "./usage-report.js";

const exactSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

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
  taskId: Schema.String,
  pullRequest: Schema.NullOr(Schema.Natural),
  repositoryId: Schema.String,
  repository: Schema.String,
  role: Schema.Literals(["implementer", "reviewer"]),
  activation: Schema.NullOr(Schema.Natural),
  reviewCycle: Schema.NullOr(Schema.Natural),
  provider: Schema.String,
  adapter: Schema.String,
  model: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled", "blocked", "unknown"]),
  occurredAtEpochMs: Schema.Int,
  elapsedMs: Schema.NullOr(Schema.Natural),
  usage: usageAmounts,
});

const evidenceAggregate = Schema.Struct({
  goalVersion: Schema.Int,
  outcomeId: Schema.String,
  taskId: Schema.String,
  role: Schema.Literals(["implementer", "reviewer"]),
  model: Schema.String,
  provider: Schema.String,
  adapter: Schema.String,
  invocations: Schema.Natural,
  elapsedMs: Schema.NullOr(Schema.Natural),
  usage: usageAmounts,
});

const campaignTouch = Schema.Struct({
  touchId: Schema.String,
  goalVersion: Schema.Int,
  type: Schema.Literals(["plan", "decision"]),
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
});

export const campaignEvidencePageSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignId: Schema.String,
  goalId: Schema.String,
  goalVersion: Schema.Int,
  cursor: Schema.NullOr(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
  runs: Schema.Array(evidenceRun),
  aggregates: Schema.Array(evidenceAggregate),
  totals: Schema.Struct({
    invocations: Schema.Natural,
    elapsedMs: Schema.NullOr(Schema.Natural),
    reviewCycles: Schema.Natural,
    repairBatches: Schema.Natural,
    blockedProposals: Schema.Natural,
    rejectedProposals: Schema.Natural,
    guardianTouches: Schema.Natural,
    acceptedDeliveries: Schema.Natural,
    usage: usageAmounts,
  }),
  touches: Schema.Array(campaignTouch),
  deliveries: Schema.Array(acceptedDelivery),
});

export type CampaignEvidencePage = Schema.Schema.Type<typeof campaignEvidencePageSchema>;
export type CampaignEvidenceRun = CampaignEvidencePage["runs"][number];
export type CampaignEvidenceAggregate = CampaignEvidencePage["aggregates"][number];
export type CampaignEvidenceTotals = CampaignEvidencePage["totals"];
export type CampaignEvidenceTouch = CampaignEvidencePage["touches"][number];
export type CampaignAcceptedDelivery = CampaignEvidencePage["deliveries"][number];

export type CampaignEvidenceUsage = UsageAmounts;
