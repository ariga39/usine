import { createHash } from "node:crypto";
import { listCampaignIds, lookupCampaign } from "./campaign.js";
import { lookupCampaignEvidence, MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE } from "./campaign-evidence.js";
import type {
  CampaignAcceptedDelivery,
  CampaignEvidencePage,
  CampaignEvidenceRun,
  CampaignEvidenceTouch,
  CampaignResource,
} from "@usine/task-authority";

const DEFAULT_POSTHOG_BATCH_URL = "https://us.i.posthog.com/batch/";
const POSTHOG_CAPTURE_TIMEOUT_MS = 10_000;
type PostHogProperty = string | number | boolean | null;
type PostHogEventName =
  | "usine_campaign_progress"
  | "$ai_generation"
  | "usine_campaign_guardian_touch"
  | "usine_campaign_delivery";

export interface PostHogEvent {
  readonly event: PostHogEventName;
  readonly distinctId: string;
  readonly uuid: string;
  readonly timestamp: string | null;
  readonly properties: Readonly<Record<string, PostHogProperty>>;
}
export interface PostHogCaptureConfig {
  readonly apiKey: string;
  readonly captureUrl: string;
}
export type PostHogFetch = typeof fetch;

export function postHogConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): PostHogCaptureConfig | null {
  const apiKey = environment.USINE_POSTHOG_API_KEY?.trim();
  return apiKey
    ? { apiKey, captureUrl: environment.USINE_POSTHOG_API_URL?.trim() || DEFAULT_POSTHOG_BATCH_URL }
    : null;
}

export function campaignEvidenceToPostHogEvents(
  campaign: CampaignResource,
  evidence: CampaignEvidencePage,
): readonly PostHogEvent[] {
  const distinctId = campaign.campaignId;
  const properties = {
    schema_version: evidence.schemaVersion,
    campaign_id: distinctId,
    goal_id: campaign.goalId,
    goal_version: campaign.goalVersion,
    campaign_status: campaign.status,
    plan_handed_off: campaign.planHandedOff,
    proposal_count: campaign.proposals?.length ?? 0,
    planned_proposals:
      campaign.proposals?.filter((proposal) => proposal.status === "planned").length ?? 0,
    ready_proposals:
      campaign.proposals?.filter((proposal) => proposal.status === "ready").length ?? 0,
    blocked_proposals: evidence.totals.blockedProposals,
    accepted_outcomes: campaign.outcomes.filter((outcome) => outcome.status === "accepted").length,
    live_outcomes: campaign.outcomes.filter((outcome) => outcome.status === "planned").length,
    invocations: evidence.totals.invocations,
    elapsed_ms: evidence.totals.elapsedMs,
    review_cycles: evidence.totals.reviewCycles,
    repair_batches: evidence.totals.repairBatches,
    guardian_touches: evidence.totals.guardianTouches,
    accepted_deliveries: evidence.totals.acceptedDeliveries,
    input_tokens: evidence.totals.usage.inputTokens,
    cached_input_tokens: evidence.totals.usage.cachedInputTokens,
    uncached_input_tokens: evidence.totals.usage.uncachedInputTokens,
    cache_write_input_tokens: evidence.totals.usage.cacheWriteInputTokens,
    output_tokens: evidence.totals.usage.outputTokens,
    reasoning_output_tokens: evidence.totals.usage.reasoningOutputTokens,
    token_coverage: evidence.totals.usage.coverage,
    evidence_coverage: evidence.coverage,
  } satisfies Readonly<Record<string, PostHogProperty>>;
  const timestamp = timestampForEvidence(evidence);
  return [
    ...(evidence.cursor === null
      ? [makeEvent("usine_campaign_progress", distinctId, timestamp, properties)]
      : []),
    ...evidence.runs.map((run) => roleRunEvent(distinctId, run)),
    ...(evidence.cursor === null
      ? evidence.touches.map((touch) => touchEvent(distinctId, touch))
      : []),
    ...evidence.deliveries.map((delivery) => deliveryEvent(distinctId, delivery, timestamp)),
  ];
}

export async function captureCampaignEvidence(
  stateDirectory: string,
  campaignId: string,
  environment: NodeJS.ProcessEnv,
  fetchImplementation: PostHogFetch = fetch,
): Promise<void> {
  const config = postHogConfigFromEnvironment(environment);
  if (!config) return;
  const campaign = await lookupCampaign(stateDirectory, campaignId);
  let evidence = await lookupCampaignEvidence(stateDirectory, campaignId);
  if (!campaign || !evidence) return;
  const events: PostHogEvent[] = [];
  while (evidence) {
    events.push(...campaignEvidenceToPostHogEvents(campaign, evidence));
    if (evidence.nextCursor === null) break;
    evidence = await lookupCampaignEvidence(stateDirectory, campaignId, {
      cursor: evidence.nextCursor,
      limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
    });
  }
  await sendPostHogEvents(config, events, fetchImplementation);
}

export async function recordAllCampaignEvidence(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (!postHogConfigFromEnvironment(environment)) return;
  for (const campaignId of await listCampaignIds(stateDirectory)) {
    try {
      await captureCampaignEvidence(stateDirectory, campaignId, environment);
    } catch (error) {
      reportPostHogFailure(error);
    }
  }
}

export async function sendPostHogEvents(
  config: PostHogCaptureConfig,
  events: readonly PostHogEvent[],
  fetchImplementation: PostHogFetch = fetch,
): Promise<void> {
  if (events.length === 0) return;
  const captureUrl = new URL(config.captureUrl);
  if (captureUrl.protocol !== "http:" && captureUrl.protocol !== "https:")
    throw new Error("PostHog batch URL must use HTTP or HTTPS");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POSTHOG_CAPTURE_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(captureUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        batch: events.map((event) => ({
          uuid: event.uuid,
          timestamp: event.timestamp ?? undefined,
          event: event.event,
          properties: {
            distinct_id: event.distinctId,
            $process_person_profile: false,
            ...event.properties,
          },
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("PostHog batch request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export function reportPostHogFailure(_error: unknown): void {
  console.error("PostHog recording failed; factory lifecycle continues");
}

function roleRunEvent(distinctId: string, run: CampaignEvidenceRun): PostHogEvent {
  const roleRunUuid = stableUuid("$ai_generation", {
    campaign_id: distinctId,
    invocation_id: run.invocationId,
  });
  const cacheDimensionsKnown =
    run.usage.cachedInputTokens !== null && run.usage.uncachedInputTokens !== null;
  const properties = {
    schema_version: 1,
    campaign_id: distinctId,
    invocation_id: run.invocationId,
    $ai_trace_id: roleRunUuid,
    goal_version: run.goalVersion,
    outcome_id: run.outcomeId,
    task_id: run.taskId,
    pull_request: run.pullRequest,
    role: run.role,
    activation: run.activation,
    review_cycle: run.reviewCycle,
    repository_id: run.repositoryId,
    repository: run.repository,
    $ai_provider: run.provider,
    adapter: run.adapter,
    $ai_model: run.model,
    outcome: run.outcome,
    aggregation_scope: "role_run",
    elapsed_ms: run.elapsedMs,
    $ai_latency: run.elapsedMs === null ? null : run.elapsedMs / 1000,
    $ai_input_tokens: run.usage.inputTokens,
    $ai_cache_read_input_tokens: run.usage.cachedInputTokens,
    uncached_input_tokens: run.usage.uncachedInputTokens,
    $ai_cache_creation_input_tokens: run.usage.cacheWriteInputTokens,
    $ai_output_tokens: run.usage.outputTokens,
    reasoning_output_tokens: run.usage.reasoningOutputTokens,
    token_coverage: run.usage.coverage,
    ...(cacheDimensionsKnown ? { $ai_cache_reporting_exclusive: false } : {}),
  } satisfies Readonly<Record<string, PostHogProperty>>;
  return {
    event: "$ai_generation",
    distinctId,
    uuid: roleRunUuid,
    timestamp: timestampForEpochMs(run.occurredAtEpochMs),
    properties,
  };
}

function touchEvent(distinctId: string, touch: CampaignEvidenceTouch): PostHogEvent {
  return makeEvent(
    "usine_campaign_guardian_touch",
    distinctId,
    timestampForEpochMs(touch.occurredAtEpochMs),
    {
      schema_version: 1,
      campaign_id: distinctId,
      touch_id: touch.touchId,
      goal_version: touch.goalVersion,
      touch_type: touch.type,
    },
  );
}

function deliveryEvent(
  distinctId: string,
  delivery: CampaignAcceptedDelivery,
  timestamp: string | null,
): PostHogEvent {
  return makeEvent("usine_campaign_delivery", distinctId, timestamp, {
    schema_version: 1,
    campaign_id: distinctId,
    goal_version: delivery.goalVersion,
    outcome_id: delivery.outcomeId,
    task_id: delivery.taskId,
    effect: delivery.effect,
    pull_request: delivery.pullRequest,
    merged: delivery.merged,
    merge_commit_present: delivery.mergeCommitSha !== null,
  });
}

function makeEvent(
  event: PostHogEventName,
  distinctId: string,
  timestamp: string | null,
  properties: Readonly<Record<string, PostHogProperty>>,
): PostHogEvent {
  return { event, distinctId, uuid: stableUuid(event, properties), timestamp, properties };
}

function stableUuid(
  event: PostHogEventName,
  properties: Readonly<Record<string, PostHogProperty>>,
): string {
  const hex = createHash("sha256")
    .update(`${event}\u0000${JSON.stringify(properties)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const variant = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function timestampForEvidence(evidence: CampaignEvidencePage): string | null {
  const timestamps = [
    ...evidence.runs.map((run) => run.occurredAtEpochMs),
    ...evidence.touches.map((touch) => touch.occurredAtEpochMs),
  ];
  return timestamps.length === 0 ? null : timestampForEpochMs(Math.max(...timestamps));
}
function timestampForEpochMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
