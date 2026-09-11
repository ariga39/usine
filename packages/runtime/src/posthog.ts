import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { listCampaignIds, lookupCampaign } from "./campaign.js";
import { lookupCampaignEvidence, MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE } from "./campaign-evidence.js";
import { openSqliteDatabase, posthogCaptureAcknowledgements } from "@usine/task-authority";
import type {
  CampaignAcceptedDelivery,
  CampaignEvidencePage,
  CampaignEvidenceRun,
  CampaignEvidenceTouch,
  CampaignResource,
} from "@usine/task-authority";
import { TASK_TERMINAL_FAILURE_CLASSES } from "@usine/task-authority";

const DEFAULT_POSTHOG_BATCH_URL = "https://us.i.posthog.com/batch/";
const POSTHOG_CAPTURE_TIMEOUT_MS = 10_000;
type PostHogProperty = string | number | boolean | null;
type PostHogEventName =
  | "usine_campaign_progress"
  | "$ai_generation"
  | "usine_campaign_guardian_touch"
  | "usine_campaign_warning"
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
  readonly deployment: string;
}
export type PostHogFetch = typeof fetch;

const captureQueues = new Map<string, Promise<void>>();

export function postHogConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): PostHogCaptureConfig | null {
  const apiKey = environment.USINE_POSTHOG_API_KEY?.trim();
  const deployment = environment.USINE_POSTHOG_DEPLOYMENT?.trim();
  return apiKey && deployment
    ? {
        apiKey,
        captureUrl: environment.USINE_POSTHOG_API_URL?.trim() || DEFAULT_POSTHOG_BATCH_URL,
        deployment,
      }
    : null;
}

export function campaignEvidenceToPostHogEvents(
  campaign: CampaignResource,
  evidence: CampaignEvidencePage,
  deployment: string,
): readonly PostHogEvent[] {
  const deploymentLabel = deployment.trim();
  if (!deploymentLabel) return [];
  const distinctId = campaign.campaignId;
  const terminalFailureProperties: Record<string, number> = {};
  for (const classification of TASK_TERMINAL_FAILURE_CLASSES) {
    terminalFailureProperties[`terminal_tasks_${classification}`] =
      evidence.totals.terminalTaskCounts[classification] ?? 0;
  }
  const properties = {
    deployment: deploymentLabel,
    schema_version: evidence.schemaVersion,
    campaign_id: distinctId,
    campaign_revision: evidence.progress.revision,
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
    terminal_reason: campaign.decisionRequest?.reason ?? null,
    terminal_tasks_elapsed_budget: evidence.totals.terminalTaskCounts.elapsed_budget,
    terminal_tasks_implementation_budget: evidence.totals.terminalTaskCounts.implementation_budget,
    terminal_tasks_invalid_phase: evidence.totals.terminalTaskCounts.invalid_phase,
    terminal_tasks_missing_evidence: evidence.totals.terminalTaskCounts.missing_evidence,
    terminal_tasks_provider_failure: evidence.totals.terminalTaskCounts.provider_failure,
    terminal_tasks_project_check_failure: evidence.totals.terminalTaskCounts.project_check_failure,
    terminal_tasks_review_inconclusive: evidence.totals.terminalTaskCounts.review_inconclusive,
    terminal_tasks_delivery_failure: evidence.totals.terminalTaskCounts.delivery_failure,
    ...terminalFailureProperties,
    input_tokens: evidence.totals.usage.inputTokens,
    cached_input_tokens: evidence.totals.usage.cachedInputTokens,
    uncached_input_tokens: evidence.totals.usage.uncachedInputTokens,
    cache_write_input_tokens: evidence.totals.usage.cacheWriteInputTokens,
    output_tokens: evidence.totals.usage.outputTokens,
    reasoning_output_tokens: evidence.totals.usage.reasoningOutputTokens,
    token_coverage: evidence.totals.usage.coverage,
    evidence_coverage: evidence.coverage,
  } satisfies Readonly<Record<string, PostHogProperty>>;
  const timestamp = timestampForEpochMs(evidence.progress.occurredAtEpochMs);
  return [
    ...(evidence.cursor === null
      ? [makeEvent("usine_campaign_progress", distinctId, timestamp, properties)]
      : []),
    ...evidence.runs
      .filter((run) => run.outcome !== "unknown")
      .map((run) => roleRunEvent(deploymentLabel, distinctId, run)),
    ...(evidence.cursor === null
      ? evidence.touches.flatMap((touch) =>
          touch.type === "warning"
            ? [warningEvent(deploymentLabel, distinctId, touch)]
            : [touchEvent(deploymentLabel, distinctId, touch)],
        )
      : []),
    ...evidence.deliveries.map((delivery) => deliveryEvent(deploymentLabel, distinctId, delivery)),
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
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  return enqueueCapture(databasePath, async () => {
    const campaign = await lookupCampaign(stateDirectory, campaignId);
    let evidence = await lookupCampaignEvidence(stateDirectory, campaignId);
    if (!campaign || !evidence) return;
    const events: PostHogEvent[] = [];
    while (evidence) {
      events.push(...campaignEvidenceToPostHogEvents(campaign, evidence, config.deployment));
      if (evidence.nextCursor === null) break;
      evidence = await lookupCampaignEvidence(stateDirectory, campaignId, {
        cursor: evidence.nextCursor,
        limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
      });
    }
    const pending = await unacknowledgedEvents(databasePath, config.deployment, events);
    if (pending.length === 0) return;
    await sendPostHogEvents(config, pending, fetchImplementation);
    await acknowledgeEvents(databasePath, config.deployment, pending);
  });
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

function roleRunEvent(
  deployment: string,
  distinctId: string,
  run: CampaignEvidenceRun,
): PostHogEvent {
  const roleRunUuid = stableUuid("$ai_generation", {
    deployment,
    campaign_id: distinctId,
    invocation_id: run.invocationId,
  });
  const cacheDimensionsKnown =
    run.usage.cachedInputTokens !== null && run.usage.uncachedInputTokens !== null;
  const model = projectedIdentity(run.actualModel, run.configuredModel);
  const provider = projectedIdentity(run.actualProvider, run.configuredProvider);
  const properties = {
    deployment,
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
    configured_provider: run.configuredProvider,
    configured_model: run.configuredModel,
    actual_provider: run.actualProvider,
    actual_model: run.actualModel,
    provider_identity_source: provider.source,
    model_identity_source: model.source,
    $ai_provider: provider.value,
    adapter: run.adapter,
    profile: run.profile ?? "unavailable",
    service_tier: run.serviceTier ?? "unavailable",
    reasoning_effort: run.reasoningEffort ?? "unavailable",
    $ai_model: model.value,
    outcome: run.outcome,
    failure_class: run.failureClass ?? null,
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

function projectedIdentity(
  actual: string,
  configured: string,
): { readonly value: string; readonly source: "provider" | "configured" | "unavailable" } {
  if (actual !== "unavailable") return { value: actual, source: "provider" };
  if (configured !== "unavailable") return { value: configured, source: "configured" };
  return { value: "unavailable", source: "unavailable" };
}

function touchEvent(
  deployment: string,
  distinctId: string,
  touch: CampaignEvidenceTouch,
): PostHogEvent {
  return makeEvent(
    "usine_campaign_guardian_touch",
    distinctId,
    timestampForEpochMs(touch.occurredAtEpochMs),
    {
      deployment,
      schema_version: 1,
      campaign_id: distinctId,
      touch_id: touch.touchId,
      goal_version: touch.goalVersion,
      touch_type: touch.type,
    },
  );
}

function warningEvent(
  deployment: string,
  distinctId: string,
  touch: CampaignEvidenceTouch,
): PostHogEvent {
  return makeEvent(
    "usine_campaign_warning",
    distinctId,
    timestampForEpochMs(touch.occurredAtEpochMs),
    {
      deployment,
      schema_version: 1,
      campaign_id: distinctId,
      warning_id: touch.touchId,
      goal_version: touch.goalVersion,
    },
  );
}

function deliveryEvent(
  deployment: string,
  distinctId: string,
  delivery: CampaignAcceptedDelivery,
): PostHogEvent {
  return makeEvent(
    "usine_campaign_delivery",
    distinctId,
    timestampForEpochMs(delivery.occurredAtEpochMs),
    {
      deployment,
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
  );
}

function makeEvent(
  event: PostHogEventName,
  distinctId: string,
  timestamp: string | null,
  properties: Readonly<Record<string, PostHogProperty>>,
): PostHogEvent {
  return { event, distinctId, uuid: stableUuid(event, properties), timestamp, properties };
}

function enqueueCapture<T>(stateDirectory: string, operation: () => Promise<T>): Promise<T> {
  const previous = captureQueues.get(stateDirectory) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  captureQueues.set(stateDirectory, settled);
  void settled.then(() => {
    if (captureQueues.get(stateDirectory) === settled) captureQueues.delete(stateDirectory);
  });
  return current;
}

async function unacknowledgedEvents(
  databasePath: string,
  deployment: string,
  events: readonly PostHogEvent[],
): Promise<PostHogEvent[]> {
  if (events.length === 0) return [];
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const acknowledged = await handle.database
      .select({ eventUuid: posthogCaptureAcknowledgements.eventUuid })
      .from(posthogCaptureAcknowledgements)
      .where(eq(posthogCaptureAcknowledgements.deployment, deployment));
    const acknowledgedUuids = new Set(acknowledged.map((row) => row.eventUuid));
    return events.filter((event) => !acknowledgedUuids.has(event.uuid));
  } finally {
    handle.close();
  }
}

async function acknowledgeEvents(
  databasePath: string,
  deployment: string,
  events: readonly PostHogEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const handle = openSqliteDatabase(databasePath);
  try {
    await handle.exclusiveTransaction(() =>
      handle.database
        .insert(posthogCaptureAcknowledgements)
        .values(
          [...new Set(events.map((event) => event.uuid))].map((eventUuid) => ({
            deployment,
            eventUuid,
          })),
        )
        .onConflictDoNothing(),
    );
  } finally {
    handle.close();
  }
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

function timestampForEpochMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
