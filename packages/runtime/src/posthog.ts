import { createHash } from "node:crypto";
import { listCampaignIds, lookupCampaign } from "./campaign.js";
import { lookupCampaignEvidence } from "./campaign-evidence.js";
import type {
  CampaignAcceptedDelivery,
  CampaignEvidencePage,
  CampaignEvidenceRun,
  CampaignEvidenceTouch,
} from "@usine/task-authority";
import type { CampaignResource } from "@usine/task-authority";

const DEFAULT_POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
const POSTHOG_CAPTURE_TIMEOUT_MS = 10_000;

type PostHogProperty = string | number | boolean | null;

export interface PostHogEvent {
  readonly event: string;
  readonly distinctId: string;
  readonly insertId: string;
  readonly occurredAtEpochMs: number | null;
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
  if (!apiKey) return null;
  return {
    apiKey,
    captureUrl: environment.USINE_POSTHOG_API_URL?.trim() || DEFAULT_POSTHOG_CAPTURE_URL,
  };
}

export function campaignEvidenceToPostHogEvents(
  campaign: CampaignResource,
  evidence: CampaignEvidencePage,
): readonly PostHogEvent[] {
  const distinctId = campaign.campaignId;
  const events: PostHogEvent[] = [];
  const progressProperties = {
    schema_version: evidence.schemaVersion,
    campaign_id: campaign.campaignId,
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
    merged_deliveries: evidence.deliveries.filter((delivery) => delivery.merged).length,
    successful_runs: evidence.runs.filter((run) => run.outcome === "succeeded").length,
    failed_runs: evidence.runs.filter((run) => run.outcome === "failed").length,
    cancelled_runs: evidence.runs.filter((run) => run.outcome === "cancelled").length,
    blocked_runs: evidence.runs.filter((run) => run.outcome === "blocked").length,
    unknown_runs: evidence.runs.filter((run) => run.outcome === "unknown").length,
    task_count: new Set(evidence.runs.map((run) => run.taskId)).size,
    blocked_tasks: new Set(
      evidence.runs.filter((run) => run.taskState === "blocked").map((run) => run.taskId),
    ).size,
    input_tokens: evidence.totals.usage.inputTokens,
    cached_input_tokens: evidence.totals.usage.cachedInputTokens,
    uncached_input_tokens: evidence.totals.usage.uncachedInputTokens,
    cache_write_input_tokens: evidence.totals.usage.cacheWriteInputTokens,
    output_tokens: evidence.totals.usage.outputTokens,
    reasoning_output_tokens: evidence.totals.usage.reasoningOutputTokens,
    token_coverage: evidence.totals.usage.coverage,
    evidence_coverage: evidence.coverage,
  } satisfies Readonly<Record<string, PostHogProperty>>;
  events.push({
    event: "usine_campaign_progress",
    distinctId,
    insertId: stableInsertId("progress", progressProperties),
    occurredAtEpochMs: latestEvidenceTimestamp(evidence),
    properties: progressProperties,
  });

  for (const run of evidence.runs) events.push(roleRunEvent(distinctId, run));
  for (const touch of evidence.touches) events.push(touchEvent(distinctId, touch));
  for (const delivery of evidence.deliveries) events.push(deliveryEvent(distinctId, delivery));
  return events;
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
  const evidence = await lookupCampaignEvidence(stateDirectory, campaignId);
  if (!campaign || !evidence) return;
  await sendPostHogEvents(
    config,
    campaignEvidenceToPostHogEvents(campaign, evidence),
    fetchImplementation,
  );
}

export async function sendPostHogEvents(
  config: PostHogCaptureConfig,
  events: readonly PostHogEvent[],
  fetchImplementation: PostHogFetch = fetch,
): Promise<void> {
  if (events.length === 0) return;
  const captureUrl = new URL(config.captureUrl);
  if (captureUrl.protocol !== "http:" && captureUrl.protocol !== "https:")
    throw new Error("PostHog capture URL must use HTTP or HTTPS");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POSTHOG_CAPTURE_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(captureUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        batch: events.map((event) => ({
          event: event.event,
          distinct_id: event.distinctId,
          properties: { $insert_id: event.insertId, ...event.properties },
          ...(event.occurredAtEpochMs === null
            ? {}
            : { timestamp: new Date(event.occurredAtEpochMs).toISOString() }),
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("PostHog capture request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export interface CampaignEvidenceRecorder {
  readonly schedule: (campaignId: string) => void;
  readonly scheduleAll: () => void;
}

export function createCampaignEvidenceRecorder(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
  onFailure: (error: unknown) => void = () =>
    console.error("PostHog recording failed; factory lifecycle continues"),
): CampaignEvidenceRecorder {
  if (!postHogConfigFromEnvironment(environment))
    return { schedule: () => undefined, scheduleAll: () => undefined };

  const requested = new Set<string>();
  let running = false;
  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (requested.size > 0) {
        const campaignIds = [...requested].toSorted();
        requested.clear();
        for (const campaignId of campaignIds) {
          try {
            await captureCampaignEvidence(stateDirectory, campaignId, environment);
          } catch (error) {
            onFailure(error);
          }
        }
      }
    } finally {
      running = false;
      if (requested.size > 0) void drain();
    }
  };
  return {
    schedule: (campaignId) => {
      requested.add(campaignId);
      void drain();
    },
    scheduleAll: () => {
      void listCampaignIds(stateDirectory)
        .then((campaignIds) => {
          for (const campaignId of campaignIds) requested.add(campaignId);
          void drain();
        })
        .catch(onFailure);
    },
  };
}

function roleRunEvent(distinctId: string, run: CampaignEvidenceRun): PostHogEvent {
  const properties = {
    schema_version: 1,
    campaign_id: distinctId,
    goal_version: run.goalVersion,
    outcome_id: run.outcomeId,
    task_id: run.taskId,
    role: run.role,
    activation: run.activation,
    review_cycle: run.reviewCycle,
    repository_id: run.repositoryId,
    repository: run.repository,
    provider: run.provider,
    adapter: run.adapter,
    model: run.model,
    outcome: run.outcome,
    task_state: run.taskState,
    task_blocker: run.taskBlocker,
    elapsed_ms: run.elapsedMs,
    input_tokens: run.usage.inputTokens,
    cached_input_tokens: run.usage.cachedInputTokens,
    uncached_input_tokens: run.usage.uncachedInputTokens,
    cache_write_input_tokens: run.usage.cacheWriteInputTokens,
    output_tokens: run.usage.outputTokens,
    reasoning_output_tokens: run.usage.reasoningOutputTokens,
    token_coverage: run.usage.coverage,
  } satisfies Readonly<Record<string, PostHogProperty>>;
  return {
    event: "usine_campaign_role_run",
    distinctId,
    insertId: `role-run:${run.invocationId}`,
    occurredAtEpochMs: run.occurredAtEpochMs,
    properties,
  };
}

function touchEvent(distinctId: string, touch: CampaignEvidenceTouch): PostHogEvent {
  return {
    event: "usine_campaign_guardian_touch",
    distinctId,
    insertId: `touch:${touch.touchId}`,
    occurredAtEpochMs: touch.occurredAtEpochMs,
    properties: {
      schema_version: 1,
      campaign_id: distinctId,
      goal_version: touch.goalVersion,
      touch_type: touch.type,
    },
  };
}

function deliveryEvent(distinctId: string, delivery: CampaignAcceptedDelivery): PostHogEvent {
  return {
    event: "usine_campaign_delivery",
    distinctId,
    insertId: `delivery:${delivery.taskId}`,
    occurredAtEpochMs: latestDeliveryTimestamp(delivery),
    properties: {
      schema_version: 1,
      campaign_id: distinctId,
      goal_version: delivery.goalVersion,
      outcome_id: delivery.outcomeId,
      task_id: delivery.taskId,
      effect: delivery.effect,
      pull_request: delivery.pullRequest,
      merged: delivery.merged,
      merge_commit_present: delivery.mergeCommitSha !== null,
    },
  };
}

function latestEvidenceTimestamp(evidence: CampaignEvidencePage): number | null {
  const timestamps = [
    ...evidence.runs.map((run) => run.occurredAtEpochMs),
    ...evidence.touches.map((touch) => touch.occurredAtEpochMs),
    ...evidence.deliveries.map(latestDeliveryTimestamp),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

function latestDeliveryTimestamp(delivery: CampaignAcceptedDelivery): number | null {
  return delivery.occurredAtEpochMs;
}

function stableInsertId(
  kind: string,
  properties: Readonly<Record<string, PostHogProperty>>,
): string {
  const digest = createHash("sha256").update(JSON.stringify(properties), "utf8").digest("hex");
  return `${kind}:${properties.campaign_id}:${digest}`;
}
