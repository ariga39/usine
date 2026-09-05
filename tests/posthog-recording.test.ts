import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import {
  campaignEvidenceToPostHogEvents,
  sendPostHogEvents,
  startUsineServer,
  type PostHogEvent,
} from "@usine/runtime";
import type { CampaignEvidencePage, CampaignResource } from "@usine/task-authority";
import {
  handoffCampaign,
  proposeCampaign,
  publishCampaign,
  registerRepository,
} from "../apps/cli/src/server-client.js";

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
    authority: {
      source: "private source",
      publish: true,
      delivery: true,
      merge: true,
    },
    budget: {
      maxElapsedMs: 10_000,
      maxTasks: 1,
      maxPlannerActivations: 1,
      maxImplementerActivations: 1,
      maxReviewCycles: 1,
    },
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

function evidence(): CampaignEvidencePage {
  return {
    schemaVersion: 1,
    campaignId: "campaign-391:v1",
    goalId: "campaign-391",
    goalVersion: 1,
    cursor: null,
    nextCursor: null,
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
        provider: "observed-provider",
        adapter: "sdk",
        model: "observed-model",
        outcome: "succeeded",
        taskState: "merged",
        taskBlocker: null,
        occurredAtEpochMs: 1_700_000_000_100,
        elapsedMs: 900,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          uncachedInputTokens: 8,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          reasoningOutputTokens: 3,
          coverage: "complete",
        },
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
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        uncachedInputTokens: 8,
        cacheWriteInputTokens: 1,
        outputTokens: 5,
        reasoningOutputTokens: 3,
        coverage: "complete",
      },
    },
    touches: [
      {
        touchId: "plan:campaign-391:v1",
        goalVersion: 1,
        type: "plan",
        occurredAtEpochMs: 1_700_000_000_000,
      },
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

test("maps only sanitized Campaign evidence and replays with stable identities", () => {
  const first = campaignEvidenceToPostHogEvents(campaign(), evidence());
  const second = campaignEvidenceToPostHogEvents(campaign(), evidence());

  expect(first).toEqual(second);
  expect(first.map((event) => event.event)).toEqual([
    "usine_campaign_progress",
    "usine_campaign_role_run",
    "usine_campaign_guardian_touch",
    "usine_campaign_delivery",
  ]);
  expect(first[1]).toMatchObject({
    distinctId: "campaign-391:v1",
    insertId: "role-run:task-1:implementer:1:session-1",
    occurredAtEpochMs: 1_700_000_000_100,
    properties: {
      provider: "observed-provider",
      adapter: "sdk",
      model: "observed-model",
      input_tokens: 10,
      cached_input_tokens: 2,
      uncached_input_tokens: 8,
      output_tokens: 5,
      token_coverage: "complete",
      task_state: "merged",
      task_blocker: null,
    },
  });
  const serialized = JSON.stringify(first);
  expect(serialized).not.toContain("private objective");
  expect(serialized).not.toContain("private source");
  expect(serialized).not.toContain("private diagnostic");
  expect(serialized).not.toContain("private.example");
  expect(serialized).not.toContain("private-attestation");
});

test("sends a Campaign role run to a PostHog-compatible endpoint", async () => {
  let received: unknown;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(200).end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake PostHog address missing");

  const roleRun = campaignEvidenceToPostHogEvents(campaign(), evidence()).find(
    (event) => event.event === "usine_campaign_role_run",
  )!;
  await sendPostHogEvents(
    { apiKey: "test-project-key", captureUrl: `http://127.0.0.1:${address.port}/capture/` },
    [roleRun],
  );

  expect(received).toMatchObject({
    api_key: "test-project-key",
    batch: [
      {
        event: "usine_campaign_role_run",
        distinct_id: "campaign-391:v1",
        properties: {
          $insert_id: "role-run:task-1:implementer:1:session-1",
          provider: "observed-provider",
        },
        timestamp: "2023-11-14T22:13:20.100Z",
      },
    ],
  });
});

test("records one persisted Campaign role run through the server recorder", async () => {
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
    budget: {
      maxElapsedMs: 60_000,
      maxTasks: 1,
      maxPlannerActivations: 1,
      maxImplementerActivations: 1,
      maxReviewCycles: 1,
    },
  };
  await writeFile(contractPath, JSON.stringify(contract));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize campaign"], { cwd: root });

  let resolveRoleRun!: (body: unknown) => void;
  const roleRunReceived = new Promise<unknown>((resolve) => (resolveRoleRun = resolve));
  const fakePostHog = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { batch?: Array<{ event?: string }> };
      if (parsed.batch?.some((event) => event.event === "usine_campaign_role_run"))
        resolveRoleRun(parsed);
      response.writeHead(200).end("ok");
    });
  });
  servers.push(fakePostHog);
  await new Promise<void>((resolve) => fakePostHog.listen(0, "127.0.0.1", resolve));
  const address = fakePostHog.address();
  if (!address || typeof address === "string") throw new Error("fake PostHog address missing");

  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_GOAL_PUBLICATION_SOURCE: "user:posthog-campaign",
    USINE_POSTHOG_API_KEY: "test-project-key",
    USINE_POSTHOG_API_URL: `http://127.0.0.1:${address.port}/capture/`,
    USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/repo-1",
  };
  const usine = await startUsineServer({
    environment,
    host: "127.0.0.1",
    port: 0,
    execute: async ({ authority, result }) => {
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-role-run`,
        occurredAtEpochMs: 1_700_000_000_100,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-session`,
          usage: { inputTokens: 4, cachedInputTokens: 1, uncachedInputTokens: 3, outputTokens: 2 },
        },
      });
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "fixture blocker",
      );
    },
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
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
    merge: false,
  });
  await handoffCampaign(usine.url, published.campaignId);

  const received = (await Promise.race([
    roleRunReceived,
    new Promise((_, reject) => setTimeout(() => reject(new Error("role run not recorded")), 5_000)),
  ])) as { batch: Array<{ event: string; properties: Record<string, unknown> }> };
  expect(received.batch.some((event) => event.event === "usine_campaign_role_run")).toBe(true);
  expect(received.batch.find((event) => event.event === "usine_campaign_role_run")).toMatchObject({
    properties: {
      campaign_id: published.campaignId,
      task_id: "campaign-posthog-campaign-v1-proposal-1",
      provider: "unavailable",
      input_tokens: 4,
      uncached_input_tokens: 3,
    },
  });
});

test("surfaces a failed PostHog response to the non-authoritative caller", async () => {
  const fetchImplementation: typeof fetch = async () => new Response(null, { status: 503 });
  const event: PostHogEvent = {
    event: "usine_campaign_role_run",
    distinctId: "campaign-391:v1",
    insertId: "role-run:one",
    occurredAtEpochMs: 1_700_000_000_100,
    properties: {},
  };
  await expect(
    sendPostHogEvents(
      { apiKey: "test-project-key", captureUrl: "http://127.0.0.1/capture/" },
      [event],
      fetchImplementation,
    ),
  ).rejects.toThrow("PostHog capture request failed");
});
