import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import {
  CampaignEvidenceCursorError,
  lookupCampaignEvidence,
  startUsineServer,
} from "@usine/runtime";
import {
  campaignEvidence,
  proposeCampaign,
  publishCampaign,
  recordCampaignDecisionTouch,
  registerRepository,
} from "../apps/cli/src/server-client.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function goalContract() {
  return {
    schemaVersion: 1,
    id: "evidence-goal",
    version: 1,
    objective: "Measure the campaign",
    outcomes: [
      { id: "outcome-one", title: "First outcome", acceptance: ["first"] },
      { id: "outcome-two", title: "Second outcome", acceptance: ["second"] },
    ],
    authority: {
      source: "user:evidence",
      publish: true,
      delivery: true,
      merge: false,
      repositories: ["repo-one"],
      effects: ["github"],
    },
    budget: {
      maxElapsedMs: 60_000,
      maxTasks: 3,
      maxPlannerActivations: 1,
      maxImplementerActivations: 2,
      maxReviewCycles: 2,
    },
  };
}

function proposal(proposalId: string, outcomeId: string, effects = ["github"]) {
  return {
    proposalId,
    outcomeId,
    dependsOn: [],
    repositoryId: "repo-one",
    instructions: `Implement ${proposalId}.`,
    acceptance: [`${proposalId} is complete.`],
    nonGoals: [],
    effects,
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 10_000 },
    merge: false,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usine-campaign-evidence-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const contractPath = join(root, "goal.json");
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(contractPath, JSON.stringify(goalContract()));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize campaign"], { cwd: root });

  let executions = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_GOAL_PUBLICATION_SOURCE: "user:evidence",
    USINE_ACTIVE_TASK_CAPACITY: "1",
    USINE_FORGE_PROFILE_FORGE_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_FORGE_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_FORGE_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_FORGE_REPOSITORY: "example/repo-one",
  };
  const server = await startUsineServer({
    environment,
    host: "127.0.0.1",
    port: 0,
    execute: async ({ authority, result, contract }) => {
      const index = executions++;
      const implementationUsage =
        index === 0
          ? { inputTokens: 12, cachedInputTokens: 3, uncachedInputTokens: 9, outputTokens: 7 }
          : null;
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-implementer`,
        occurredAtEpochMs: 100 + index * 100,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-implementer`,
          effectiveProfile: {
            profileName: "implementer",
            configSha256: "c".repeat(64),
            adapter: index === 0 ? "sdk" : "opencode2",
            model: "configured-model",
            modelProvider: "configured-provider",
            actualModel: index === 0 ? "observed-one" : "observed-two",
            actualModelProvider: index === 0 ? "provider-one" : "provider-two",
            reasoningEffort: "high",
            developerInstructionsSha256: null,
            serviceTier: "default",
          },
          usage: implementationUsage,
        },
      });
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-reviewer`,
        occurredAtEpochMs: 120 + index * 100,
        data: {
          type: "coding_session_completed",
          role: "reviewer",
          activation: 1,
          reviewCycle: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-reviewer`,
          effectiveProfile: {
            profileName: "reviewer",
            configSha256: "d".repeat(64),
            adapter: index === 0 ? "app-server" : "sdk",
            model: "review-model",
            modelProvider: "review-provider",
            actualModel: "review-observed",
            actualModelProvider: "review-observed-provider",
            reasoningEffort: "medium",
            developerInstructionsSha256: null,
            serviceTier: "default",
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      });
      const reserved = await authority.reserveActivation(
        result.taskId,
        contract.budget.maxImplementerActivations,
      );
      const firstSha = index === 0 ? "e".repeat(40) : "1".repeat(40);
      const candidate = await authority.recordCandidate(
        { taskId: result.taskId, revision: reserved.result.revision },
        { sha: firstSha, baseSha: contract.baseSha, fence: reserved.activation },
      );
      const checked = await authority.recordCheck(
        { taskId: result.taskId, revision: candidate.revision },
        { sha: firstSha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
      );
      const reviewed = await authority.recordReview(
        { taskId: result.taskId, revision: checked.revision },
        {
          sha: firstSha,
          verdict: index === 0 ? "changes_requested" : "approved",
          summary: "fixture review",
          findings: index === 0 ? ["repair"] : [],
        },
      );
      let final = reviewed;
      if (index === 0) {
        await authority.recordRepairBatch({ taskId: result.taskId, revision: reviewed.revision });
        const repaired = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        const repairedCandidate = await authority.recordCandidate(
          { taskId: result.taskId, revision: repaired.result.revision },
          { sha: "f".repeat(40), baseSha: firstSha, fence: repaired.activation },
        );
        const repairedCheck = await authority.recordCheck(
          { taskId: result.taskId, revision: repairedCandidate.revision },
          {
            sha: "f".repeat(40),
            status: "passed",
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        );
        final = await authority.recordReview(
          { taskId: result.taskId, revision: repairedCheck.revision },
          { sha: "f".repeat(40), verdict: "approved", summary: "repaired", findings: [] },
        );
      }
      const delivered = await authority.recordDelivery(
        { taskId: result.taskId, revision: final.revision },
        {
          sha: final.candidateSha!,
          effect: "github",
          prNumber: 41 + index,
          url: `https://github.com/example/repo-one/pull/${41 + index}`,
          attestationId: `attestation-${index}`,
          merge: null,
        },
      );
      if (executions === 2) finish();
      return delivered;
    },
  });
  servers.push(server);
  await registerRepository(server.url, {
    id: "repo-one",
    path: root,
    owner: "example",
    name: "repo-one",
    baseBranch: "main",
    implementerProfile: "implementer",
    reviewerProfile: "reviewer",
    forgeProfile: "forge",
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  return { stateDirectory, contractPath, server, finished };
}

test("projects public Campaign writes into deterministic evidence across Tasks and providers", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("proposal-one", "outcome-one"));
  await proposeCampaign(server.url, published.campaignId, proposal("proposal-two", "outcome-two"));
  await proposeCampaign(
    server.url,
    published.campaignId,
    proposal("proposal-blocked", "outcome-two", ["shell"]),
  );
  await recordCampaignDecisionTouch(server.url, published.campaignId, "blocked-review");
  await recordCampaignDecisionTouch(server.url, published.campaignId, "blocked-review");
  await finished;

  const first = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: null,
    limit: 1,
  });
  expect(first?.runs).toHaveLength(2);
  expect(first?.runs.map((run) => [run.role, run.model, run.provider, run.adapter])).toEqual([
    ["implementer", "observed-one", "provider-one", "sdk"],
    ["reviewer", "review-observed", "review-observed-provider", "app-server"],
  ]);
  expect(first?.totals).toMatchObject({
    invocations: 4,
    reviewCycles: 3,
    repairBatches: 1,
    blockedProposals: 1,
    guardianTouches: 5,
    acceptedDeliveries: 2,
    usage: { inputTokens: null, outputTokens: null, coverage: "partial" },
  });
  expect(first?.runs[0]).not.toHaveProperty("profile");
  expect(first?.runs[0]).not.toHaveProperty("configuredProvider");
  expect(first?.deliveries).toHaveLength(1);
  expect(first?.touches.map((touch) => touch.type)).toEqual([
    "plan",
    "plan",
    "plan",
    "plan",
    "decision",
  ]);
  expect(first?.nextCursor).not.toBeNull();

  const second = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: first!.nextCursor,
    limit: 1,
  });
  expect(second?.runs).toHaveLength(2);
  expect(second?.runs[0]?.usage).toMatchObject({
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
  });
  expect(second?.runs[1]?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  expect(second?.deliveries).toHaveLength(1);
  expect(second?.touches).toEqual([]);

  const publicReport = await campaignEvidence(server.url, published.campaignId, 1);
  expect(publicReport?.runs).toHaveLength(4);
  expect(publicReport?.deliveries).toHaveLength(2);
  expect(publicReport?.touches).toHaveLength(5);
  expect(publicReport?.totals).toEqual(first?.totals);
  expect(
    await lookupCampaignEvidence(stateDirectory, published.campaignId, { cursor: null, limit: 1 }),
  ).toEqual(first);
  await expect(
    lookupCampaignEvidence(stateDirectory, published.campaignId, {
      cursor: "x".repeat(4097),
      limit: 1,
    }),
  ).rejects.toBeInstanceOf(CampaignEvidenceCursorError);
});
