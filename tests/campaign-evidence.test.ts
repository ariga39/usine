import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { lookupCampaignEvidence } from "@usine/runtime";
import {
  applyMigrations,
  campaignProposals,
  campaignTouches,
  campaigns,
  goalContractSchema,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
} from "@usine/task-authority";

const handles: Array<{ close: () => void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

const goal = goalContractSchema.parse({
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
    repositories: ["repo-one", "repo-two"],
    effects: ["github"],
  },
  budget: {
    maxElapsedMs: 10_000,
    maxTasks: 2,
    maxPlannerActivations: 1,
    maxImplementerActivations: 2,
    maxReviewCycles: 2,
  },
});

function contract(taskId: string, outcomeId: string, repositoryId: string): TaskContract {
  return {
    id: taskId,
    repositoryId,
    baseSha: "a".repeat(40),
    instructions: "measure",
    acceptance: ["measure"],
    nonGoals: [],
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 10_000 },
    authorization: { source: "user:evidence", delivery: true },
    delivery: { branch: `agent/${taskId}`, title: "Measure", body: "Measure" },
    campaign: {
      campaignId: "evidence-goal:v1",
      goalId: "evidence-goal",
      goalVersion: 1,
      outcomeId,
    },
  };
}

async function seedTask(
  database: ReturnType<typeof openSqliteDatabase>["database"],
  taskId: string,
  outcomeId: string,
  repositoryId: string,
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  } | null,
): Promise<void> {
  const taskContract = contract(taskId, outcomeId, repositoryId);
  const authority = new TaskAuthority(database);
  await authority.admit({
    contract: taskContract,
    contractHash: "b".repeat(64),
    repositoryIdentity: `owner/${repositoryId}`,
    repository: {
      id: repositoryId,
      path: "/tmp/repository",
      owner: "owner",
      name: repositoryId,
      baseBranch: "main",
      implementerProfile: "implementer",
      reviewerProfile: "reviewer",
      forgeProfile: "forge",
      githubReadProfile: null,
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Usine", email: "usine@example.test" },
    },
    deadlineEpochMs: 10_000,
  });
  await authority.appendObservation(taskId, {
    eventId: `${taskId}-implementer`,
    occurredAtEpochMs: 100,
    data: {
      type: "coding_session_completed",
      role: "implementer",
      activation: 1,
      outcome: "succeeded",
      sessionId: `${taskId}-implementer`,
      effectiveProfile: {
        profileName: "implementer",
        configSha256: "c".repeat(64),
        adapter: "sdk",
        model: "model-one",
        modelProvider: "provider-one",
        actualModel: "observed-one",
        actualModelProvider: "provider-one",
        reasoningEffort: "high",
        developerInstructionsSha256: null,
        serviceTier: "default",
      },
      usage,
    },
  });
  await authority.appendObservation(taskId, {
    eventId: `${taskId}-reviewer`,
    occurredAtEpochMs: 120,
    data: {
      type: "coding_session_completed",
      role: "reviewer",
      activation: 1,
      reviewCycle: 1,
      outcome: "succeeded",
      sessionId: `${taskId}-reviewer`,
      effectiveProfile: {
        profileName: "reviewer",
        configSha256: "d".repeat(64),
        adapter: "app-server",
        model: "review-model",
        modelProvider: "review-provider",
        reasoningEffort: "medium",
        developerInstructionsSha256: null,
        serviceTier: "default",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  });
  const reserved = await authority.reserveActivation(taskId, 2);
  const candidate = await authority.recordCandidate(
    { taskId, revision: reserved.result.revision },
    { sha: "e".repeat(40), baseSha: taskContract.baseSha, fence: reserved.activation },
  );
  const checked = await authority.recordCheck(
    { taskId, revision: candidate.revision },
    {
      sha: candidate.candidateSha!,
      status: "passed",
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  );
  const requested = await authority.recordReview(
    { taskId, revision: checked.revision },
    { sha: checked.candidateSha!, verdict: "changes_requested", summary: "", findings: ["fix"] },
  );
  await authority.recordRepairBatch({ taskId, revision: requested.revision });
  const recovered = await authority.reserveActivation(taskId, 2);
  const repairedCandidate = await authority.recordCandidate(
    { taskId, revision: recovered.result.revision },
    { sha: "f".repeat(40), baseSha: candidate.candidateSha!, fence: recovered.activation },
  );
  const repairedCheck = await authority.recordCheck(
    { taskId, revision: repairedCandidate.revision },
    {
      sha: repairedCandidate.candidateSha!,
      status: "passed",
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  );
  const reviewed = await authority.recordReview(
    { taskId, revision: repairedCheck.revision },
    { sha: repairedCheck.candidateSha!, verdict: "approved", summary: "", findings: [] },
  );
  await authority.recordDelivery(
    { taskId, revision: reviewed.revision },
    {
      sha: reviewed.candidateSha!,
      effect: "github",
      prNumber: taskId === "task-one" ? 41 : 42,
      url: `https://github.com/owner/${repositoryId}/pull/1`,
      attestationId: "attestation",
      merge: null,
    },
  );
}

test("projects one deterministic Campaign evidence report across Tasks and providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-campaign-evidence-"));
  const path = join(directory, "usine.sqlite");
  await applyMigrations(path);
  const handle = openSqliteDatabase(path);
  handles.push(handle);
  await handle.database.insert(campaigns).values({
    campaignId: "evidence-goal:v1",
    goalId: goal.id,
    goalVersion: goal.version,
    contractHash: "a".repeat(64),
    contract: goal,
    status: "planning",
    publicationAuthorized: true,
    superseded: false,
    revision: 1,
  });
  await handle.database.insert(campaignProposals).values([
    {
      campaignId: "evidence-goal:v1",
      proposalId: "proposal-one",
      sequence: 1,
      outcomeId: "outcome-one",
      proposal: {},
      status: "ready",
      blocker: null,
      readyBaseSha: "a".repeat(40),
      readyRepositoryRevision: 1,
    },
    {
      campaignId: "evidence-goal:v1",
      proposalId: "proposal-blocked",
      sequence: 2,
      outcomeId: "outcome-two",
      proposal: {},
      status: "blocked",
      blocker: "blocked",
      readyBaseSha: null,
      readyRepositoryRevision: null,
    },
    {
      campaignId: "evidence-goal:v1",
      proposalId: "proposal-rejected",
      sequence: 3,
      outcomeId: "outcome-two",
      proposal: {},
      status: "rejected",
      blocker: "proposal was rejected",
      readyBaseSha: null,
      readyRepositoryRevision: null,
    },
  ]);
  await handle.database.insert(campaignTouches).values([
    {
      campaignId: "evidence-goal:v1",
      touchId: "plan:goal",
      goalVersion: 1,
      type: "plan",
      occurredAtEpochMs: 1,
    },
    {
      campaignId: "evidence-goal:v1",
      touchId: "decision:blocked",
      goalVersion: 1,
      type: "decision",
      occurredAtEpochMs: 2,
    },
  ]);
  await seedTask(handle.database, "task-one", "outcome-one", "repo-one", null);
  await seedTask(handle.database, "task-two", "outcome-two", "repo-two", {
    inputTokens: 12,
    cachedInputTokens: 3,
    uncachedInputTokens: 9,
    outputTokens: 7,
  });

  const first = await lookupCampaignEvidence(directory, "evidence-goal:v1", {
    cursor: null,
    limit: 1,
  });
  expect(first?.runs).toHaveLength(2);
  expect(
    first?.runs.map((run) => [run.goalVersion, run.outcomeId, run.taskId, run.role, run.adapter]),
  ).toEqual([
    [1, "outcome-one", "task-one", "implementer", "sdk"],
    [1, "outcome-one", "task-one", "reviewer", "app-server"],
  ]);
  expect(first?.totals).toMatchObject({
    reviewCycles: 4,
    repairBatches: 2,
    blockedProposals: 1,
    rejectedProposals: 1,
    guardianTouches: 2,
    acceptedDeliveries: 2,
    usage: { inputTokens: null, outputTokens: null, coverage: "partial" },
  });
  expect(first?.runs[0]).not.toHaveProperty("profile");
  expect(first?.runs[0]).not.toHaveProperty("configuredProvider");
  expect(first?.deliveries).toHaveLength(1);
  expect(first?.nextCursor).not.toBeNull();
  const second = await lookupCampaignEvidence(directory, "evidence-goal:v1", {
    cursor: first!.nextCursor,
    limit: 1,
  });
  expect(second?.runs).toHaveLength(2);
  expect(second?.runs[0]?.usage).toMatchObject({
    inputTokens: 12,
    cachedInputTokens: 3,
    uncachedInputTokens: 9,
    outputTokens: 7,
  });
  expect(second?.runs[1]?.usage).toMatchObject({
    inputTokens: 0,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: 0,
  });
  expect(second?.deliveries).toHaveLength(1);
  expect(second?.touches).toEqual([]);
  expect(
    await lookupCampaignEvidence(directory, "evidence-goal:v1", { cursor: null, limit: 1 }),
  ).toEqual(first);
});
