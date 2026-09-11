import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import { startUsineServer } from "../packages/runtime/src/server.js";
import {
  captureCampaignEvidence,
  campaignEvidenceToPostHogEvents,
  postHogConfigFromEnvironment,
} from "../packages/runtime/src/posthog.js";
import type { CampaignEvidencePage, CampaignResource } from "@usine/task-authority";
import {
  handoffCampaign,
  proposeCampaign,
  publishCampaign,
  registerRepository,
} from "../apps/cli/src/server-client.js";
import type { CampaignOutcomeAssessor } from "../packages/runtime/src/campaign-assessor.js";

interface CapturedBatchEvent {
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly event?: string;
  readonly properties?: Record<string, unknown>;
}
interface FakePostHog {
  readonly server: ReturnType<typeof createServer>;
  readonly requests: Array<{ url?: string; batch?: CapturedBatchEvent[] }>;
  readonly status: number;
}

function campaignRevision(event: CapturedBatchEvent): number {
  const value = event.properties?.campaign_revision;
  if (typeof value !== "number") throw new Error("Campaign revision is missing");
  return value;
}

const servers: Array<ReturnType<typeof createServer>> = [];
const usineServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (usineServers.length > 0) await usineServers.pop()?.close();
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function campaign(): CampaignResource {
  return {
    schemaVersion: 1,
    campaignId: "campaign-391:v1",
    goalId: "campaign-391",
    goalVersion: 1,
    contractHash: "private-contract-hash",
    objective: "private objective",
    outcomes: [
      {
        id: "outcome-1",
        title: "private outcome",
        acceptance: ["private acceptance"],
        dependsOn: [],
        parentId: null,
        status: "accepted",
        evidence: null,
      },
    ],
    authority: { source: "private source", publish: true, delivery: true, merge: true },
    status: "accepted",
    planHandedOff: true,
    decisionRequest: null,
    revision: 4,
    proposals: [
      {
        proposalId: "proposal-1",
        outcomeId: "outcome-1",
        sequence: 1,
        status: "ready",
        blocker: "private diagnostic",
        ready: null,
      },
    ],
  };
}

function evidence(): CampaignEvidencePage & {
  totals: NonNullable<CampaignEvidencePage["totals"]>;
} {
  const usage = {
    inputTokens: 10,
    cachedInputTokens: 2,
    uncachedInputTokens: 8,
    cacheWriteInputTokens: 1,
    outputTokens: 5,
    reasoningOutputTokens: 3,
    coverage: "complete" as const,
  };
  return {
    schemaVersion: 1,
    campaignId: "campaign-391:v1",
    goalId: "campaign-391",
    goalVersion: 1,
    cursor: null,
    nextCursor: null,
    progress: { revision: 4, occurredAtEpochMs: 1_700_000_000_200 },
    coverage: "complete",
    runs: [
      {
        invocationId: "task-1:implementer:1:session-1",
        goalVersion: 1,
        outcomeId: "outcome-1",
        taskId: "task-1",
        pullRequest: 42,
        repositoryId: "repo-1",
        repository: "example/repo",
        role: "implementer",
        activation: 1,
        reviewCycle: null,
        configuredProvider: "configured-provider",
        configuredModel: "configured-model",
        actualProvider: "observed-provider",
        actualModel: "observed-model",
        provider: "observed-provider",
        adapter: "sdk",
        model: "observed-model",
        outcome: "succeeded",
        occurredAtEpochMs: 1_700_000_000_100,
        elapsedMs: 900,
        usage,
      },
    ],
    aggregates: [],
    totals: {
      invocations: 1,
      elapsedMs: 900,
      reviewCycles: 1,
      repairBatches: 0,
      blockedProposals: 0,
      guardianTouches: 1,
      acceptedDeliveries: 1,
      terminalTaskCounts: {
        elapsed_budget: 0,
        implementation_budget: 0,
        invalid_phase: 0,
        missing_evidence: 0,
        provider_failure: 0,
        project_check_failure: 0,
        review_inconclusive: 0,
        delivery_failure: 0,
        unknown: 0,
      },
      usage,
    },
    touches: [
      { touchId: "touch-1", goalVersion: 1, type: "plan", occurredAtEpochMs: 1_700_000_000_000 },
    ],
    deliveries: [
      {
        taskId: "task-1",
        goalVersion: 1,
        outcomeId: "outcome-1",
        effect: "github",
        pullRequest: 42,
        sha: "a".repeat(40),
        url: "https://private.example/pull/42",
        attestationId: "private-attestation",
        merged: true,
        mergeCommitSha: "b".repeat(40),
        occurredAtEpochMs: 1_700_000_000_200,
      },
    ],
  };
}

test("maps fixed Campaign evidence fields without private payloads", () => {
  const first = campaignEvidenceToPostHogEvents(campaign(), evidence(), "deployment-test");
  const second = campaignEvidenceToPostHogEvents(campaign(), evidence(), "deployment-test");
  const roleRun = first.find((event) => event.event === "$ai_generation")!;
  const delivery = first.find((event) => event.event === "usine_campaign_delivery")!;
  expect(first).toEqual(second);
  expect(roleRun).toMatchObject({
    timestamp: "2023-11-14T22:13:20.100Z",
    properties: {
      $ai_provider: "observed-provider",
      $ai_model: "observed-model",
      configured_provider: "configured-provider",
      configured_model: "configured-model",
      actual_provider: "observed-provider",
      actual_model: "observed-model",
      provider_identity_source: "provider",
      model_identity_source: "provider",
      $ai_trace_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      $ai_latency: 0.9,
      $ai_input_tokens: 10,
      $ai_cache_read_input_tokens: 2,
      $ai_cache_creation_input_tokens: 1,
      uncached_input_tokens: 8,
      $ai_output_tokens: 5,
      reasoning_output_tokens: 3,
      $ai_cache_reporting_exclusive: false,
      aggregation_scope: "role_run",
      token_coverage: "complete",
    },
  });
  expect(delivery).toMatchObject({ timestamp: "2023-11-14T22:13:20.200Z" });
  expect(roleRun.properties).not.toHaveProperty("$ai_input");
  expect(roleRun.properties).not.toHaveProperty("$ai_output");
  expect(roleRun.properties).not.toHaveProperty("$ai_is_cumulative");
  expect(first[0]?.properties).not.toHaveProperty("merged_deliveries");
  expect(first[0]?.properties).not.toHaveProperty("successful_runs");
  expect(first[0]?.properties).not.toHaveProperty("failed_runs");
  expect(first[0]?.properties).not.toHaveProperty("cancelled_runs");
  expect(first[0]?.properties).not.toHaveProperty("blocked_runs");
  expect(first[0]?.properties).not.toHaveProperty("unknown_runs");
  expect(first[0]?.properties).not.toHaveProperty("task_count");
  expect(first[0]).toMatchObject({
    properties: {
      terminal_reason: null,
      terminal_tasks_delivery_failure: 0,
      terminal_tasks_implementation_budget: 0,
      terminal_tasks_unknown: 0,
    },
  });
  const changedRun = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      runs: [{ ...evidence().runs[0]!, model: "another-observed-model" }],
    },
    "deployment-test",
  ).find((event) => event.event === "$ai_generation");
  expect(changedRun?.uuid).toBe(roleRun.uuid);
  const changedProgress = campaignEvidenceToPostHogEvents(
    { ...campaign(), status: "abandoned", revision: 5 },
    { ...evidence(), progress: { ...evidence().progress, revision: 5 } },
    "deployment-test",
  )[0];
  const touch = first.find((event) => event.event === "usine_campaign_guardian_touch")!;
  const changedTouch = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      touches: [{ ...evidence().touches[0]!, type: "decision" }],
    },
    "deployment-test",
  ).find((event) => event.event === "usine_campaign_guardian_touch");
  const changedDelivery = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      deliveries: [{ ...evidence().deliveries[0]!, merged: false, mergeCommitSha: null }],
    },
    "deployment-test",
  ).find((event) => event.event === "usine_campaign_delivery");
  const changedDeliverySha = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      deliveries: [{ ...evidence().deliveries[0]!, sha: "c".repeat(40) }],
    },
    "deployment-test",
  ).find((event) => event.event === "usine_campaign_delivery");
  expect(changedProgress?.uuid).not.toBe(first[0]!.uuid);
  expect(changedTouch?.uuid).not.toBe(touch.uuid);
  // Existing delivery UUIDs hash the projected properties; the durable SHA remains omitted.
  expect(changedDelivery?.uuid).not.toBe(delivery.uuid);
  expect(changedDeliverySha?.uuid).toBe(delivery.uuid);
  const serialized = JSON.stringify(first);
  for (const omitted of [
    "private-contract-hash",
    "private objective",
    "private source",
    "private diagnostic",
    "private.example",
    "private-attestation",
    "url",
    "sha",
    "archive",
    "path",
    "raw",
  ])
    expect(serialized).not.toContain(omitted);
});

test("projects failed interrupted usage with every token dimension and matching coverage", () => {
  const usage = {
    inputTokens: 120,
    cachedInputTokens: 20,
    uncachedInputTokens: 100,
    cacheWriteInputTokens: null,
    outputTokens: 8,
    reasoningOutputTokens: null,
    coverage: "complete" as const,
  };
  const page = {
    ...evidence(),
    coverage: "complete" as const,
    runs: [
      {
        ...evidence().runs[0]!,
        outcome: "failed" as const,
        failureClass: "transient_capacity" as const,
        elapsedMs: 511_537,
        usage,
      },
    ],
    totals: {
      ...evidence().totals,
      invocations: 1,
      elapsedMs: 511_537,
      terminalTaskCounts: { ...evidence().totals.terminalTaskCounts, transient_capacity: 1 },
      usage,
    },
  };

  const events = campaignEvidenceToPostHogEvents(campaign(), page, "deployment-test");
  const progress = events.find((event) => event.event === "usine_campaign_progress")!;
  const roleRun = events.find((event) => event.event === "$ai_generation")!;
  expect(roleRun).toMatchObject({
    properties: {
      outcome: "failed",
      failure_class: "transient_capacity",
      $ai_input_tokens: 120,
      $ai_cache_read_input_tokens: 20,
      uncached_input_tokens: 100,
      $ai_cache_creation_input_tokens: null,
      $ai_output_tokens: 8,
      reasoning_output_tokens: null,
      token_coverage: "complete",
    },
  });
  expect(progress.properties).toMatchObject({
    terminal_tasks_transient_capacity: 1,
    token_coverage: "complete",
    evidence_coverage: "complete",
    input_tokens: 120,
    cached_input_tokens: 20,
    uncached_input_tokens: 100,
    cache_write_input_tokens: null,
    output_tokens: 8,
    reasoning_output_tokens: null,
  });
});

test("projects configured identity per missing dimension and keeps unknown identity unavailable", () => {
  const base = evidence().runs[0]!;
  const partial = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      runs: [
        {
          ...base,
          actualProvider: "unavailable",
          actualModel: "attested-model",
          provider: "unavailable",
          model: "attested-model",
        },
      ],
    },
    "deployment-test",
  ).find((event) => event.event === "$ai_generation")!;
  expect(partial.properties).toMatchObject({
    configured_provider: "configured-provider",
    configured_model: "configured-model",
    actual_provider: "unavailable",
    actual_model: "attested-model",
    $ai_provider: "configured-provider",
    $ai_model: "attested-model",
    provider_identity_source: "configured",
    model_identity_source: "provider",
    $ai_input_tokens: 10,
    $ai_cache_read_input_tokens: 2,
    uncached_input_tokens: 8,
    $ai_cache_creation_input_tokens: 1,
    $ai_output_tokens: 5,
    reasoning_output_tokens: 3,
    $ai_cache_reporting_exclusive: false,
  });
  const unknown = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      runs: [
        {
          ...base,
          configuredProvider: "unavailable",
          configuredModel: "unavailable",
          actualProvider: "unavailable",
          actualModel: "unavailable",
          provider: "unavailable",
          model: "unavailable",
        },
      ],
    },
    "deployment-test",
  ).find((event) => event.event === "$ai_generation")!;
  expect(unknown.properties).toMatchObject({
    configured_provider: "unavailable",
    configured_model: "unavailable",
    actual_provider: "unavailable",
    actual_model: "unavailable",
    $ai_provider: "unavailable",
    $ai_model: "unavailable",
    provider_identity_source: "unavailable",
    model_identity_source: "unavailable",
  });
  expect(unknown.uuid).toBe(partial.uuid);
});

test("namespaces stable event and AI trace identities by deployment", () => {
  const first = campaignEvidenceToPostHogEvents(campaign(), evidence(), "deployment-alpha");
  const retry = campaignEvidenceToPostHogEvents(campaign(), evidence(), "deployment-alpha");
  const otherDeployment = campaignEvidenceToPostHogEvents(
    campaign(),
    evidence(),
    "deployment-beta",
  );

  expect(first).toEqual(retry);
  expect(first.every((event) => event.properties.deployment === "deployment-alpha")).toBe(true);
  expect(otherDeployment.every((event) => event.properties.deployment === "deployment-beta")).toBe(
    true,
  );
  expect(otherDeployment.map((event) => event.uuid)).not.toEqual(first.map((event) => event.uuid));

  const firstTrace = first.find((event) => event.event === "$ai_generation")!.properties
    .$ai_trace_id;
  const otherTrace = otherDeployment.find((event) => event.event === "$ai_generation")!.properties
    .$ai_trace_id;
  expect(otherTrace).not.toBe(firstTrace);
});

test("orders Campaign progress from durable revision and occurrence facts", () => {
  const stages = [
    { status: "planning" as const, revision: 2, occurredAtEpochMs: 1_700_000_000_300 },
    { status: "blocked" as const, revision: 3, occurredAtEpochMs: 1_700_000_000_400 },
    { status: "accepted" as const, revision: 4, occurredAtEpochMs: 1_700_000_000_500 },
  ];
  const progress = stages.map(({ status, revision, occurredAtEpochMs }) =>
    campaignEvidenceToPostHogEvents(
      { ...campaign(), status, revision },
      { ...evidence(), progress: { revision, occurredAtEpochMs } },
      "deployment-test",
    ).find((event) => event.event === "usine_campaign_progress"),
  );

  expect(progress.map((event) => event?.properties.campaign_revision)).toEqual([2, 3, 4]);
  expect(progress.map((event) => event?.timestamp)).toEqual([
    "2023-11-14T22:13:20.300Z",
    "2023-11-14T22:13:20.400Z",
    "2023-11-14T22:13:20.500Z",
  ]);
  expect(progress[2]).toEqual(
    campaignEvidenceToPostHogEvents(
      { ...campaign(), status: "accepted", revision: 4 },
      { ...evidence(), progress: { revision: 4, occurredAtEpochMs: 1_700_000_000_500 } },
      "deployment-test",
    ).find((event) => event.event === "usine_campaign_progress"),
  );
});

test("does not opt into PostHog without a non-empty deployment label", () => {
  expect(postHogConfigFromEnvironment({ USINE_POSTHOG_API_KEY: "test-project-key" })).toBeNull();
  expect(
    postHogConfigFromEnvironment({
      USINE_POSTHOG_API_KEY: "test-project-key",
      USINE_POSTHOG_DEPLOYMENT: "  ",
    }),
  ).toBeNull();
  expect(
    postHogConfigFromEnvironment({
      USINE_POSTHOG_API_KEY: "test-project-key",
      USINE_POSTHOG_DEPLOYMENT: "  deployment-test  ",
    }),
  ).toMatchObject({ deployment: "deployment-test" });
});

test("projects blocked Task classification without its raw blocker", () => {
  const blocked = campaignEvidenceToPostHogEvents(
    {
      ...campaign(),
      status: "blocked",
      decisionRequest: {
        requestId: "request-1",
        reason: "branches_blocked",
        outcomeIds: ["outcome-1"],
      },
    },
    {
      ...evidence(),
      totals: {
        ...evidence().totals,
        terminalTaskCounts: { ...evidence().totals.terminalTaskCounts, delivery_failure: 1 },
      },
    },
    "deployment-test",
  )[0]!;
  expect(blocked.properties).toMatchObject({
    terminal_reason: "branches_blocked",
    terminal_tasks_delivery_failure: 1,
  });
  expect(JSON.stringify(blocked)).not.toContain("private diagnostic");
});

test("projects implementation budget separately from elapsed budget", () => {
  const event = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      totals: {
        ...evidence().totals,
        terminalTaskCounts: {
          ...evidence().totals.terminalTaskCounts,
          implementation_budget: 1,
        },
      },
    },
    "deployment-test",
  )[0]!;

  expect(event.properties).toMatchObject({
    terminal_tasks_elapsed_budget: 0,
    terminal_tasks_implementation_budget: 1,
  });
});

test("omits in-flight unknown Role Runs but emits the closed run", () => {
  const unknown = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      runs: [{ ...evidence().runs[0]!, outcome: "unknown" }],
    },
    "deployment-test",
  );
  expect(unknown.some((event) => event.event === "$ai_generation")).toBe(false);
  const closed = campaignEvidenceToPostHogEvents(campaign(), evidence(), "deployment-test");
  expect(closed.some((event) => event.event === "$ai_generation")).toBe(true);
});

test("continuation Campaign evidence maps only Role Runs and deliveries", () => {
  const events = campaignEvidenceToPostHogEvents(
    campaign(),
    {
      ...evidence(),
      cursor: "page-2",
      totals: null,
      touches: [],
    },
    "deployment-test",
  );
  expect(events.map((event) => event.event)).toEqual(["$ai_generation", "usine_campaign_delivery"]);
});

test("captures persisted evidence from Task events using the Batch protocol", async () => {
  const fixture = await campaignFixture(200, false, undefined, 100);
  const request = await waitForRequest(
    fixture.posthog,
    (value) => value.batch?.some((event) => event.event === "$ai_generation") === true,
  );
  const roleRun = request.batch!.find((event) => event.event === "$ai_generation")!;
  expect(new Set(request.batch!.map((event) => event.event))).toEqual(
    new Set(["usine_campaign_progress", "$ai_generation", "usine_campaign_guardian_touch"]),
  );
  const planningProgress = request.batch!.find(
    (event) =>
      event.event === "usine_campaign_progress" && event.properties?.campaign_status === "planning",
  )!;
  expect(request.url).toBe("/batch/");
  expect(roleRun).toMatchObject({
    uuid: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    timestamp: "2023-11-14T22:13:20.100Z",
    event: "$ai_generation",
    properties: {
      distinct_id: fixture.published.campaignId,
      deployment: "deployment-test",
      $process_person_profile: false,
      $ai_provider: "configured-provider",
      configured_provider: "configured-provider",
      configured_model: "configured-model",
      actual_provider: "unavailable",
      actual_model: "unavailable",
      provider_identity_source: "configured",
      model_identity_source: "configured",
      $ai_model: "configured-model",
      $ai_input_tokens: 4,
      $ai_cache_read_input_tokens: 1,
      uncached_input_tokens: 1,
      $ai_cache_creation_input_tokens: 2,
      $ai_output_tokens: 2,
      reasoning_output_tokens: 1,
      token_coverage: "partial",
      $ai_cache_reporting_exclusive: false,
    },
  });
  expect(request.batch!.every((event) => event.properties?.deployment === "deployment-test")).toBe(
    true,
  );
  expect(roleRun).not.toHaveProperty("distinct_id");
  const afterPlanningCapture = fixture.posthog.requests.length;
  const blockedRequest = await waitForRequest(
    fixture.posthog,
    (value) =>
      value.batch?.some(
        (event) =>
          event.event === "usine_campaign_progress" &&
          event.properties?.campaign_status === "blocked" &&
          event.properties?.terminal_tasks_unknown === 1,
      ) === true,
    afterPlanningCapture,
  );
  const blockedProgress = blockedRequest.batch!.find(
    (event) =>
      event.event === "usine_campaign_progress" && event.properties?.campaign_status === "blocked",
  )!;
  expect(planningProgress.properties?.campaign_revision).toEqual(expect.any(Number));
  expect(blockedProgress.properties?.campaign_revision).toEqual(expect.any(Number));
  expect(campaignRevision(blockedProgress)).toBeGreaterThan(campaignRevision(planningProgress));
  expect(blockedProgress.uuid).not.toBe(planningProgress.uuid);
  expect(Date.parse(blockedProgress.timestamp!)).toBeGreaterThan(
    Date.parse(planningProgress.timestamp!),
  );
  expect(blockedProgress.properties).toMatchObject({ terminal_tasks_unknown: 1 });
  expect(JSON.stringify(blockedProgress)).not.toContain("fixture blocker");
  const stateDirectory = fixture.environment.USINE_STATE_DIR!;
  const equivalentStateDirectory = join(stateDirectory, "..", basename(stateDirectory));
  await captureCampaignEvidence(stateDirectory, fixture.published.campaignId, fixture.environment);
  const replayBaseline = fixture.posthog.requests.length;
  await Promise.all([
    captureCampaignEvidence(stateDirectory, fixture.published.campaignId, fixture.environment),
    captureCampaignEvidence(
      equivalentStateDirectory,
      fixture.published.campaignId,
      fixture.environment,
    ),
  ]);
  expect(fixture.posthog.requests.length).toBe(replayBaseline);
  const sentEvents = fixture.posthog.requests.flatMap((value) => value.batch ?? []);
  expect(sentEvents.filter((event) => event.uuid === blockedProgress.uuid)).toHaveLength(1);
  const database = new DatabaseSync(join(fixture.environment.USINE_STATE_DIR!, "usine.sqlite"));
  try {
    const acknowledged = database
      .prepare("SELECT deployment, event_uuid AS eventUuid FROM posthog_capture_acknowledgements")
      .all()
      .map((row) => {
        if (
          row === null ||
          typeof row !== "object" ||
          !("deployment" in row) ||
          !("eventUuid" in row) ||
          typeof row.deployment !== "string" ||
          typeof row.eventUuid !== "string"
        )
          throw new Error("invalid PostHog acknowledgement row");
        return { deployment: row.deployment, eventUuid: row.eventUuid };
      });
    expect(new Set(acknowledged.map((row) => `${row.deployment}:${row.eventUuid}`))).toEqual(
      new Set(
        sentEvents.map((event) => `${String(event.properties?.deployment)}:${String(event.uuid)}`),
      ),
    );
  } finally {
    database.close();
  }
  await fixture.usine.close();
  usineServers.pop();
  const restarted = await startUsineServer({
    environment: fixture.environment,
    host: "127.0.0.1",
    port: 0,
  });
  usineServers.push(restarted);
  await captureCampaignEvidence(
    fixture.environment.USINE_STATE_DIR!,
    fixture.published.campaignId,
    fixture.environment,
  );
  expect(fixture.posthog.requests.length).toBe(replayBaseline);
});

test("captures terminal Campaign progress when a delayed assessor completes", async () => {
  let assessorStarted!: () => void;
  const assessorStartedPromise = new Promise<void>((resolve) => {
    assessorStarted = resolve;
  });
  let releaseAssessor!: () => void;
  const assessorRelease = new Promise<void>((resolve) => {
    releaseAssessor = resolve;
  });
  const assessor: CampaignOutcomeAssessor = async (request) => {
    assessorStarted();
    await assessorRelease;
    const delivery = request.evidence.find((item) => item.fact === "delivery");
    if (!delivery) throw new Error("delayed assessor fixture requires delivery evidence");
    return {
      verdict: "satisfied",
      summary: "the delivered Outcome satisfies its criterion",
      gaps: [],
      evidence: [{ ...delivery, criterionIndex: 0 }],
      usage: {
        inputTokens: 7,
        cachedInputTokens: 2,
        uncachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
    };
  };
  const fixture = await campaignFixture(200, true, assessor);
  try {
    await assessorStartedPromise;
    await waitForRequest(
      fixture.posthog,
      (value) =>
        value.batch?.some(
          (event) =>
            event.event === "usine_campaign_progress" &&
            event.properties?.campaign_status === "planning",
        ) === true &&
        value.batch?.some((event) => event.event === "usine_campaign_delivery") === true,
    );
    const afterInitialCapture = fixture.posthog.requests.length;

    releaseAssessor();
    await waitForRequest(
      fixture.posthog,
      (value) =>
        value.batch?.some(
          (event) =>
            event.event === "usine_campaign_progress" &&
            event.properties?.campaign_status === "accepted",
        ) === true &&
        value.batch?.some(
          (event) => event.event === "$ai_generation" && event.properties?.role === "assessor",
        ) === true,
      afterInitialCapture,
    );
  } finally {
    releaseAssessor();
  }
});

test("a failed PostHog capture does not block the Campaign event entry", async () => {
  const fixture = await campaignFixture(503);
  await waitForRequest(fixture.posthog, (value) => value.batch?.length === 4);
  const beforeRetry = fixture.posthog.requests.length;
  await expect(
    captureCampaignEvidence(
      fixture.environment.USINE_STATE_DIR!,
      fixture.published.campaignId,
      fixture.environment,
    ),
  ).rejects.toThrow("PostHog batch request failed");
  expect(fixture.posthog.requests.length).toBe(beforeRetry + 1);
  expect(acknowledgementCount(fixture.environment.USINE_STATE_DIR!)).toBe(0);
});

test("suppresses an acknowledged Campaign delivery on repeated capture", async () => {
  const assessor: CampaignOutcomeAssessor = async ({ signal }) => {
    if (!signal) throw new Error("held assessor fixture requires a signal");
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      verdict: "inconclusive" as const,
      summary: "the held assessor did not produce a new observation",
      gaps: [],
      evidence: [],
      usage: null,
    };
  };
  const fixture = await campaignFixture(200, true, assessor);
  const request = await waitForRequest(
    fixture.posthog,
    (value) => value.batch?.some((event) => event.event === "usine_campaign_delivery") === true,
  );
  const delivery = request.batch!.find((event) => event.event === "usine_campaign_delivery")!;
  const beforeRepeat = fixture.posthog.requests.length;
  await captureCampaignEvidence(
    fixture.environment.USINE_STATE_DIR!,
    fixture.published.campaignId,
    fixture.environment,
  );
  expect(fixture.posthog.requests.length).toBe(beforeRepeat);
  const sentDeliveries = fixture.posthog.requests
    .flatMap((value) => value.batch ?? [])
    .filter((event) => event.event === "usine_campaign_delivery");
  expect(sentDeliveries).toHaveLength(1);
  expect(sentDeliveries[0]?.uuid).toBe(delivery.uuid);
});

async function campaignFixture(
  postHogStatus: number,
  deliver = false,
  assessOutcome?: CampaignOutcomeAssessor,
  acknowledgementDelayMs = 0,
) {
  const root = await mkdtemp(join(tmpdir(), "usine-posthog-campaign-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const contractPath = join(root, "goal.json");
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  const contract = {
    schemaVersion: 1,
    id: "posthog-campaign",
    version: 1,
    objective: "Record a Campaign",
    outcomes: [{ id: "outcome-1", title: "Outcome", acceptance: ["done"] }],
    authority: {
      source: "user:posthog-campaign",
      publish: true,
      delivery: true,
      merge: false,
      repositories: ["repo-1"],
      effects: ["github"],
    },
  };
  await writeFile(contractPath, JSON.stringify(contract));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize campaign"], { cwd: root });
  const posthog = await fakePostHog(postHogStatus, acknowledgementDelayMs);
  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_GOAL_PUBLICATION_SOURCE: "user:posthog-campaign",
    USINE_POSTHOG_API_KEY: "test-project-key",
    USINE_POSTHOG_API_URL: posthog.url,
    USINE_POSTHOG_DEPLOYMENT: "deployment-test",
    USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/repo-1",
  };
  const usine = await startUsineServer({
    environment,
    host: "127.0.0.1",
    port: 0,
    execute: async ({ authority, contract: taskContract, result }) => {
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-role-run`,
        occurredAtEpochMs: 1_700_000_000_100,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-session`,
          effectiveProfile: {
            profileName: "implementer",
            configSha256: "a".repeat(64),
            adapter: "sdk",
            model: "configured-model",
            modelProvider: "configured-provider",
            reasoningEffort: "high",
            developerInstructionsSha256: null,
            serviceTier: "default",
          },
          usage: {
            inputTokens: 4,
            cachedInputTokens: 1,
            uncachedInputTokens: 1,
            cacheWriteInputTokens: 2,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          usageCompleteness: "partial",
        },
      });
      if (!deliver)
        return authority.block(
          { taskId: result.taskId, revision: result.revision },
          "fixture blocker",
        );
      const activation = await authority.reserveActivation(
        result.taskId,
        taskContract.budget.maxImplementerActivations,
      );
      const repositoryPath = result.repository?.path;
      if (!repositoryPath) throw new Error("fixture repository path missing");
      const sha = (
        await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
          cwd: repositoryPath,
        })
      ).stdout.trim();
      const candidate = await authority.recordCandidate(
        { taskId: result.taskId, revision: activation.result.revision },
        { sha, baseSha: taskContract.baseSha, fence: activation.activation },
      );
      await authority.recordCheck(
        { taskId: result.taskId, revision: candidate.revision },
        { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
      );
      const reviewAttempt = await authority.reserveReviewAttempt(
        result.taskId,
        taskContract.budget.maxReviewCycles,
        "fixture-reviewer",
      );
      const reviewed = await authority.recordReview(
        { taskId: result.taskId, revision: reviewAttempt.result.revision },
        { sha, verdict: "approved", summary: "fixture approved", findings: [] },
        "fixture-reviewer",
      );
      return authority.recordDelivery(
        { taskId: result.taskId, revision: reviewed.revision },
        {
          sha,
          effect: "github",
          prNumber: 1,
          url: "https://example.invalid/pull/1",
          attestationId: "fixture-delivery",
          merge: null,
        },
      );
    },
    assessOutcome,
  });
  usineServers.push(usine);
  await registerRepository(usine.url, {
    id: "repo-1",
    path: root,
    owner: "example",
    name: "repo-1",
    baseBranch: "main",
    implementerProfile: "implementer",
    reviewerProfile: "reviewer",
    forgeProfile: "default",
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  const published = await publishCampaign(usine.url, { contractPath });
  await proposeCampaign(usine.url, published.campaignId, {
    proposalId: "proposal-1",
    outcomeId: "outcome-1",
    dependsOn: [],
    repositoryId: "repo-1",
    instructions: "Implement the proposal.",
    acceptance: ["done"],
    nonGoals: [],
    effects: ["github"],
    merge: false,
  });
  await handoffCampaign(usine.url, published.campaignId);
  return { published, posthog, usine, environment };
}

async function fakePostHog(
  status: number,
  acknowledgementDelayMs = 0,
): Promise<FakePostHog & { url: string }> {
  const requests: Array<{ url?: string; batch?: CapturedBatchEvent[] }> = [];
  const fake: FakePostHog = {
    server: createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({
          url: request.url,
          ...(JSON.parse(body) as { batch?: CapturedBatchEvent[] }),
        });
        setTimeout(() => response.writeHead(fake.status).end("ok"), acknowledgementDelayMs);
      });
    }),
    requests,
    status,
  };
  servers.push(fake.server);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const address = fake.server.address();
  if (!address || typeof address === "string") throw new Error("fake PostHog address missing");
  return { ...fake, url: `http://127.0.0.1:${address.port}/batch/` };
}

async function waitForRequest(
  fake: FakePostHog,
  predicate: (value: { url?: string; batch?: CapturedBatchEvent[] }) => boolean,
  startAt = 0,
): Promise<{ url?: string; batch?: CapturedBatchEvent[] }> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const found = fake.requests.slice(startAt).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("PostHog request was not received");
}

function acknowledgementCount(stateDirectory: string): number {
  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    return database
      .prepare("SELECT deployment, event_uuid FROM posthog_capture_acknowledgements")
      .all().length;
  } finally {
    database.close();
  }
}
