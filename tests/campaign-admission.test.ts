import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  registerRepositoryResource,
  startUsineServer,
  type CampaignOutcomeAssessor,
  type CampaignReplacementGenerator,
} from "@usine/runtime";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { CodexCodingSession, type CodingSessionClientFactory } from "@usine/coding-session";
import { executeDeliveryRun, type DeliveryRunServices } from "@usine/delivery-run";
import { QualityGate } from "@usine/quality-gate";
import {
  openSqliteDatabase,
  resolveTaskContract,
  TaskAuthority,
  type CampaignAssessmentFact,
  type TaskResult,
} from "@usine/task-authority";
import {
  abandonCampaign,
  campaignEvidence,
  checkpointCampaign,
  getCampaign,
  handoffCampaign,
  proposeCampaign,
  publishCampaign,
  recordCampaignDecisionTouch,
  registerRepository,
  retryTask,
  serverSnapshot,
  taskEvidence,
  taskEvents,
  taskStatus,
} from "../apps/cli/src/server-client.js";
import {
  lookupCampaign,
  parseGoalContract,
  publishCampaign as publishCampaignToState,
  reconcileCampaigns,
} from "../packages/runtime/src/campaign.js";
import { lookupCampaignEvidence } from "../packages/runtime/src/campaign-evidence.js";
import { campaignEvidenceToPostHogEvents } from "../packages/runtime/src/posthog.js";

function goalContract(objective = "Deliver the authorized campaign") {
  return {
    schemaVersion: 1,
    id: "campaign-365",
    version: 1,
    objective,
    outcomes: [
      {
        id: "outcome-root",
        title: "Publish the root outcome",
        acceptance: ["The root outcome is represented by a durable Campaign."],
        dependsOn: [],
        parentId: null,
      },
      {
        id: "outcome-child",
        title: "Retain the child outcome",
        acceptance: ["The child remains in the accepted Outcome Tree."],
        dependsOn: ["outcome-root"],
        parentId: "outcome-root",
      },
    ],
    authority: {
      source: "user:issue-363",
      publish: true,
      delivery: true,
      merge: false,
    },
  } as const;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usine-campaign-admission-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const contractPath = join(root, "goal.json");
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(contractPath, JSON.stringify(goalContract()));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize goal"], { cwd: root });
  return { root, stateDirectory, contractPath };
}

async function start(stateDirectory: string) {
  return startUsineServer({
    environment: { USINE_STATE_DIR: stateDirectory },
    host: "127.0.0.1",
    port: 0,
  });
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  throw new Error("timed out waiting for durable Campaign state");
}

function frontierGoal(repositoryId: string) {
  return {
    schemaVersion: 1,
    id: "campaign-366",
    version: 1,
    objective: "Deliver a bounded campaign frontier",
    outcomes: [
      {
        id: "outcome-one",
        title: "Complete the first outcome",
        acceptance: ["The first outcome has executable work."],
        dependsOn: [],
        parentId: null,
      },
      {
        id: "outcome-two",
        title: "Complete the dependent outcome",
        acceptance: ["The dependent outcome has executable work."],
        dependsOn: ["outcome-one"],
        parentId: null,
      },
    ],
    authority: {
      source: "user:campaign-366",
      publish: true,
      delivery: true,
      merge: false,
      repositories: [repositoryId],
      effects: ["github"],
    },
  } as const;
}

function frontierProposal(
  proposalId: string,
  outcomeId: string,
  dependsOn: string[] = [],
  merge = false,
  repositoryId = "campaign-repository",
  maxImplementerActivations = 1,
) {
  return {
    proposalId,
    outcomeId,
    dependsOn,
    repositoryId,
    instructions: `Implement ${proposalId}.`,
    acceptance: [`${proposalId} is complete.`],
    nonGoals: [],
    effects: ["github"],
    budget: {
      maxImplementerActivations,
      maxReviewCycles: 1,
      maxElapsedMs: 10_000,
    },
    merge,
  };
}

function quotaFreeFrontierProposal(proposalId: string, outcomeId: string) {
  return {
    proposalId,
    outcomeId,
    dependsOn: [],
    repositoryId: "campaign-repository",
    instructions: `Implement ${proposalId}.`,
    acceptance: [`${proposalId} is complete.`],
    nonGoals: [],
    effects: ["github"],
    merge: false,
  };
}

function mergeFrontierGoal(repositoryId: string) {
  const contract = frontierGoal(repositoryId);
  return { ...contract, authority: { ...contract.authority, merge: true } };
}

function oneOutcomeFrontierGoal(repositoryId: string) {
  const contract = frontierGoal(repositoryId);
  return {
    ...contract,
    outcomes: [contract.outcomes[0]],
  };
}

const satisfiesDeliveredOutcome: CampaignOutcomeAssessor = async (request) => {
  const delivery = request.evidence.find((item) => item.fact === "delivery");
  if (!delivery)
    return {
      verdict: "inconclusive",
      summary: "the bounded evidence has no accepted delivery",
      gaps: [],
      evidence: [],
      usage: null,
    };
  return {
    verdict: "satisfied",
    summary: "every acceptance condition is covered by the accepted delivery evidence",
    gaps: [],
    evidence: request.outcome.acceptance.map((_, criterionIndex) => ({
      ...delivery,
      criterionIndex,
    })),
    usage: null,
  };
};

const lateAssessorUsage = {
  inputTokens: 17,
  cachedInputTokens: 4,
  uncachedInputTokens: 13,
  cacheWriteInputTokens: 0,
  outputTokens: 6,
  reasoningOutputTokens: 2,
};

const checkpointOwnedGapAssessor: CampaignOutcomeAssessor = async () => ({
  verdict: "gaps",
  summary: "the historically Ready proposal leaves a direction gap",
  gaps: ["the owned proposal cannot be revised"],
  evidence: [],
  usage: null,
});

const checkpointDirectionGapAssessor: CampaignOutcomeAssessor = async (request) => {
  const delivery = request.evidence.find((item) => item.fact === "delivery");
  return request.outcome.id !== "outcome-one" && delivery
    ? {
        verdict: "satisfied" as const,
        summary: "the independent delivery satisfies the Outcome",
        gaps: [],
        evidence: request.outcome.acceptance.map((_, criterionIndex) => ({
          ...delivery,
          criterionIndex,
        })),
        usage: null,
      }
    : {
        verdict: "gaps" as const,
        summary: "the checkpoint source points in the wrong direction",
        gaps: ["the source needs one focused correction"],
        evidence: [],
        usage: null,
      };
};

async function frontierFixture(
  contract: unknown = frontierGoal("campaign-repository"),
  publicationSource: string | null = "user:campaign-366",
  execute?: Parameters<typeof startUsineServer>[0]["execute"],
  activeTaskCapacity = 1,
  register = true,
  assessOutcome?: CampaignOutcomeAssessor,
  generateReplacement?: CampaignReplacementGenerator,
) {
  const root = await mkdtemp(join(tmpdir(), "usine-campaign-frontier-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const contractPath = join(root, "goal.json");
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(contractPath, JSON.stringify(contract));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize frontier"], { cwd: root });
  const environment: NodeJS.ProcessEnv = { USINE_STATE_DIR: stateDirectory };
  environment.USINE_FORGE_PROFILE_DEFAULT_APP_SLUG = "test-app";
  environment.USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN = "test-token";
  environment.USINE_FORGE_PROFILE_DEFAULT_API_URL = "http://127.0.0.1:9";
  environment.USINE_FORGE_PROFILE_DEFAULT_REPOSITORY = "example/campaign-repository";
  environment.USINE_ACTIVE_TASK_CAPACITY = String(activeTaskCapacity);
  if (publicationSource !== null) environment.USINE_GOAL_PUBLICATION_SOURCE = publicationSource;
  const server = await startUsineServer({
    environment,
    execute,
    assessOutcome,
    generateReplacement,
    host: "127.0.0.1",
    port: 0,
  });
  if (register)
    await registerRepository(server.url, {
      id: "campaign-repository",
      path: root,
      owner: "example",
      name: "campaign-repository",
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    });
  return { root, stateDirectory, contractPath, server, environment };
}

async function acceptCampaignTask(
  context: Parameters<NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>>[0],
  merge = false,
  candidateSha?: string,
  mergeCommitSha?: string,
) {
  const { authority, contract, result } = context;
  const activation = await authority.reserveActivation(
    result.taskId,
    contract.budget.maxImplementerActivations,
  );
  const repositoryPath = result.repository?.path;
  if (!repositoryPath) throw new Error("Campaign fixture task has no repository snapshot");
  const sha =
    candidateSha ??
    (
      await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { cwd: repositoryPath })
    ).stdout.trim();
  const candidate = await authority.recordCandidate(
    { taskId: result.taskId, revision: activation.result.revision },
    { sha, baseSha: contract.baseSha, fence: activation.activation },
  );
  await authority.recordCheck(
    { taskId: result.taskId, revision: candidate.revision },
    { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
  );
  const reviewAttempt = await authority.reserveReviewAttempt(
    result.taskId,
    contract.budget.maxReviewCycles,
    "campaign-fixture-reviewer",
  );
  const reviewed = await authority.recordReview(
    { taskId: result.taskId, revision: reviewAttempt.result.revision },
    { sha, verdict: "approved", summary: "fixture approved", findings: [] },
    "campaign-fixture-reviewer",
  );
  return authority.recordDelivery(
    { taskId: result.taskId, revision: reviewed.revision },
    {
      sha,
      effect: "github",
      prNumber: result.taskId.endsWith("first") ? 1 : 2,
      url: "https://example.invalid/pull/1",
      attestationId: `fixture-${result.taskId}`,
      merge: merge
        ? {
            prNumber: result.taskId.endsWith("first") ? 1 : 2,
            approvedHeadSha: sha,
            mergeCommitSha: mergeCommitSha ?? sha,
            observedState: "merged" as const,
          }
        : null,
    },
  );
}

async function reviewCampaignTask(
  context: Parameters<NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>>[0],
) {
  const { authority, contract, result } = context;
  const activation = await authority.reserveActivation(
    result.taskId,
    contract.budget.maxImplementerActivations,
  );
  const repositoryPath = result.repository?.path;
  if (!repositoryPath) throw new Error("Campaign fixture task has no repository snapshot");
  const sha = (
    await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { cwd: repositoryPath })
  ).stdout.trim();
  const candidate = await authority.recordCandidate(
    { taskId: result.taskId, revision: activation.result.revision },
    { sha, baseSha: contract.baseSha, fence: activation.activation },
  );
  await authority.recordCheck(
    { taskId: result.taskId, revision: candidate.revision },
    { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
  );
  const reviewAttempt = await authority.reserveReviewAttempt(
    result.taskId,
    contract.budget.maxReviewCycles,
    "campaign-fixture-reviewer",
  );
  return authority.recordReview(
    { taskId: result.taskId, revision: reviewAttempt.result.revision },
    { sha, verdict: "approved", summary: "fixture approved", findings: [] },
    "campaign-fixture-reviewer",
  );
}

async function checkCampaignTask(
  context: Parameters<NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>>[0],
) {
  const { authority, contract, result } = context;
  const activation = await authority.reserveActivation(
    result.taskId,
    contract.budget.maxImplementerActivations,
  );
  const repositoryPath = result.repository?.path;
  if (!repositoryPath) throw new Error("Campaign fixture task has no repository snapshot");
  const sha = (
    await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { cwd: repositoryPath })
  ).stdout.trim();
  const candidate = await authority.recordCandidate(
    { taskId: result.taskId, revision: activation.result.revision },
    { sha, baseSha: contract.baseSha, fence: activation.activation },
  );
  return authority.recordCheck(
    { taskId: result.taskId, revision: candidate.revision },
    { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
  );
}

type CampaignExecutionContext = Parameters<
  NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>
>[0];

test("publishes a Campaign without process quota fields", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "usine-campaign-no-quotas-"));
  const contract = {
    schemaVersion: 1,
    id: "campaign-no-quotas",
    version: 1,
    objective: "Continue the authorized outcome",
    outcomes: [
      {
        id: "outcome-one",
        title: "Complete the outcome",
        acceptance: ["The outcome is complete."],
        dependsOn: [],
        parentId: null,
      },
    ],
    authority: {
      source: "user:campaign-no-quotas",
      publish: true,
      delivery: false,
      merge: false,
      repositories: [],
      effects: [],
    },
  };

  const published = await publishCampaignToState(stateDirectory, JSON.stringify(contract));
  expect(Object.hasOwn(published, "budget")).toBe(false);
  expect(Object.hasOwn(published, "warningThresholdMs")).toBe(false);
});

test("keeps the current Goal input and Campaign projection free of Planner budget", async () => {
  const current = goalContract();
  const legacy = {
    ...current,
    budget: { ...current.budget, maxPlannerActivations: 1 },
  };

  expect(() => parseGoalContract(JSON.stringify(legacy))).toThrow();

  const context = await fixture();
  const server = await start(context.stateDirectory);
  try {
    const campaign = await publishCampaign(server.url, { contractPath: context.contractPath });
    expect(campaign.budget).toEqual({
      maxElapsedMs: 60_000,
      maxTasks: 4,
      maxImplementerActivations: 0,
      maxReviewCycles: 0,
    });
    expect(Object.hasOwn(campaign.budget, "maxPlannerActivations")).toBe(false);
  } finally {
    await server.close();
  }
});

test("recovers a persisted legacy Goal publication after server restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "usine-campaign-legacy-goal-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const current = goalContract();
  const initial = await publishCampaignToState(stateDirectory, JSON.stringify(current));
  const legacy = {
    ...current,
    budget: { ...current.budget, maxPlannerActivations: 1 },
  };
  const legacyRaw = JSON.stringify(legacy);
  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    database
      .prepare("UPDATE campaigns SET contract = ?, contract_hash = ? WHERE campaign_id = ?")
      .run(
        legacyRaw,
        createHash("sha256").update(legacyRaw, "utf8").digest("hex"),
        initial.campaignId,
      );
  } finally {
    database.close();
  }

  await expect(lookupCampaign(stateDirectory, initial.campaignId)).resolves.toMatchObject({
    campaignId: initial.campaignId,
    budget: {
      maxElapsedMs: 60_000,
      maxTasks: 4,
      maxImplementerActivations: 0,
      maxReviewCycles: 0,
    },
  });

  const restarted = await start(stateDirectory);
  await restarted.close();
  const recovered = await lookupCampaign(stateDirectory, initial.campaignId);
  expect(recovered?.budget).toEqual({
    maxElapsedMs: 60_000,
    maxTasks: 4,
    maxImplementerActivations: 0,
    maxReviewCycles: 0,
  });
  expect(Object.hasOwn(recovered?.budget ?? {}, "maxPlannerActivations")).toBe(false);
});

async function rewriteTaskResult(
  stateDirectory: string,
  taskId: string,
  rewrite: (result: TaskResult) => TaskResult,
): Promise<void> {
  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    const row = database.prepare("SELECT result FROM task_runs WHERE task_id = ?").get(taskId) as
      | { result: string | TaskResult }
      | undefined;
    if (!row) throw new Error(`missing fixture Task ${taskId}`);
    const result =
      typeof row.result === "string" ? (JSON.parse(row.result) as TaskResult) : row.result;
    database
      .prepare("UPDATE task_runs SET result = ?, updated_at = ? WHERE task_id = ?")
      .run(JSON.stringify(rewrite(result)), Date.now(), taskId);
  } finally {
    database.close();
  }
}

async function replaceRawTaskResult(
  stateDirectory: string,
  taskId: string,
  rawResult: string,
): Promise<void> {
  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    database
      .prepare("UPDATE task_runs SET result = ?, updated_at = ? WHERE task_id = ?")
      .run(rawResult, Date.now(), taskId);
  } finally {
    database.close();
  }
}

async function detachedCampaignCommits(repositoryPath: string, baseSha: string) {
  const tree = (
    await execa("git", ["-C", repositoryPath, "rev-parse", `${baseSha}^{tree}`], {
      cwd: repositoryPath,
    })
  ).stdout.trim();
  const commitTree = async (...parents: string[]) =>
    (
      await execa(
        "git",
        [
          "-C",
          repositoryPath,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit-tree",
          tree,
          ...parents.flatMap((parent) => ["-p", parent]),
          "-m",
          parents.length === 1 ? "campaign candidate" : "campaign merge",
        ],
        { cwd: repositoryPath },
      )
    ).stdout.trim();
  const candidateSha = await commitTree(baseSha);
  const mergeCommitSha = await commitTree(baseSha, candidateSha);
  return { candidateSha, mergeCommitSha };
}

test("admits one Ready proposal through the Task leaf without a Task submission", async () => {
  let executions = 0;
  const { contractPath, server } = await frontierFixture(
    undefined,
    "user:campaign-366",
    async ({ authority, result, input }) => {
      executions += 1;
      expect(input.contractPath).toBeNull();
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "campaign fixture complete",
      );
    },
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    const proposed = await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("automatic-admission", "outcome-one"),
    );
    const ready = proposed.proposals?.[0]?.ready;
    expect(ready).toMatchObject({ repositoryId: "campaign-repository" });
    const taskId = "campaign-campaign-366-v1-automatic-admission";
    expect(ready?.taskId).toBeNull();
    await handoffCampaign(server.url, published.campaignId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (executions > 0) break;
    }
    expect(executions).toBe(1);
    await expect(taskStatus(server.url, taskId!)).resolves.toMatchObject({
      taskId,
      campaign: {
        campaignId: published.campaignId,
        goalId: "campaign-366",
        goalVersion: 1,
        outcomeId: "outcome-one",
      },
    });
  } finally {
    await server.close();
  }
});

test("delivers a quota-free Campaign leaf without count or deadline ceilings", async () => {
  let executions = 0;
  const fixtureValue = await frontierFixture(
    oneOutcomeFrontierGoal("campaign-repository"),
    "user:campaign-366",
    async (context) => {
      executions += 1;
      expect(context.input.contractPath).toBeNull();
      const repository = context.result.repository;
      if (!repository) throw new Error("quota-free Campaign Task has no repository snapshot");
      const contract = resolveTaskContract(context.contract, repository);
      expect(contract.budget).toEqual({
        maxImplementerActivations: null,
        maxReviewCycles: null,
        maxElapsedMs: null,
      });
      expect(context.result.deadlineEpochMs).toBeUndefined();
      const workspace = new CandidateWorkspace({
        repository: repository.path,
        stateDirectory: context.policy.stateDirectory,
        credentialFreeGit: credentialFreeGitEnvironment(context.policy.workerEnvironment),
        gitAuthor: repository.gitAuthor,
        signal: context.signal,
      });
      let reviewCount = 0;
      const session = new CodexCodingSession(
        (async (request) => {
          const thread = {
            id: `quota-free-${request.role}`,
            runStreamed: async () => ({
              events: (async function* () {
                yield { type: "thread.started", thread_id: `quota-free-${request.role}` };
                yield { type: "turn.started" };
                const sha = (
                  await execa("git", ["-C", request.workspace, "rev-parse", "HEAD"], {
                    cwd: request.workspace,
                  })
                ).stdout.trim();
                const reviewer = request.role === "reviewer";
                if (!reviewer)
                  await writeFile(
                    join(request.workspace, `quota-free-${reviewCount}.txt`),
                    "quota-free implementation\n",
                  );
                const output = reviewer
                  ? {
                      sha,
                      verdict: reviewCount++ < 2 ? "changes_requested" : "approved",
                      summary: "quota-free fixture review",
                      findings: reviewCount < 3 ? ["continue the quota-free fixture"] : [],
                    }
                  : { status: "proposed", summary: "quota-free fixture implementation" };
                yield {
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    id: `quota-free-${request.role}-message`,
                    text: JSON.stringify(output),
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 12,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    output_tokens: 7,
                    reasoning_output_tokens: 0,
                  },
                };
              })(),
            }),
          } as unknown as ReturnType<
            Awaited<ReturnType<CodingSessionClientFactory>>["startThread"]
          >;
          return { startThread: () => thread } as Awaited<ReturnType<CodingSessionClientFactory>>;
        }) satisfies CodingSessionClientFactory,
        {
          environment: context.policy.workerEnvironment,
          profileResolver: async () => ({ model: "quota-free-fixture-model" }),
        },
      );
      const quality = new QualityGate({
        workspace,
        session,
        reviewer: context.policy.roles.reviewer,
        environment: context.policy.workerEnvironment,
        signal: context.signal,
      });
      const services: DeliveryRunServices = {
        authority: context.authority,
        workspace,
        session,
        quality,
        forge: {
          deliver: async (_contract, sha, _check, _review) => ({
            sha,
            effect: "github" as const,
            prNumber: 1,
            url: "https://example.invalid/pull/1",
            attestationId: `quota-free-${context.result.taskId}`,
            merge: null,
          }),
        },
      };
      return executeDeliveryRun(
        {
          contract,
          contractHash: context.result.contractHash,
          repositoryIdentity: context.result.writer.repositoryIdentity,
          deadlineEpochMs: context.result.deadlineEpochMs,
          implementer: context.policy.roles.implementer,
          reviewer: context.policy.roles.reviewer,
          signal: context.signal,
        },
        services,
      );
    },
  );
  const { contractPath, server } = fixtureValue;
  try {
    const published = await publishCampaign(server.url, { contractPath });
    expect(Object.hasOwn(published, "budget")).toBe(false);
    const proposed = await proposeCampaign(
      server.url,
      published.campaignId,
      quotaFreeFrontierProposal("quota-free-delivery", "outcome-one") as never,
    );
    expect(Object.hasOwn(proposed.proposals?.[0]?.ready ?? {}, "budget")).toBe(false);
    await handoffCampaign(server.url, published.campaignId);
    let delivered = await taskStatus(server.url, "campaign-campaign-366-v1-quota-free-delivery");
    for (let attempt = 0; attempt < 300 && delivered?.state !== "reviewed_pr"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      delivered = await taskStatus(server.url, "campaign-campaign-366-v1-quota-free-delivery");
    }
    expect(delivered).toMatchObject({ state: "reviewed_pr" });
    expect(executions).toBe(1);
    await expect(
      taskStatus(server.url, "campaign-campaign-366-v1-quota-free-delivery"),
    ).resolves.toMatchObject({
      state: "reviewed_pr",
      delivery: { merge: null },
      check: { status: "passed" },
      review: { verdict: "approved" },
      evidence: { implementerActivations: 3, reviewCycles: 3, changesRequestedBatches: 2 },
    });
  } finally {
    await server.close();
  }
});

test("rejects an unbounded child under a finite Goal and round-trips an unbounded Campaign budget", async () => {
  const finite = await frontierFixture();
  try {
    const published = await publishCampaign(finite.server.url, {
      contractPath: finite.contractPath,
    });
    for (const field of ["maxImplementerActivations", "maxReviewCycles"] as const) {
      const proposalId = `unbounded-${field}`;
      const rejected = await proposeCampaign(finite.server.url, published.campaignId, {
        ...frontierProposal(proposalId, "outcome-one"),
        budget: {
          maxImplementerActivations: 1,
          maxReviewCycles: 1,
          maxElapsedMs: 10_000,
          [field]: null,
        },
      });
      expect(
        rejected.proposals?.find((proposal) => proposal.proposalId === proposalId),
      ).toMatchObject({
        status: "blocked",
        blocker: "proposal budget is outside the Goal budget envelope",
        ready: null,
      });
    }
  } finally {
    await finite.server.close();
  }

  const goal = frontierGoal("campaign-repository");
  const unbounded = await frontierFixture({
    ...goal,
    budget: {
      ...goal.budget,
      maxImplementerActivations: null,
      maxReviewCycles: null,
    },
  });
  try {
    const published = await publishCampaign(unbounded.server.url, {
      contractPath: unbounded.contractPath,
    });
    expect(published.budget).toMatchObject({
      maxImplementerActivations: null,
      maxReviewCycles: null,
    });

    const proposal = await proposeCampaign(unbounded.server.url, published.campaignId, {
      ...frontierProposal("unbounded-child", "outcome-one"),
      budget: {
        maxImplementerActivations: null,
        maxReviewCycles: null,
        maxElapsedMs: 10_000,
      },
    });
    expect(proposal.proposals?.[0]?.ready?.budget).toMatchObject({
      maxImplementerActivations: null,
      maxReviewCycles: null,
    });

    await expect(getCampaign(unbounded.server.url, published.campaignId)).resolves.toMatchObject({
      budget: {
        maxImplementerActivations: null,
        maxReviewCycles: null,
      },
      proposals: [
        {
          ready: {
            budget: {
              maxImplementerActivations: null,
              maxReviewCycles: null,
            },
          },
        },
      ],
    });
  } finally {
    await unbounded.server.close();
  }
});

test("does not admit a proposal that expands Goal authority or budget", async () => {
  let executions = 0;
  const { contractPath, server } = await frontierFixture(
    undefined,
    "user:campaign-366",
    async () => {
      executions += 1;
      throw new Error("an unauthorized proposal must not reach the leaf");
    },
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    const outsideEffect = await proposeCampaign(server.url, published.campaignId, {
      ...frontierProposal("outside-effect", "outcome-one"),
      effects: ["github", "shell"],
    });
    expect(outsideEffect.proposals?.[0]).toMatchObject({
      status: "blocked",
      blocker: "proposal effect is outside the Goal authority envelope",
      ready: null,
    });
    const mergeExpansion = await proposeCampaign(server.url, published.campaignId, {
      ...frontierProposal("merge-expansion", "outcome-one"),
      merge: true,
    });
    expect(mergeExpansion.proposals?.[1]).toMatchObject({
      status: "blocked",
      blocker: "proposal merge authority is outside the Goal authority envelope",
      ready: null,
    });
    const budgetExpansion = await proposeCampaign(server.url, published.campaignId, {
      ...frontierProposal("budget-expansion", "outcome-one"),
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_001 },
    });
    expect(budgetExpansion.proposals?.[2]).toMatchObject({
      status: "blocked",
      blocker: "proposal budget is outside the Goal budget envelope",
      ready: null,
    });
    expect(executions).toBe(0);
    await expect(serverSnapshot(server.url)).resolves.toMatchObject({ tasks: [] });
  } finally {
    await server.close();
  }
});

test("holds the next Ready proposal at active capacity and admits it after release", async () => {
  let executions = 0;
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { contractPath, server } = await frontierFixture(
    undefined,
    "user:campaign-366",
    async ({ authority, result }) => {
      executions += 1;
      if (executions === 1) await firstRelease;
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "capacity fixture complete",
      );
    },
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    const first = await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("capacity-first", "outcome-one"),
    );
    const second = await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("capacity-second", "outcome-one"),
    );
    expect(executions).toBe(0);
    await handoffCampaign(server.url, published.campaignId);
    expect(first.proposals?.[0]?.ready?.taskId).toBeNull();
    expect(second.proposals?.[1]?.ready?.taskId).toBeNull();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (executions >= 1) break;
    }
    expect(executions).toBe(1);

    releaseFirst();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (executions >= 2) break;
    }
    expect(executions).toBe(2);
    const snapshot = await serverSnapshot(server.url);
    expect(snapshot.tasks.map((task) => task.taskId)).toEqual([
      "campaign-campaign-366-v1-capacity-first",
      "campaign-campaign-366-v1-capacity-second",
    ]);
  } finally {
    releaseFirst();
    await server.close();
  }
});

test("admits unrelated Ready work while an assessor remains pending", async () => {
  const firstContract = oneOutcomeFrontierGoal("campaign-repository");
  const secondContract = {
    ...firstContract,
    id: "campaign-367",
  };
  let assessorEntered!: () => void;
  const assessorStarted = new Promise<void>((resolve) => {
    assessorEntered = resolve;
  });
  let releaseAssessor!: () => void;
  const assessorRelease = new Promise<void>((resolve) => {
    releaseAssessor = resolve;
  });
  const ordering: string[] = [];
  let executions = 0;
  let executionEntered!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    executionEntered = resolve;
  });
  const assessor: CampaignOutcomeAssessor = async () => {
    ordering.push("assessor-start");
    assessorEntered();
    await assessorRelease;
    return {
      verdict: "inconclusive",
      summary: "the fixture assessor is still pending",
      gaps: [],
      evidence: [],
      usage: null,
    };
  };
  const { root, contractPath, server } = await frontierFixture(
    firstContract,
    "user:campaign-366",
    async ({ authority, result }) => {
      executions += 1;
      ordering.push(`execute:${result.taskId}`);
      executionEntered();
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "controlled reproduction complete",
      );
    },
    2,
    true,
    assessor,
  );
  const secondContractPath = join(root, "second-goal.json");
  await writeFile(secondContractPath, JSON.stringify(secondContract));
  await execa("git", ["add", "second-goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize second campaign"], { cwd: root });
  try {
    const first = await publishCampaign(server.url, { contractPath });
    const second = await publishCampaign(server.url, { contractPath: secondContractPath });
    await proposeCampaign(
      server.url,
      second.campaignId,
      frontierProposal("independent-ready", "outcome-one"),
    );

    const firstHandoff = handoffCampaign(server.url, first.campaignId);
    await assessorStarted;
    const secondHandoff = handoffCampaign(server.url, second.campaignId);
    await executionStarted;

    expect(executions).toBe(1);
    expect(ordering).toEqual([
      "assessor-start",
      "execute:campaign-campaign-367-v1-independent-ready",
    ]);

    releaseAssessor();
    await Promise.all([firstHandoff, secondHandoff]);
    for (let attempt = 0; attempt < 100 && executions === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executions).toBe(1);
    expect(ordering.slice(0, 2)).toEqual([
      "assessor-start",
      "execute:campaign-campaign-367-v1-independent-ready",
    ]);
  } finally {
    releaseAssessor();
    await server.close();
  }
});

test("admits unrelated Ready work while a replacement planner remains pending", async () => {
  const firstContract = oneOutcomeFrontierGoal("campaign-repository");
  const secondContract = { ...firstContract, id: "campaign-367" };
  let replacementEntered!: () => void;
  const replacementStarted = new Promise<void>((resolve) => {
    replacementEntered = resolve;
  });
  let releaseReplacement!: () => void;
  const replacementRelease = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let executionEntered!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    executionEntered = resolve;
  });
  const ordering: string[] = [];
  let replacementCalls = 0;
  let executions = 0;
  const assessor: CampaignOutcomeAssessor = async () => ({
    verdict: "gaps",
    summary: "the empty frontier remains incomplete",
    gaps: ["the fixture requires a replacement"],
    evidence: [],
    usage: null,
  });
  const replacementGenerator: CampaignReplacementGenerator = async () => {
    replacementCalls += 1;
    ordering.push("replacement-start");
    replacementEntered();
    await replacementRelease;
    return { proposal: null, usage: null };
  };
  const { root, contractPath, server, stateDirectory } = await frontierFixture(
    firstContract,
    "user:campaign-366",
    async ({ authority, result }) => {
      executions += 1;
      ordering.push(`execute:${result.taskId}`);
      executionEntered();
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "controlled replacement reproduction complete",
      );
    },
    2,
    true,
    assessor,
    replacementGenerator,
  );
  const secondContractPath = join(root, "second-goal.json");
  await writeFile(secondContractPath, JSON.stringify(secondContract));
  await execa("git", ["add", "second-goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize second campaign"], { cwd: root });
  try {
    const first = await publishCampaign(server.url, { contractPath });
    const second = await publishCampaign(server.url, { contractPath: secondContractPath });
    await proposeCampaign(
      server.url,
      second.campaignId,
      frontierProposal("independent-ready", "outcome-one"),
    );

    await handoffCampaign(server.url, first.campaignId);
    await replacementStarted;
    await handoffCampaign(server.url, second.campaignId);
    await executionStarted;

    expect(replacementCalls).toBe(1);
    expect(executions).toBe(1);
    expect(ordering.slice(0, 2)).toEqual([
      "replacement-start",
      "execute:campaign-campaign-367-v1-independent-ready",
    ]);
    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
          )
          .get(first.campaignId, "outcome-one"),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ? AND task_id IS NOT NULL",
          )
          .get(second.campaignId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  } finally {
    releaseReplacement();
    await server.close();
  }
});

test("keeps same-Repository Ready proposals serial with spare active capacity", async () => {
  let executions = 0;
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { contractPath, server } = await frontierFixture(
    undefined,
    "user:campaign-366",
    async ({ authority, result }) => {
      executions += 1;
      if (executions === 1) await firstRelease;
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "same Repository serialization fixture complete",
      );
    },
    2,
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("serial-first", "outcome-one"),
    );
    const second = await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("serial-second", "outcome-one"),
    );
    expect(executions).toBe(0);
    await handoffCampaign(server.url, published.campaignId);
    expect(second.proposals?.[1]?.ready?.taskId).toBeNull();
    expect(executions).toBe(1);
    await expect(serverSnapshot(server.url)).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: "campaign-campaign-366-v1-serial-first" })],
    });

    releaseFirst();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (executions >= 2) break;
    }
    expect(executions).toBe(2);
    await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
      proposals: [
        expect.objectContaining({ status: "ready" }),
        expect.objectContaining({
          status: "ready",
          ready: expect.objectContaining({ taskId: "campaign-campaign-366-v1-serial-second" }),
        }),
      ],
    });
  } finally {
    releaseFirst();
    await server.close();
  }
});

test("bounds generated Campaign PR titles without truncating instructions", async () => {
  const outcomeTitle = `Ship the outcome \u001b[31m${"x".repeat(500)}`;
  const contract = {
    ...frontierGoal("campaign-repository"),
    outcomes: [
      { ...frontierGoal("campaign-repository").outcomes[0], title: outcomeTitle },
      ...frontierGoal("campaign-repository").outcomes.slice(1),
    ],
  };
  const instructions = `Implement the proposal ${"i".repeat(500)}`;
  let observedTitle = "";
  let observedInstructions = "";
  let observedBody = "";
  let observedIssue: number | undefined;
  const goalIssue = "https://github.com/example/usine/issues/366";
  const authorizedContract = {
    ...contract,
    authority: { ...contract.authority, source: goalIssue },
  };
  const { contractPath, server } = await frontierFixture(
    authorizedContract,
    goalIssue,
    async ({ authority, result, contract: taskContract }) => {
      observedTitle = taskContract.delivery.title;
      observedInstructions = taskContract.instructions;
      observedBody = taskContract.delivery.body;
      observedIssue = taskContract.delivery.issue;
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "title fixture complete",
      );
    },
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    const proposal = await proposeCampaign(server.url, published.campaignId, {
      ...frontierProposal("bounded-title", "outcome-one"),
      instructions,
      acceptance: ["The bounded task is complete."],
      delivery: { issue: 123 },
    });
    expect(proposal.proposals?.at(-1)?.ready?.delivery).toEqual({ issue: 123 });
    await handoffCampaign(server.url, published.campaignId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (observedTitle !== "") break;
    }
    expect(observedInstructions).toBe(instructions);
    expect(observedIssue).toBe(123);
    expect(observedTitle).toHaveLength(256);
    expect(observedTitle).not.toContain("Campaign");
    expect(observedBody).toContain("Outcome: Ship the outcome");
    expect(observedBody).toContain("Acceptance criteria:");
    expect(observedBody).toContain("- The bounded task is complete.");
    expect(observedBody).toContain(`Goal: ${goalIssue}`);
    expect(observedBody).not.toContain("campaign-366");
    expect(observedBody).not.toContain("bounded-title");
    expect(observedBody).not.toContain("provider");
    expect(observedBody).not.toContain("model");
    expect(observedTitle).not.toContain("undefined");
    expect(Array.from(observedTitle).some((character) => character.codePointAt(0)! < 0x20)).toBe(
      false,
    );
  } finally {
    await server.close();
  }
});

test("uses a neutral Campaign PR fallback when the Outcome title sanitizes to empty", async () => {
  const contract = {
    ...frontierGoal("campaign-repository"),
    outcomes: [
      { ...frontierGoal("campaign-repository").outcomes[0], title: "\u001b" },
      ...frontierGoal("campaign-repository").outcomes.slice(1),
    ],
  };
  let observedTitle = "";
  let observedBody = "";
  const { contractPath, server } = await frontierFixture(
    contract,
    "user:campaign-366",
    async ({ authority, result, contract: taskContract }) => {
      observedTitle = taskContract.delivery.title;
      observedBody = taskContract.delivery.body;
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "empty title fixture complete",
      );
    },
  );
  try {
    const published = await publishCampaign(server.url, { contractPath });
    await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("empty-title", "outcome-one"),
    );
    await handoffCampaign(server.url, published.campaignId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (observedTitle !== "") break;
    }
    expect(observedTitle).toBe("Authorized outcome");
    expect(observedBody).toContain("Outcome: Authorized outcome");
    expect(observedTitle).not.toContain("Campaign");
    expect(observedBody).not.toContain("Campaign");
  } finally {
    await server.close();
  }
});

test("does not admit a Campaign Task during startup before plan handoff", async () => {
  const fixtureValue = await frontierFixture(undefined, "user:campaign-366", undefined, 1, true);
  const { contractPath, stateDirectory, server: seededServer } = fixtureValue;
  const published = await publishCampaign(seededServer.url, { contractPath });
  await proposeCampaign(
    seededServer.url,
    published.campaignId,
    frontierProposal("startup-admission", "outcome-one"),
  );
  expect((await serverSnapshot(seededServer.url)).tasks).toEqual([]);
  await seededServer.close();

  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_GOAL_PUBLICATION_SOURCE: "user:campaign-366",
    USINE_ACTIVE_TASK_CAPACITY: "1",
    USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/campaign-repository",
  };
  let executions = 0;
  const server = await startUsineServer({
    environment,
    execute: async ({ authority, result }) => {
      executions += 1;
      return authority.block(
        { taskId: result.taskId, revision: result.revision },
        "startup admission fixture complete",
      );
    },
    host: "127.0.0.1",
    port: 0,
  });
  try {
    expect((await serverSnapshot(server.url)).tasks).toEqual([]);
    await handoffCampaign(server.url, published.campaignId);
    await expect(
      taskStatus(server.url, "campaign-campaign-366-v1-startup-admission"),
    ).resolves.toMatchObject({ state: "blocked", evidence: { restartRecoveries: 0 } });
    expect(executions).toBe(1);
  } finally {
    await server.close();
  }
});

test("restarts an admitted Campaign leaf without duplicating its Task", async () => {
  let executions = 0;
  const paused = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    void timer;
  });
  const execute = async ({
    signal,
    authority,
    result,
  }: Parameters<NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>>[0]) => {
    executions += 1;
    await Promise.race([
      paused,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    return (await authority.lookup(result.taskId)) ?? result;
  };
  const fixtureValue = await frontierFixture(undefined, "user:campaign-366", execute);
  const { contractPath, stateDirectory, server } = fixtureValue;
  try {
    const published = await publishCampaign(server.url, { contractPath });
    const proposed = await proposeCampaign(
      server.url,
      published.campaignId,
      frontierProposal("restartable", "outcome-one"),
    );
    expect(proposed.proposals?.[0]?.ready?.taskId).toBeNull();
    const taskId = "campaign-campaign-366-v1-restartable";
    await handoffCampaign(server.url, published.campaignId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (executions > 0) break;
    }
    expect(executions).toBe(1);
    await server.close();

    const restarted = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
        USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
        USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:9",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/campaign-repository",
      },
      execute,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (executions >= 2) break;
      }
      expect(executions).toBe(2);
      await expect(serverSnapshot(restarted.url)).resolves.toMatchObject({
        tasks: [expect.objectContaining({ taskId })],
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await server.close().catch(() => undefined);
  }
});

describe("Campaign publication boundary", () => {
  test("requires explicit publication authority and does not accept role prose", async () => {
    const { root, stateDirectory, contractPath } = await fixture();
    const unpublishedPath = join(root, "role-response.json");
    await writeFile(unpublishedPath, JSON.stringify({ response: "Please publish this." }));
    const unauthorizedPath = join(root, "unauthorized-goal.json");
    const unauthorizedContract = goalContract();
    await writeFile(
      unauthorizedPath,
      JSON.stringify({
        ...unauthorizedContract,
        authority: { ...unauthorizedContract.authority, publish: false },
      }),
    );
    await execa("git", ["add", "unauthorized-goal.json"], { cwd: root });
    await execa("git", ["commit", "-m", "record unauthorized goal"], { cwd: root });
    const server = await start(stateDirectory);
    try {
      await expect(
        publishCampaign(server.url, { contractPath: unpublishedPath }),
      ).rejects.toMatchObject({ status: 400, diagnostic: "validation" });
      await expect(
        publishCampaign(server.url, { contractPath: unauthorizedPath }),
      ).rejects.toMatchObject({ status: 400, diagnostic: "validation" });
      await expect(getCampaign(server.url, "campaign-365:v1")).resolves.toBeNull();
      await expect(publishCampaign(server.url, { contractPath })).resolves.toMatchObject({
        campaignId: "campaign-365:v1",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects cyclic parent and dependency relationships", async () => {
    const { root, stateDirectory } = await fixture();
    const base = goalContract();
    const cyclicPath = join(root, "cyclic-goal.json");
    await writeFile(
      cyclicPath,
      JSON.stringify({
        ...base,
        outcomes: [
          { ...base.outcomes[0], parentId: "outcome-child", dependsOn: ["outcome-child"] },
          { ...base.outcomes[1], parentId: "outcome-root", dependsOn: ["outcome-root"] },
        ],
      }),
    );
    await execa("git", ["add", "cyclic-goal.json"], { cwd: root });
    await execa("git", ["commit", "-m", "record cyclic goal"], { cwd: root });
    const server = await start(stateDirectory);
    try {
      await expect(publishCampaign(server.url, { contractPath: cyclicPath })).rejects.toMatchObject(
        {
          status: 400,
          diagnostic: "validation",
        },
      );
      await expect(getCampaign(server.url, "campaign-365:v1")).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  test("is idempotent for the same bytes and rejects content drift", async () => {
    const { root, stateDirectory, contractPath } = await fixture();
    const driftPath = join(root, "goal-drift.json");
    await writeFile(driftPath, JSON.stringify(goalContract("A different committed goal")));
    await execa("git", ["add", "goal-drift.json"], { cwd: root });
    await execa("git", ["commit", "-m", "drift goal"], { cwd: root });
    const server = await start(stateDirectory);
    try {
      const first = await publishCampaign(server.url, { contractPath });
      const repeated = await publishCampaign(server.url, { contractPath });
      expect(repeated).toEqual(first);
      await expect(publishCampaign(server.url, { contractPath: driftPath })).rejects.toMatchObject({
        status: 409,
        diagnostic: "campaign_content_conflict",
      });
      await expect(getCampaign(server.url, first.campaignId)).resolves.toEqual(first);
    } finally {
      await server.close();
    }
  });

  test("reconstructs the same Campaign projection after server restart", async () => {
    const { stateDirectory, contractPath } = await fixture();
    const firstServer = await start(stateDirectory);
    let published;
    try {
      published = await publishCampaign(firstServer.url, { contractPath });
    } finally {
      await firstServer.close();
    }

    const restarted = await start(stateDirectory);
    try {
      await expect(getCampaign(restarted.url, published.campaignId)).resolves.toEqual(published);
    } finally {
      await restarted.close();
    }
  });

  test("does not replace a corrupt durable status while reading", async () => {
    const { stateDirectory, contractPath } = await fixture();
    const firstServer = await start(stateDirectory);
    let published;
    try {
      published = await publishCampaign(firstServer.url, { contractPath });
    } finally {
      await firstServer.close();
    }

    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    database
      .prepare("UPDATE campaigns SET status = ? WHERE campaign_id = ?")
      .run("corrupt", published.campaignId);
    database.close();

    const restarted = await start(stateDirectory);
    try {
      await expect(getCampaign(restarted.url, published.campaignId)).rejects.toMatchObject({
        status: 503,
        diagnostic: "campaign_state_quarantined",
      });
      await expect(getCampaign(restarted.url, published.campaignId)).rejects.toMatchObject({
        status: 503,
        diagnostic: "campaign_state_quarantined",
      });
    } finally {
      await restarted.close();
    }
  });

  test("does not accept corrupt durable decision request JSON while reading", async () => {
    const { stateDirectory, contractPath } = await fixture();
    const firstServer = await start(stateDirectory);
    let published;
    try {
      published = await publishCampaign(firstServer.url, { contractPath });
    } finally {
      await firstServer.close();
    }

    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    database
      .prepare("UPDATE campaigns SET decision_request = ? WHERE campaign_id = ?")
      .run(JSON.stringify({ reason: "corrupt" }), published.campaignId);
    database.close();

    const restarted = await start(stateDirectory);
    try {
      await expect(getCampaign(restarted.url, published.campaignId)).rejects.toMatchObject({
        status: 503,
        diagnostic: "campaign_state_quarantined",
      });
    } finally {
      await restarted.close();
    }
  });

  test.each(["status", "decision_request"] as const)(
    "returns one typed quarantine across Campaign public paths for corrupt %s",
    async (field) => {
      const { stateDirectory, contractPath } = await fixture();
      const server = await start(stateDirectory);
      const published = await publishCampaign(server.url, { contractPath });
      const corruptDecisionRequest = JSON.stringify({ reason: "corrupt" });
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      database
        .prepare(`UPDATE campaigns SET ${field} = ? WHERE campaign_id = ?`)
        .run(field === "status" ? "corrupt" : corruptDecisionRequest, published.campaignId);
      database.close();

      const proposal = {
        proposalId: "quarantined-proposal",
        outcomeId: "outcome-root",
        dependsOn: [],
        repositoryId: "campaign-repository",
        instructions: "Do not execute this proposal.",
        acceptance: ["The proposal remains unadmitted."],
        nonGoals: [],
        effects: ["github"],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
        merge: false,
      };
      const publicReads = [
        () => getCampaign(server.url, published.campaignId),
        () => campaignEvidence(server.url, published.campaignId),
        () => proposeCampaign(server.url, published.campaignId, proposal),
        () => handoffCampaign(server.url, published.campaignId),
        () => abandonCampaign(server.url, published.campaignId),
        () => recordCampaignDecisionTouch(server.url, published.campaignId, "quarantine-touch"),
      ];
      try {
        for (const read of publicReads)
          await expect(read()).rejects.toMatchObject({
            status: 503,
            diagnostic: "campaign_state_quarantined",
          });

        const preserved = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        const row = preserved
          .prepare("SELECT status, decision_request FROM campaigns WHERE campaign_id = ?")
          .get(published.campaignId) as { status: string; decision_request: string | null };
        preserved.close();
        expect(row.status).toBe(field === "status" ? "corrupt" : "planning");
        expect(row.decision_request).toBe(
          field === "decision_request" ? corruptDecisionRequest : null,
        );
      } finally {
        await server.close();
      }
    },
  );

  test("one corrupt Campaign does not block healthy Campaign reconciliation or admission", async () => {
    const fixtureValue = await frontierFixture(
      undefined,
      "user:campaign-366",
      async ({ result }) => result,
    );
    const { root, stateDirectory, contractPath, server } = fixtureValue;
    try {
      const corrupt = await publishCampaign(server.url, { contractPath });
      const corruptDatabase = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      corruptDatabase
        .prepare("UPDATE campaigns SET status = ? WHERE campaign_id = ?")
        .run("corrupt", corrupt.campaignId);
      corruptDatabase.close();

      const healthyContractPath = join(root, "healthy-goal.json");
      await writeFile(
        healthyContractPath,
        JSON.stringify({
          ...frontierGoal("campaign-repository"),
          id: "campaign-healthy",
          authority: { ...frontierGoal("campaign-repository").authority },
        }),
      );
      await execa("git", ["add", "healthy-goal.json"], { cwd: root });
      await execa("git", ["commit", "-m", "authorize healthy goal"], { cwd: root });

      const healthy = await publishCampaign(server.url, { contractPath: healthyContractPath });
      await proposeCampaign(
        server.url,
        healthy.campaignId,
        frontierProposal("healthy-proposal", "outcome-one"),
      );
      const handedOff = await handoffCampaign(server.url, healthy.campaignId);
      expect(handedOff.proposals?.[0]?.ready?.taskId).toBe(
        "campaign-campaign-healthy-v1-healthy-proposal",
      );
      await expect(getCampaign(server.url, healthy.campaignId)).resolves.toMatchObject({
        campaignId: healthy.campaignId,
        planHandedOff: true,
      });

      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      const corruptRow = database
        .prepare("SELECT status FROM campaigns WHERE campaign_id = ?")
        .get(corrupt.campaignId) as { status: string };
      const healthyProposal = database
        .prepare("SELECT task_id FROM campaign_proposals WHERE campaign_id = ?")
        .get(healthy.campaignId) as { task_id: string | null };
      database.close();
      expect(corruptRow.status).toBe("corrupt");
      expect(healthyProposal.task_id).toBe("campaign-campaign-healthy-v1-healthy-proposal");
    } finally {
      await server.close();
    }
  });
});

describe("durable Ready frontier", () => {
  test("projects dependency-free work Ready and keeps its dependent planned", async () => {
    const { root, stateDirectory, contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const first = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("proposal-one", "outcome-one"),
      );
      expect(first.proposals).toMatchObject([
        {
          proposalId: "proposal-one",
          sequence: 1,
          status: "ready",
          ready: { repositoryId: "campaign-repository" },
        },
      ]);
      const baseSha = first.proposals?.[0]?.ready?.baseSha;
      expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
      const registeredHead = (
        await execa("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim();
      expect(baseSha).toBe(registeredHead);
      expect(first.proposals?.[0]?.ready).not.toHaveProperty("baseSha", undefined);
      await expect(
        proposeCampaign(server.url, published.campaignId, {
          ...frontierProposal("proposal-with-base", "outcome-one"),
          baseSha,
        }),
      ).rejects.toMatchObject({ status: 400, diagnostic: "validation" });

      const second = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("proposal-two", "outcome-two", ["proposal-one"]),
      );
      expect(second.proposals).toMatchObject([
        { proposalId: "proposal-one", sequence: 1, status: "ready" },
        {
          proposalId: "proposal-two",
          sequence: 2,
          status: "planned",
          blocker: "proposal dependency has no accepted delivery",
          ready: null,
        },
      ]);
      expect(
        (
          await proposeCampaign(
            server.url,
            published.campaignId,
            frontierProposal("proposal-one", "outcome-one"),
          )
        ).proposals,
      ).toEqual(second.proposals);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        proposals: second.proposals,
      });
      await writeFile(join(root, "head-advanced.txt"), "the registered head advances\n");
      await execa("git", ["add", "head-advanced.txt"], { cwd: root });
      await execa("git", ["commit", "-m", "advance registered head"], { cwd: root });
      await server.close();
      const restarted = await start(stateDirectory);
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          proposals: second.proposals,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("releases a same-Repository successor after accepted merge and launches it automatically", async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executionIds: string[] = [];
    let acceptedMergeSha: string | undefined;
    let successorBaseSha: string | undefined;
    const fixtureValue = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        executionIds.push(context.result.taskId);
        if (context.result.taskId.endsWith("-first")) {
          firstStarted();
          await firstGate;
          const accepted = await acceptCampaignTask(
            context,
            true,
            detached.candidateSha,
            detached.mergeCommitSha,
          );
          acceptedMergeSha = accepted.delivery?.merge?.mergeCommitSha;
          return accepted;
        }
        successorBaseSha = context.contract.baseSha;
        const repositoryPath = context.result.repository?.path;
        if (!repositoryPath) throw new Error("successor fixture task has no repository snapshot");
        const workspace = new CandidateWorkspace({
          repository: repositoryPath,
          stateDirectory: fixtureValue.stateDirectory,
          deadlineEpochMs: Date.now() + 30_000,
          credentialFreeGit: credentialFreeGitEnvironment(process.env),
          gitAuthor: { name: "Test", email: "test@example.invalid" },
        });
        const writer = await workspace.prepareWriter(
          context.contract.id,
          1,
          context.contract.baseSha,
        );
        expect((await execa("git", ["-C", writer.path, "rev-parse", "HEAD"])).stdout).toBe(
          context.contract.baseSha,
        );
        await workspace.quarantine(writer);
        return context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "successor fixture complete",
        );
      },
    );
    const { contractPath, server } = fixtureValue;
    const originalHead = (
      await execa("git", ["-C", fixtureValue.root, "rev-parse", "HEAD"], {
        cwd: fixtureValue.root,
      })
    ).stdout.trim();
    const detached = await detachedCampaignCommits(fixtureValue.root, originalHead);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("first", "outcome-one", [], true),
      );
      const beforeAcceptance = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("second", "outcome-two", ["first"], true),
      );
      expect(beforeAcceptance.proposals?.[1]).toMatchObject({
        proposalId: "second",
        status: "planned",
      });
      await handoffCampaign(server.url, published.campaignId);
      await firstStartedPromise;

      releaseFirst();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (successorBaseSha !== undefined) break;
      }
      expect(executionIds).toEqual([
        "campaign-campaign-366-v1-first",
        "campaign-campaign-366-v1-second",
      ]);
      expect(acceptedMergeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(acceptedMergeSha).not.toBe(originalHead);
      expect(acceptedMergeSha).not.toBe(detached.candidateSha);
      expect(successorBaseSha).toBe(acceptedMergeSha);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        proposals: [
          expect.objectContaining({ proposalId: "first", status: "ready" }),
          expect.objectContaining({
            proposalId: "second",
            status: "ready",
            ready: expect.objectContaining({ baseSha: acceptedMergeSha }),
          }),
        ],
      });
    } finally {
      releaseFirst();
      await server.close();
    }
  });

  test("reuses unchanged Task facts for shared Campaign dependencies", async () => {
    const fixtureValue = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-shared-first"))
          return acceptCampaignTask(context, true);
        return checkCampaignTask(context);
      },
    );
    const { contractPath, stateDirectory, server, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("shared-first", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("shared-second-a", "outcome-two", ["shared-first"]),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("shared-second-b", "outcome-two", ["shared-first"]),
      );
      await handoffCampaign(server.url, published.campaignId);
      await waitFor(
        async () => ({
          campaign: await getCampaign(server.url, published.campaignId),
          predecessor: await taskStatus(server.url, "campaign-campaign-366-v1-shared-first").catch(
            () => null,
          ),
          dependent: await taskStatus(server.url, "campaign-campaign-366-v1-shared-second-a").catch(
            () => null,
          ),
        }),
        ({ campaign, predecessor, dependent }) =>
          predecessor?.state === "merged" &&
          predecessor.delivery?.merge?.observedState === "merged" &&
          typeof predecessor.delivery.merge.mergeCommitSha === "string" &&
          dependent?.state === "checked" &&
          campaign?.proposals?.filter((proposal) =>
            ["shared-second-a", "shared-second-b"].includes(proposal.proposalId),
          ).length === 2 &&
          campaign.proposals
            .filter((proposal) =>
              ["shared-second-a", "shared-second-b"].includes(proposal.proposalId),
            )
            .every(
              (proposal) =>
                proposal.status === "ready" &&
                proposal.ready?.baseSha === predecessor.delivery?.merge?.mergeCommitSha,
            ),
      );
      await server.close();

      const lookupSpy = vi.spyOn(TaskAuthority.prototype, "lookup");
      const lookupCounts = new Map<string, number>();
      try {
        await reconcileCampaigns(stateDirectory, environment);
        for (const [taskId] of lookupSpy.mock.calls)
          lookupCounts.set(taskId, (lookupCounts.get(taskId) ?? 0) + 1);
        expect(Object.fromEntries(lookupCounts)).toEqual({
          "campaign-campaign-366-v1-shared-first": 1,
          "campaign-campaign-366-v1-shared-second-a": 1,
        });
        lookupSpy.mockClear();
        lookupCounts.clear();
        await reconcileCampaigns(stateDirectory, environment);
        for (const [taskId] of lookupSpy.mock.calls)
          lookupCounts.set(taskId, (lookupCounts.get(taskId) ?? 0) + 1);
        expect(Object.fromEntries(lookupCounts)).toEqual({
          "campaign-campaign-366-v1-shared-first": 1,
          "campaign-campaign-366-v1-shared-second-a": 1,
        });
      } finally {
        lookupSpy.mockRestore();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("allows reviewed-only delivery to release only a cross-Repository successor", async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let successorStarted = false;
    let successorBaseSha: string | undefined;
    const fixtureValue = await frontierFixture(
      {
        ...frontierGoal("campaign-repository"),
        authority: {
          ...frontierGoal("campaign-repository").authority,
          repositories: ["campaign-repository", "other-repository"],
        },
      },
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-cross-first")) {
          firstStarted();
          await firstGate;
          return acceptCampaignTask(context);
        }
        successorStarted = true;
        successorBaseSha = context.contract.baseSha;
        const repositoryPath = context.result.repository?.path;
        if (!repositoryPath) throw new Error("cross-Repository task has no repository snapshot");
        const workspace = new CandidateWorkspace({
          repository: repositoryPath,
          stateDirectory: fixtureValue.stateDirectory,
          deadlineEpochMs: Date.now() + 30_000,
          credentialFreeGit: credentialFreeGitEnvironment(process.env),
          gitAuthor: { name: "Test", email: "test@example.invalid" },
        });
        const writer = await workspace.prepareWriter(
          context.contract.id,
          1,
          context.contract.baseSha,
        );
        expect((await execa("git", ["-C", writer.path, "rev-parse", "HEAD"])).stdout).toBe(
          otherHead,
        );
        await workspace.quarantine(writer);
        return context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "cross-Repository successor fixture complete",
        );
      },
    );
    const { contractPath, stateDirectory, server, environment } = fixtureValue;
    const otherRoot = await mkdtemp(join(tmpdir(), "usine-campaign-other-repository-"));
    await execa("git", ["init", "--initial-branch=main"], { cwd: otherRoot });
    await execa("git", ["config", "user.name", "Test"], { cwd: otherRoot });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: otherRoot });
    await writeFile(join(otherRoot, "other-base.txt"), "other repository base\n");
    await execa("git", ["add", "other-base.txt"], { cwd: otherRoot });
    await execa("git", ["commit", "-m", "initialize other repository"], { cwd: otherRoot });
    const otherHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: otherRoot })).stdout.trim();
    await registerRepositoryResource(stateDirectory, {
      id: "other-repository",
      path: otherRoot,
      owner: "other",
      name: "other-repository",
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "other",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    });
    environment.USINE_FORGE_PROFILE_OTHER_APP_SLUG = "test-app";
    environment.USINE_FORGE_PROFILE_OTHER_TEST_TOKEN = "test-token";
    environment.USINE_FORGE_PROFILE_OTHER_API_URL = "http://127.0.0.1:9";
    environment.USINE_FORGE_PROFILE_OTHER_REPOSITORY = "other/other-repository";
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("cross-first", "outcome-one"),
      );
      const beforeAcceptance = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("cross-second", "outcome-two", ["cross-first"], false, "other-repository"),
      );
      expect(beforeAcceptance.proposals?.[1]).toMatchObject({
        proposalId: "cross-second",
        status: "planned",
      });
      await handoffCampaign(server.url, published.campaignId);
      await firstStartedPromise;
      releaseFirst();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (successorStarted) break;
      }
      expect(successorStarted).toBe(true);
      expect(successorBaseSha).toBe(otherHead);
      await expect(
        taskStatus(server.url, "campaign-campaign-366-v1-cross-first"),
      ).resolves.toMatchObject({
        state: "reviewed_pr",
        delivery: { merge: null },
        repository: { id: "campaign-repository" },
      });
    } finally {
      releaseFirst();
      await server.close();
    }
  });

  test("does not release a same-Repository successor from reviewed-only delivery", async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let successorStarted = false;
    const { contractPath, server } = await frontierFixture(
      undefined,
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-same-reviewed-first")) {
          firstStarted();
          await firstGate;
          return acceptCampaignTask(context);
        }
        successorStarted = true;
        return context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "same-Repository reviewed-only successor must remain planned",
        );
      },
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("same-reviewed-first", "outcome-one"),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("same-reviewed-second", "outcome-two", ["same-reviewed-first"]),
      );
      await handoffCampaign(server.url, published.campaignId);
      await firstStartedPromise;
      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(successorStarted).toBe(false);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        proposals: [
          expect.objectContaining({ proposalId: "same-reviewed-first" }),
          expect.objectContaining({
            proposalId: "same-reviewed-second",
            status: "planned",
            blocker: "same-Repository dependency has no accepted merge",
          }),
        ],
      });
    } finally {
      releaseFirst();
      await server.close();
    }
  });

  test("keeps a dependent planned when its predecessor is quarantined", async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstFinished!: () => void;
    const firstFinishedPromise = new Promise<void>((resolve) => {
      firstFinished = resolve;
    });
    let successorLaunched = false;
    const fixtureValue = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-quarantined-first")) {
          firstStarted();
          await firstGate;
          const accepted = await acceptCampaignTask(context, true);
          await replaceRawTaskResult(
            fixtureValue.stateDirectory,
            context.result.taskId,
            "{ invalid",
          );
          firstFinished();
          return accepted;
        }
        successorLaunched = true;
        return context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "quarantined predecessor successor must remain planned",
        );
      },
    );
    const { contractPath, stateDirectory, server } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("quarantined-first", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("quarantined-second", "outcome-two", ["quarantined-first"], true),
      );
      await handoffCampaign(server.url, published.campaignId);
      await firstStartedPromise;
      releaseFirst();
      await firstFinishedPromise;
      await expect(
        taskStatus(server.url, "campaign-campaign-366-v1-quarantined-first"),
      ).rejects.toMatchObject({ status: 503, diagnostic: "task_state_quarantined" });
      const successor = await getCampaign(server.url, published.campaignId);
      if (!successor) throw new Error("campaign disappeared during quarantine reconciliation");
      expect(successor.proposals).toMatchObject([
        expect.objectContaining({ proposalId: "quarantined-first" }),
        expect.objectContaining({
          proposalId: "quarantined-second",
          status: "planned",
          blocker: "proposal dependency has no accepted delivery",
          ready: null,
        }),
      ]);
      expect(successorLaunched).toBe(false);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          (
            database.prepare("SELECT task_id FROM task_runs ORDER BY task_id").all() as Array<{
              task_id: string;
            }>
          ).map((row) => row.task_id),
        ).toEqual(["campaign-campaign-366-v1-quarantined-first"]);
      } finally {
        database.close();
      }
    } finally {
      releaseFirst();
      await server.close();
    }
  });

  const negativeCampaignEvidenceCases: ReadonlyArray<{
    readonly label: string;
    readonly expectedState: "merged" | "blocked" | "waiting";
    readonly prepare: (
      context: CampaignExecutionContext,
      stateDirectory: string,
    ) => Promise<TaskResult>;
  }> = [
    {
      label: "stale check SHA",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          check: { ...result.check!, sha: "f".repeat(40) },
        }));
        return accepted;
      },
    },
    {
      label: "stale review SHA",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          review: { ...result.review!, sha: "f".repeat(40) },
        }));
        return accepted;
      },
    },
    {
      label: "stale delivery SHA",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          delivery: { ...result.delivery!, sha: "f".repeat(40) },
        }));
        return accepted;
      },
    },
    {
      label: "stale approved-head SHA",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          delivery: {
            ...result.delivery!,
            merge: { ...result.delivery!.merge!, approvedHeadSha: "f".repeat(40) },
          },
        }));
        return accepted;
      },
    },
    {
      label: "ambiguous merge identity",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          delivery: {
            ...result.delivery!,
            merge: { ...result.delivery!.merge!, prNumber: result.delivery!.prNumber + 1 },
          },
        }));
        return accepted;
      },
    },
    {
      label: "incomplete merge effect",
      expectedState: "merged",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          delivery: { ...result.delivery!, merge: null },
        }));
        return accepted;
      },
    },
    {
      label: "blocked or refused delivery",
      expectedState: "blocked",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          state: "blocked",
          delivery: { ...result.delivery!, merge: null },
          blocker: "forge refused the authorized merge",
          blockerClassification: "delivery_failure",
        }));
        return accepted;
      },
    },
    {
      label: "waiting delivery reconciliation",
      expectedState: "waiting",
      prepare: async (context, stateDirectory) => {
        const accepted = await acceptCampaignTask(context, true);
        await rewriteTaskResult(stateDirectory, context.result.taskId, (result) => ({
          ...result,
          state: "waiting",
          delivery: null,
          waiting: {
            reason: "delivery_reconciliation",
            resumeState: "reviewed",
            activation: result.candidateFence!,
          },
          blocker: null,
          blockerClassification: null,
          activeActivation: null,
        }));
        return accepted;
      },
    },
  ];

  test.each(negativeCampaignEvidenceCases)(
    "does not release a successor from $label evidence",
    async ({ prepare, expectedState }) => {
      let firstStarted!: () => void;
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstFinished!: () => void;
      const firstFinishedPromise = new Promise<void>((resolve) => {
        firstFinished = resolve;
      });
      let launches = 0;
      const fixtureValue = await frontierFixture(
        mergeFrontierGoal("campaign-repository"),
        "user:campaign-366",
        async (context) => {
          launches += 1;
          if (context.result.taskId.endsWith("-negative-first")) {
            firstStarted();
            await firstGate;
            const result = await prepare(context, fixtureValue.stateDirectory);
            firstFinished();
            return result;
          }
          return context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "unexpected negative-evidence successor launch",
          );
        },
      );
      const { contractPath, server } = fixtureValue;
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("negative-first", "outcome-one", [], true),
        );
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("negative-second", "outcome-two", ["negative-first"], true),
        );
        await handoffCampaign(server.url, published.campaignId);
        await firstStartedPromise;
        releaseFirst();
        await firstFinishedPromise;
        await expect(
          taskStatus(server.url, "campaign-campaign-366-v1-negative-first"),
        ).resolves.toMatchObject({ state: expectedState });

        const successor = await getCampaign(server.url, published.campaignId);
        if (!successor) throw new Error("campaign disappeared during evidence reconciliation");
        expect(successor.proposals).toMatchObject([
          expect.objectContaining({ proposalId: "negative-first" }),
          expect.objectContaining({
            proposalId: "negative-second",
            status: "planned",
            ready: null,
          }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(launches).toBe(1);
        expect((await serverSnapshot(server.url)).tasks.map((task) => task.taskId)).toEqual([
          "campaign-campaign-366-v1-negative-first",
        ]);
      } finally {
        releaseFirst();
        await server.close();
      }
    },
  );

  test("restarts between predecessor acceptance and admission without duplicating the successor", async () => {
    type ExecutionContext = Parameters<
      NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>
    >[0];
    let predecessorContext!: ExecutionContext;
    let predecessorStarted!: () => void;
    const predecessorStartedPromise = new Promise<void>((resolve) => {
      predecessorStarted = resolve;
    });
    const fixtureValue = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-restart-first")) {
          predecessorContext = context;
          predecessorStarted();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return (await context.authority.lookup(context.result.taskId)) ?? context.result;
        }
        return context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "unexpected pre-restart successor execution",
        );
      },
    );
    const { contractPath, root, stateDirectory, server, environment } = fixtureValue;
    const originalHead = (
      await execa("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const detached = await detachedCampaignCommits(root, originalHead);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("restart-first", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("restart-second", "outcome-two", ["restart-first"], true),
      );
      await handoffCampaign(server.url, published.campaignId);
      await predecessorStartedPromise;
      await server.close();

      const databasePath = join(stateDirectory, "usine.sqlite");
      const handle = openSqliteDatabase(databasePath);
      try {
        const authority = new TaskAuthority(handle.database);
        const predecessor = await authority.lookup("campaign-campaign-366-v1-restart-first");
        if (!predecessor) throw new Error("predecessor was not persisted before restart");
        await acceptCampaignTask(
          { ...predecessorContext, authority, result: predecessor },
          true,
          detached.candidateSha,
          detached.mergeCommitSha,
        );
      } finally {
        handle.close();
      }

      let successorExecutions = 0;
      const restarted = await startUsineServer({
        environment,
        execute: async (context) => {
          successorExecutions += 1;
          return context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "restart successor complete",
          );
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (successorExecutions > 0) break;
        }
        expect(successorExecutions).toBe(1);
        expect((await serverSnapshot(restarted.url)).tasks.map((task) => task.taskId)).toEqual([
          "campaign-campaign-366-v1-restart-first",
          "campaign-campaign-366-v1-restart-second",
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("accepts only the strict flat proposal shape", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await expect(
        proposeCampaign(server.url, published.campaignId, {
          task: frontierProposal("nested-proposal", "outcome-one"),
        }),
      ).rejects.toMatchObject({ status: 400, diagnostic: "validation" });
      await expect(
        proposeCampaign(server.url, published.campaignId, {
          ...frontierProposal("aliased-proposal", "outcome-one"),
          idempotencyKey: "aliased-proposal",
        }),
      ).rejects.toMatchObject({ status: 400, diagnostic: "validation" });
    } finally {
      await server.close();
    }
  });

  test("does not make an unanchored publication executable", async () => {
    const { contractPath, server } = await frontierFixture(
      frontierGoal("campaign-repository"),
      null,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const result = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("unanchored", "outcome-one"),
      );
      expect(result.proposals).toMatchObject([
        {
          status: "blocked",
          blocker: "goal publication is not host-authorized",
          ready: null,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("keeps Campaign GET as a pure durable projection", async () => {
    const { root, stateDirectory, contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const proposed = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("read-only-proposal", "outcome-one"),
      );
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      const before = database
        .prepare("SELECT revision FROM campaigns WHERE campaign_id = ?")
        .get(published.campaignId) as { revision: number };
      const repositoryBefore = database
        .prepare("SELECT revision FROM repositories WHERE id = ?")
        .get("campaign-repository") as { revision: number };
      database.close();

      await writeFile(join(root, "head-advanced-for-read.txt"), "GET must not observe this\n");
      await execa("git", ["add", "head-advanced-for-read.txt"], { cwd: root });
      await execa("git", ["commit", "-m", "advance after readiness"], { cwd: root });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toEqual(proposed);

      const afterDatabase = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      expect(
        afterDatabase
          .prepare("SELECT revision FROM campaigns WHERE campaign_id = ?")
          .get(published.campaignId),
      ).toEqual(before);
      expect(
        afterDatabase
          .prepare("SELECT revision FROM repositories WHERE id = ?")
          .get("campaign-repository"),
      ).toEqual(repositoryBefore);
      afterDatabase.close();
    } finally {
      await server.close();
    }
  });

  test("rejects supplied registration heads and keeps an unavailable repository non-executable", async () => {
    const { root, contractPath, server } = await frontierFixture();
    try {
      const suppliedHead = (
        await execa("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim();
      const rejected = await fetch(`${server.url}/v1/repositories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "campaign-repository",
          path: root,
          owner: "example",
          name: "campaign-repository",
          baseBranch: "main",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
          forgeProfile: "default",
          projectCheck: { command: "true", timeoutMs: 1_000 },
          gitAuthor: { name: "Test", email: "test@example.invalid" },
          headSha: suppliedHead,
        }),
      });
      expect(rejected.status).toBe(200);

      const plainPath = await mkdtemp(join(tmpdir(), "usine-not-a-git-repository-"));
      await registerRepository(server.url, {
        id: "campaign-repository",
        path: plainPath,
        owner: "example",
        name: "campaign-repository",
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Test", email: "test@example.invalid" },
      });
      const published = await publishCampaign(server.url, { contractPath });
      await expect(
        proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("unavailable-repository", "outcome-one"),
        ),
      ).resolves.toMatchObject({
        proposals: [{ status: "blocked", blocker: "registered repository has no exact head" }],
      });
    } finally {
      await server.close();
    }
  });

  test("reconciles blocked never-Ready work at startup without GET mutation", async () => {
    const { root, stateDirectory, contractPath, server } = await frontierFixture();
    const plainPath = await mkdtemp(join(tmpdir(), "usine-startup-not-a-git-repository-"));
    try {
      await registerRepository(server.url, {
        id: "campaign-repository",
        path: plainPath,
        owner: "example",
        name: "campaign-repository",
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Test", email: "test@example.invalid" },
      });
      const published = await publishCampaign(server.url, { contractPath });
      const blocked = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("startup-reconciled", "outcome-one"),
      );
      expect(blocked.proposals).toMatchObject([
        { proposalId: "startup-reconciled", status: "blocked", ready: null },
      ]);

      await registerRepository(server.url, {
        id: "campaign-repository",
        path: root,
        owner: "example",
        name: "campaign-repository",
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Test", email: "test@example.invalid" },
      });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        proposals: [
          {
            proposalId: "startup-reconciled",
            status: "ready",
            ready: { baseSha: expect.stringMatching(/^[0-9a-f]{40}$/) },
          },
        ],
      });
      await server.close();
      const restarted = await start(stateDirectory);
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          proposals: [
            {
              proposalId: "startup-reconciled",
              status: "ready",
              ready: { baseSha: expect.stringMatching(/^[0-9a-f]{40}$/) },
            },
          ],
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("keeps a handed-off Campaign live through bounded turn recovery", async () => {
    let executions = 0;
    const fixtureValue = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        executions += 1;
        if (executions === 1) {
          const repository = context.result.repository;
          if (!repository) throw new Error("Campaign fixture task has no repository snapshot");
          const contract = resolveTaskContract(context.contract, repository);
          const services: DeliveryRunServices = {
            authority: context.authority,
            workspace: {
              quarantinePriorWriters: async () => undefined,
              prepareWriter: async (taskId, activation, baseSha) => ({
                taskId,
                activation,
                path: repository.path,
                baseSha,
              }),
              freeze: async () => {
                throw new Error("fixture interruption must not freeze a Candidate");
              },
              quarantine: async () => undefined,
            },
            session: {
              run: async () => ({
                status: "failed" as const,
                output: null,
                summary: "turn stream closed",
                failure: "turn stream closed",
                phase: "turn" as const,
                failureClass: "transient_transport" as const,
              }),
            },
            quality: {
              check: async () => {
                throw new Error("fixture check must not start");
              },
              reviewWithObservation: async () => {
                throw new Error("fixture review must not start");
              },
            },
            forge: {
              deliver: async () => {
                throw new Error("fixture delivery must not start");
              },
            },
          };
          return executeDeliveryRun(
            {
              contract,
              contractHash: context.result.contractHash,
              repositoryIdentity: context.result.writer.repositoryIdentity,
              deadlineEpochMs: context.result.deadlineEpochMs,
              implementer: context.policy.roles.implementer,
            },
            services,
          );
        }
        return acceptCampaignTask(context);
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    const { contractPath, server, stateDirectory } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("turn-recovery", "outcome-one", [], false, "campaign-repository", 2),
      );
      await handoffCampaign(server.url, published.campaignId);

      let admittedTaskId: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        admittedTaskId ??= current?.proposals?.[0]?.ready?.taskId ?? undefined;
        if (admittedTaskId) {
          const task = await taskStatus(server.url, admittedTaskId);
          if (task?.state === "waiting") break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(admittedTaskId).toBe(`campaign-campaign-366-v1-turn-recovery`);
      await expect(taskStatus(server.url, admittedTaskId!)).resolves.toMatchObject({
        state: "waiting",
        waiting: { reason: "network_interruption" },
        retryable: true,
      });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        campaignId: published.campaignId,
        status: "planning",
        planHandedOff: true,
        outcomes: [{ id: "outcome-one", status: "planned", evidence: null }],
      });

      await expect(retryTask(server.url, admittedTaskId!)).resolves.toMatchObject({
        state: "admitted",
        retryable: false,
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "accepted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(taskStatus(server.url, admittedTaskId!)).resolves.toMatchObject({
        state: "reviewed_pr",
        delivery: { effect: "github" },
      });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        campaignId: published.campaignId,
        status: "accepted",
        planHandedOff: true,
        outcomes: [
          {
            id: "outcome-one",
            status: "accepted",
            evidence: { outcomeId: "outcome-one", taskId: admittedTaskId },
          },
        ],
      });
      expect(executions).toBe(2);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(database.prepare("SELECT count(*) AS count FROM campaigns").get()).toEqual({
          count: 1,
        });
      } finally {
        database.close();
      }
    } finally {
      await server.close();
    }
  });

  test("recovers a handed-off Campaign after a durable reviewer interruption and restart", async () => {
    let executions = 0;
    let interrupted!: () => void;
    const reviewerInterrupted = new Promise<void>((resolve) => {
      interrupted = resolve;
    });
    const campaignGoal = oneOutcomeFrontierGoal("campaign-repository");
    const fixtureValue = await frontierFixture(
      {
        ...campaignGoal,
        budget: { ...campaignGoal.budget, maxReviewCycles: 2 },
      },
      "user:campaign-366",
      async (context) => {
        executions += 1;
        if (executions !== 1) throw new Error("the first server must own the crash fixture");
        const { authority, contract, result } = context;
        const activation = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        const repositoryPath = result.repository?.path;
        if (!repositoryPath) throw new Error("review recovery fixture has no repository snapshot");
        const candidateSha = (
          await execa("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
            cwd: repositoryPath,
          })
        ).stdout.trim();
        const candidate = await authority.recordCandidate(
          { taskId: result.taskId, revision: activation.result.revision },
          { sha: candidateSha, baseSha: contract.baseSha, fence: activation.activation },
        );
        await authority.recordCheck(
          { taskId: result.taskId, revision: candidate.revision },
          {
            sha: candidateSha,
            status: "passed",
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        );
        const reserved = await authority.reserveReviewAttempt(
          result.taskId,
          contract.budget.maxReviewCycles,
          context.executionOwnerId,
        );
        const sessionId = `${result.taskId}-review-interrupted`;
        await authority.appendObservation(result.taskId, {
          eventId: `${sessionId}:started`,
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_started",
            role: "reviewer",
            activation: 0,
            reviewCycle: reserved.cycle!,
            sessionId,
            requestedProfile: "reviewer-profile",
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${sessionId}:interrupted`,
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_interrupted",
            role: "reviewer",
            activation: 0,
            sessionId,
            phase: "turn",
            failureClass: "transient_transport",
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${sessionId}:completed`,
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_completed",
            role: "reviewer",
            activation: 0,
            reviewCycle: reserved.cycle!,
            outcome: "failed",
            sessionId,
            requestedProfile: "reviewer-profile",
          },
        });
        const waiting = await authority.recordReviewInterruption(
          { taskId: result.taskId, revision: reserved.result.revision },
          candidateSha,
          "transient_transport",
          context.executionOwnerId,
        );
        expect(waiting.review).toBeNull();
        interrupted();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return waiting;
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    const { contractPath, environment, server } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const proposal = frontierProposal(
        "review-recovery",
        "outcome-one",
        [],
        false,
        "campaign-repository",
        1,
      );
      await proposeCampaign(server.url, published.campaignId, {
        ...proposal,
        budget: { ...proposal.budget, maxReviewCycles: 2 },
      });
      await handoffCampaign(server.url, published.campaignId);
      await reviewerInterrupted;

      const handedOff = await getCampaign(server.url, published.campaignId);
      const taskId = handedOff?.proposals?.[0]?.ready?.taskId;
      expect(taskId).toBe("campaign-campaign-366-v1-review-recovery");
      await expect(taskStatus(server.url, taskId!)).resolves.toMatchObject({
        state: "checked",
        candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/),
        check: { status: "passed" },
        review: null,
        waiting: null,
        retryable: false,
      });
      expect(handedOff?.proposals).toHaveLength(1);
      await server.close();

      const restarted = await startUsineServer({
        environment,
        assessOutcome: satisfiesDeliveredOutcome,
        execute: async (context) => {
          const repository = context.result.repository;
          if (!repository) throw new Error("review recovery restart has no repository snapshot");
          const contract = resolveTaskContract(context.contract, repository);
          const services: DeliveryRunServices = {
            authority: context.authority,
            workspace: {
              quarantinePriorWriters: async () => undefined,
              prepareWriter: async (workspaceTaskId, activation, baseSha) => ({
                taskId: workspaceTaskId,
                activation,
                path: repository.path,
                baseSha,
              }),
              freeze: async () => {
                throw new Error("replacement reviewer must not freeze a Candidate");
              },
              quarantine: async () => undefined,
            },
            session: {
              run: async () => {
                throw new Error("replacement reviewer must not run an implementer");
              },
            },
            quality: {
              check: async () => {
                throw new Error("replacement reviewer must not rerun the project check");
              },
              reviewWithObservation: async (_contract, candidateSha, check, cycle) => {
                expect(cycle).toBe(2);
                expect(check).toMatchObject({ sha: candidateSha, status: "passed" });
                return {
                  review: {
                    sha: candidateSha,
                    verdict: "approved" as const,
                    summary: "replacement approved",
                    findings: [],
                  },
                  usage: null,
                };
              },
            },
            forge: {
              deliver: async (_contract, candidateSha, check, review) => {
                expect(check.sha).toBe(candidateSha);
                expect(review).toMatchObject({ sha: candidateSha, verdict: "approved" });
                return {
                  sha: candidateSha,
                  effect: "github" as const,
                  prNumber: 400,
                  url: "https://example.invalid/pull/400",
                  attestationId: "campaign-400-replacement",
                };
              },
            },
          };
          return executeDeliveryRun(
            {
              contract,
              contractHash: context.result.contractHash,
              repositoryIdentity: context.result.writer.repositoryIdentity,
              deadlineEpochMs: context.result.deadlineEpochMs,
              implementer: context.policy.roles.implementer,
              reviewer: context.policy.roles.reviewer,
              executionOwnerId: context.executionOwnerId,
            },
            services,
          );
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        let completed = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const task = await taskStatus(restarted.url, taskId!);
          completed = task?.state === "reviewed_pr";
          if (completed) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(completed).toBe(true);
        const events = (await taskEvents(restarted.url, taskId!)).events;
        expect(events.filter((event) => event.data.type === "review_started")).toHaveLength(2);
        expect(events.filter((event) => event.data.type === "review_interrupted")).toHaveLength(1);
        expect(events.filter((event) => event.data.type === "review_completed")).toHaveLength(1);
        const sessionIds = events
          .filter(
            (event) =>
              event.data.type === "coding_session_started" && event.data.role === "reviewer",
          )
          .map((event) =>
            event.data.type === "coding_session_started" ? event.data.sessionId : "",
          );
        expect(new Set(sessionIds).size).toBe(2);
        const completedTask = await taskStatus(restarted.url, taskId!);
        const taskEvidenceResult = await taskEvidence(restarted.url, taskId!);
        expect(taskEvidenceResult?.roleRuns.reviewer).toHaveLength(2);
        expect(taskEvidenceResult?.roleRuns.reviewer.map((run) => run.outcome.status)).toEqual([
          "failed",
          "succeeded",
        ]);
        expect(
          taskEvidenceResult?.roleRuns.reviewer.map((run) => run.outcome.candidateSha),
        ).toEqual([completedTask?.candidateSha, completedTask?.candidateSha]);
        let publicCampaignEvidence = await campaignEvidence(restarted.url, published.campaignId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (publicCampaignEvidence?.runs.filter((run) => run.role === "reviewer").length === 2)
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          publicCampaignEvidence = await campaignEvidence(restarted.url, published.campaignId);
        }
        expect(publicCampaignEvidence?.runs.filter((run) => run.role === "reviewer")).toEqual([
          expect.objectContaining({ outcome: "failed", reviewCycle: 1 }),
          expect.objectContaining({ outcome: "succeeded", reviewCycle: 2 }),
        ]);
        const completedCampaign = await getCampaign(restarted.url, published.campaignId);
        expect(completedCampaign).toMatchObject({
          campaignId: published.campaignId,
          status: "accepted",
          proposals: [
            {
              proposalId: "review-recovery",
              status: "ready",
              ready: { taskId },
            },
          ],
          outcomes: [
            {
              id: "outcome-one",
              status: "accepted",
              evidence: { outcomeId: "outcome-one", taskId },
            },
          ],
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  }, 30_000);

  test("runs the fixed handoff through every Outcome and accepts only accepted Task delivery", async () => {
    let executions = 0;
    const fixtureValue = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        executions += 1;
        return acceptCampaignTask(context, true);
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    const { contractPath, server, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("handoff-first", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("handoff-second", "outcome-two", ["handoff-first"], true),
      );
      expect(executions).toBe(0);

      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "accepted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "accepted",
        planHandedOff: true,
        outcomes: [
          { id: "outcome-one", status: "accepted", evidence: { outcomeId: "outcome-one" } },
          { id: "outcome-two", status: "accepted", evidence: { outcomeId: "outcome-two" } },
        ],
      });
      expect(executions).toBe(2);
      await handoffCampaign(server.url, published.campaignId);
      await expect(
        fetch(`${server.url}/v1/campaigns/${published.campaignId}/proposals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frontierProposal("after-accepted", "outcome-one", [], true)),
        }),
      ).resolves.toMatchObject({ status: 409 });
      environment.USINE_CAMPAIGN_ABANDONMENT_SOURCE = "user:campaign-366";
      await expect(
        fetch(`${server.url}/v1/campaigns/${published.campaignId}/abandon`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "accepted",
      });
    } finally {
      await server.close();
    }
  });

  test("accepts complete assessment evidence after the former cutoff within the Goal deadline", async () => {
    const maxElapsedMs = 120_000;
    const base = oneOutcomeFrontierGoal("campaign-repository");
    const contract = {
      ...base,
      id: "campaign-459-late-assessment",
      budget: { ...base.budget, maxElapsedMs },
    };
    let campaignCreatedAt = 0;
    let assessorDeadline = 0;
    let assessorCompletedAt = 0;
    let controlledNow = Date.now();
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessorDeadline = request.deadlineEpochMs;
      controlledNow = campaignCreatedAt + 60_001;
      assessorCompletedAt = Date.now();
      if (assessorCompletedAt >= request.deadlineEpochMs)
        throw new Error("controlled assessor deadline elapsed");
      return satisfiesDeliveredOutcome(request);
    };
    const fixtureValue = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
    );
    const { contractPath, server, stateDirectory } = fixtureValue;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => controlledNow);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        campaignCreatedAt = (
          database
            .prepare("SELECT created_at FROM campaigns WHERE campaign_id = ?")
            .get(published.campaignId) as { created_at: number }
        ).created_at;
        controlledNow = campaignCreatedAt;
      } finally {
        database.close();
      }
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("late-assessment", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      const campaign = await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (current) => current?.status === "accepted" || current?.status === "blocked",
      );
      expect(campaign).toMatchObject({ status: "accepted" });
      expect(assessorCompletedAt).toBe(campaignCreatedAt + 60_001);
      expect(assessorCompletedAt).toBeGreaterThan(campaignCreatedAt + 60_000);
      expect(assessorDeadline).toBe(campaignCreatedAt + maxElapsedMs);
    } finally {
      clock.mockRestore();
      await server.close();
    }
  });

  test("does not accept otherwise valid assessment evidence after the Goal deadline", async () => {
    const maxElapsedMs = 60_000;
    const base = oneOutcomeFrontierGoal("campaign-repository");
    const contract = {
      ...base,
      id: "campaign-459-late-assessment-rejected",
      budget: { ...base.budget, maxElapsedMs },
    };
    let campaignCreatedAt = 0;
    let assessorDeadline = 0;
    let assessorCompletedAt = 0;
    let controlledNow = Date.now();
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessorDeadline = request.deadlineEpochMs;
      controlledNow = campaignCreatedAt + maxElapsedMs + 1;
      assessorCompletedAt = Date.now();
      return {
        ...(await satisfiesDeliveredOutcome(request)),
        usage: lateAssessorUsage,
      };
    };
    const fixtureValue = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
    );
    const { contractPath, server, stateDirectory } = fixtureValue;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => controlledNow);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        campaignCreatedAt = (
          database
            .prepare("SELECT created_at FROM campaigns WHERE campaign_id = ?")
            .get(published.campaignId) as { created_at: number }
        ).created_at;
        controlledNow = campaignCreatedAt;
      } finally {
        database.close();
      }
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("late-assessment-rejected", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      const campaign = await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (current) => current?.status === "accepted" || current?.status === "blocked",
      );
      expect(campaign).toMatchObject({
        status: "blocked",
        outcomes: [
          {
            id: "outcome-one",
            assessment: {
              verdict: "inconclusive",
              summary: "Campaign assessor completed after the Goal deadline",
              usage: lateAssessorUsage,
            },
          },
        ],
      });
      expect(assessorCompletedAt).toBe(campaignCreatedAt + maxElapsedMs + 1);
      expect(assessorDeadline).toBe(campaignCreatedAt + maxElapsedMs);
    } finally {
      clock.mockRestore();
      await server.close();
    }
  });

  test.each(["satisfied", "gaps", "inconclusive"] as const)(
    "persists the owning Campaign assessor %s verdict and does not use Task completion as acceptance",
    async (verdict) => {
      let calls = 0;
      let assessmentRequest: Parameters<CampaignOutcomeAssessor>[0] | undefined;
      const assessor: CampaignOutcomeAssessor = async (request) => {
        calls += 1;
        assessmentRequest = request;
        const delivery = request.evidence.find((item) => item.fact === "delivery");
        return {
          verdict,
          summary: `fixture ${verdict}`,
          gaps: verdict === "gaps" ? ["the direction is incomplete"] : [],
          evidence: verdict === "satisfied" && delivery ? [{ ...delivery, criterionIndex: 0 }] : [],
          usage: {
            inputTokens: 11,
            cachedInputTokens: 2,
            uncachedInputTokens: 9,
            cacheWriteInputTokens: 0,
            outputTokens: 7,
            reasoningOutputTokens: 3,
          },
        };
      };
      const { contractPath, server, stateDirectory, environment } = await frontierFixture(
        oneOutcomeFrontierGoal("campaign-repository"),
        "user:campaign-366",
        async (context) => acceptCampaignTask(context),
        1,
        true,
        assessor,
      );
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("assessed", "outcome-one"),
        );
        await handoffCampaign(server.url, published.campaignId);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const current = await getCampaign(server.url, published.campaignId);
          if (current?.status === "accepted" || current?.status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const campaign = await getCampaign(server.url, published.campaignId);
        expect(calls).toBe(1);
        expect(assessmentRequest).toMatchObject({
          goal: { id: "campaign-366", version: 1 },
          outcome: { id: "outcome-one" },
        });
        expect(assessmentRequest).not.toHaveProperty("contract");
        expect(campaign?.outcomes[0]?.assessment).toMatchObject({
          verdict,
          usage: { inputTokens: 11, outputTokens: 7 },
        });
        expect(campaign?.status).toBe(verdict === "satisfied" ? "accepted" : "blocked");
        if (verdict !== "satisfied")
          expect(campaign?.decisionRequest?.reason).toBe(
            verdict === "gaps" ? "replacement_unavailable" : "assessment_inconclusive",
          );

        const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          const count = database
            .prepare("SELECT COUNT(*) AS count FROM campaign_assessments")
            .get() as { count: number };
          expect(count.count).toBe(1);
        } finally {
          database.close();
        }
        if (verdict === "satisfied") {
          await server.close();
          const restarted = await startUsineServer({
            environment,
            assessOutcome: async () => {
              calls += 1;
              throw new Error("an accepted assessment must not repeat");
            },
            host: "127.0.0.1",
            port: 0,
          });
          await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
            status: "accepted",
          });
          await restarted.close();
          expect(calls).toBe(1);
        }
      } finally {
        await server.close();
      }
    },
  );

  test("assesses every live Outcome before terminalizing one current assessment failure", async () => {
    const fixtureValue = await frontierFixture(
      undefined,
      "user:campaign-366",
      undefined,
      1,
      true,
      async () => ({
        verdict: "gaps",
        summary: "the fixed frontier remains incomplete",
        gaps: ["the fixed frontier remains incomplete"],
        evidence: [],
        usage: null,
      }),
    );
    const { contractPath, server, stateDirectory, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await handoffCampaign(server.url, published.campaignId);
      await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (campaign) =>
          (campaign?.outcomes.every((outcome) => outcome.assessment?.verdict === "gaps") ??
            false) &&
          campaign?.decisionRequest?.reason === "replacement_unavailable",
      );
      await server.close();
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        database
          .prepare("DELETE FROM campaign_assessments WHERE campaign_id = ? AND outcome_id = ?")
          .run(published.campaignId, "outcome-two");
        database
          .prepare("UPDATE campaigns SET status = ?, decision_request = NULL WHERE campaign_id = ?")
          .run("planning", published.campaignId);
      } finally {
        database.close();
      }

      const assessed: string[] = [];
      await reconcileCampaigns(stateDirectory, environment, 1, async (request) => {
        assessed.push(request.outcome.id);
        return {
          verdict: "inconclusive",
          summary: "the remaining Outcome has no accepted delivery",
          gaps: [],
          evidence: [],
          usage: null,
        };
      });

      await expect(lookupCampaign(stateDirectory, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: {
          reason: "replacement_unavailable",
          outcomeIds: ["outcome-one", "outcome-two"],
        },
      });
      expect(assessed).toEqual(["outcome-two"]);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test.each([
    { name: "accepts the same exact delivery fact for criterion 1", kind: "accepted" },
    { name: "rejects a forged unavailable fact for criterion 1", kind: "forged" },
    { name: "downgrades evidence missing a criterion", kind: "missing" },
    { name: "downgrades evidence that cites a non-delivery fact", kind: "non-delivery" },
  ] as const)("$name in multi-criterion assessment evidence", async ({ kind }) => {
    const base = oneOutcomeFrontierGoal("campaign-repository");
    const contract = {
      ...base,
      outcomes: [
        {
          ...base.outcomes[0]!,
          acceptance: ["the first criterion is satisfied", "the second criterion is satisfied"],
        },
      ],
    };
    let calls = 0;
    let requestEvidence: readonly CampaignAssessmentFact[] = [];
    const assessor: CampaignOutcomeAssessor = async (request) => {
      calls += 1;
      requestEvidence = request.evidence;
      const delivery = request.evidence.find((item) => item.fact === "delivery");
      if (!delivery) throw new Error("fixture requires accepted delivery evidence");
      const source =
        kind === "non-delivery"
          ? request.evidence.find((item) => item.fact === "candidate")!
          : delivery;
      const second =
        kind === "forged"
          ? { ...delivery, criterionIndex: 1, sha: "0".repeat(40) }
          : kind === "missing"
            ? null
            : { ...source, criterionIndex: 1 };
      return {
        verdict: "satisfied",
        summary: "both criteria reference the supplied delivery",
        gaps: [],
        evidence: [{ ...source, criterionIndex: 0 }, ...(second ? [second] : [])],
        usage: null,
      };
    };
    const { contractPath, server } = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("multi-criterion", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "accepted" || current?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const campaign = await getCampaign(server.url, published.campaignId);
      expect(requestEvidence.every((item) => !Object.hasOwn(item, "criterionIndex"))).toBe(true);
      expect(calls).toBe(1);
      if (kind !== "accepted") {
        const expectedEvidence =
          kind === "non-delivery"
            ? [{ criterionIndex: 0 }, { criterionIndex: 1 }]
            : [{ criterionIndex: 0 }];
        expect(campaign).toMatchObject({
          status: "blocked",
          outcomes: [{ assessment: { verdict: "gaps", evidence: expectedEvidence } }],
        });
        expect(campaign?.outcomes[0]?.assessment?.evidence).toHaveLength(expectedEvidence.length);
      } else {
        expect(campaign).toMatchObject({
          status: "accepted",
          outcomes: [
            {
              status: "accepted",
              assessment: {
                verdict: "satisfied",
                evidence: [{ criterionIndex: 0 }, { criterionIndex: 1 }],
              },
            },
          ],
        });
      }
    } finally {
      await server.close();
    }
  });

  test("persists and deduplicates an explicit checkpoint across restart", async () => {
    let calls = 0;
    const assessor: CampaignOutcomeAssessor = async () => {
      calls += 1;
      return {
        verdict: "inconclusive",
        summary: "the checkpoint has no accepted delivery yet",
        gaps: [],
        evidence: [],
        usage: null,
      };
    };
    const fixtureValue = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => context.result,
      1,
      true,
      assessor,
    );
    const { contractPath, server, stateDirectory, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("checkpointed", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      let beforeCheckpoint = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (beforeCheckpoint?.proposals?.[0]?.ready?.taskId) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        beforeCheckpoint = await getCampaign(server.url, published.campaignId);
      }
      expect(beforeCheckpoint?.status).toBe("planning");
      expect(calls).toBe(0);

      await checkpointCampaign(server.url, published.campaignId);
      const checkpointed = await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (campaign) => campaign?.outcomes[0]?.assessment?.verdict === "inconclusive",
      );
      if (!checkpointed) throw new Error("Campaign disappeared before assessment persisted");
      expect(checkpointed.outcomes[0]?.assessment).toMatchObject({ verdict: "inconclusive" });
      expect(calls).toBe(1);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM campaign_assessments").get(),
        ).toEqual({
          count: 1,
        });
      } finally {
        database.close();
      }
      await server.close();

      const restarted = await startUsineServer({
        environment,
        execute: async (context) => context.result,
        assessOutcome: assessor,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          outcomes: [{ assessment: { verdict: "inconclusive" } }],
        });
        expect(calls).toBe(1);
        const repeated = await checkpointCampaign(restarted.url, published.campaignId);
        expect(repeated.outcomes[0]?.assessment).toMatchObject({ verdict: "inconclusive" });
        expect(calls).toBe(1);
        const restartedDatabase = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          expect(
            restartedDatabase.prepare("SELECT COUNT(*) AS count FROM campaign_assessments").get(),
          ).toEqual({ count: 1 });
        } finally {
          restartedDatabase.close();
        }
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("revises exactly one unowned Planned proposal from an explicit checkpoint", async () => {
    const initial = frontierProposal("wrong-direction", "outcome-one", ["not-admitted"]);
    const independent = frontierProposal("independent", "outcome-two");
    const replacement = frontierProposal("corrected-direction", "outcome-one");
    const checkpointGoal = {
      ...frontierGoal("campaign-repository"),
      outcomes: frontierGoal("campaign-repository").outcomes.map((outcome) =>
        outcome.id === "outcome-two" ? { ...outcome, dependsOn: [] } : outcome,
      ),
    };
    let assessmentCalls = 0;
    let replacementCalls = 0;
    let releaseIndependent!: () => void;
    const independentRelease = new Promise<void>((resolve) => {
      releaseIndependent = resolve;
    });
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessmentCalls += 1;
      const delivery = request.evidence.find((item) => item.fact === "delivery");
      return delivery
        ? {
            verdict: "satisfied" as const,
            summary: "the delivered proposal satisfies the Outcome",
            gaps: [],
            evidence: request.outcome.acceptance.map((_, criterionIndex) => ({
              ...delivery,
              criterionIndex,
            })),
            usage: null,
          }
        : {
            verdict: "gaps" as const,
            summary: "the Planned proposal points in the wrong direction",
            gaps: ["the direction needs one focused correction"],
            evidence: [],
            usage: null,
          };
    };
    const replacementGenerator: CampaignReplacementGenerator = async (request) => {
      replacementCalls += 1;
      expect(request.supersedableProposalIds).toEqual([initial.proposalId]);
      return {
        proposal: { ...replacement, supersedesProposalId: initial.proposalId },
        usage: null,
      };
    };
    const { contractPath, server, stateDirectory, environment } = await frontierFixture(
      checkpointGoal,
      "user:campaign-366",
      async (context) => {
        if (context.contract.campaign?.outcomeId === "outcome-two") await independentRelease;
        return acceptCampaignTask(context);
      },
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, initial);
      await proposeCampaign(server.url, published.campaignId, independent);
      await handoffCampaign(server.url, published.campaignId);
      await checkpointCampaign(server.url, published.campaignId);
      const checkpointed = await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (campaign) =>
          campaign?.proposals?.some(({ proposalId }) => proposalId === replacement.proposalId) ??
          false,
      );
      if (!checkpointed) throw new Error("Campaign disappeared before replacement persisted");

      expect(replacementCalls).toBe(1);
      expect(checkpointed.proposals).toMatchObject([
        {
          proposalId: initial.proposalId,
          status: "superseded",
          supersededByProposalId: replacement.proposalId,
        },
        { proposalId: independent.proposalId },
        {
          proposalId: replacement.proposalId,
          supersedesProposalId: initial.proposalId,
          replacement: {
            assessmentId: expect.stringMatching(/^assessment-/),
            evidenceHash: expect.any(String),
          },
        },
      ]);
      expect(checkpointed.proposals?.map((proposal) => proposal.proposalId)).toEqual([
        initial.proposalId,
        independent.proposalId,
        replacement.proposalId,
      ]);
      const repeated = await checkpointCampaign(server.url, published.campaignId);
      expect(repeated.proposals?.map((proposal) => proposal.proposalId)).toEqual([
        initial.proposalId,
        independent.proposalId,
        replacement.proposalId,
      ]);
      expect(repeated.proposals).toMatchObject([
        {
          proposalId: initial.proposalId,
          status: "superseded",
          supersededByProposalId: replacement.proposalId,
        },
        { proposalId: independent.proposalId },
        {
          proposalId: replacement.proposalId,
          supersedesProposalId: initial.proposalId,
          replacement: {
            assessmentId: expect.stringMatching(/^assessment-/),
            evidenceHash: expect.any(String),
          },
        },
      ]);
      expect(replacementCalls).toBe(1);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, superseded_by_proposal_id FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, initial.proposalId),
        ).toEqual({
          status: "superseded",
          superseded_by_proposal_id: replacement.proposalId,
        });
        expect(
          database
            .prepare(
              "SELECT supersedes_proposal_id, replacement_assessment_id, replacement_evidence_hash FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, replacement.proposalId),
        ).toMatchObject({
          supersedes_proposal_id: initial.proposalId,
          replacement_assessment_id: expect.any(String),
          replacement_evidence_hash: expect.any(String),
        });
      } finally {
        database.close();
      }
      expect(assessmentCalls).toBeGreaterThanOrEqual(1);

      releaseIndependent();
      let settled = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (settled?.status === "accepted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled = await getCampaign(server.url, published.campaignId);
      }
      expect(settled).toMatchObject({ status: "accepted" });
      const assessmentCallsAfterSettle = assessmentCalls;
      const replacementCallsAfterSettle = replacementCalls;
      await server.close();
      const restarted = await startUsineServer({
        environment,
        execute: async (context) => {
          throw new Error(`unexpected post-restart Campaign execution: ${context.result.taskId}`);
        },
        assessOutcome: assessor,
        generateReplacement: replacementGenerator,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        if (!settled) throw new Error("Campaign disappeared before restart");
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
          settled,
        );
        const restartedCampaign = await getCampaign(restarted.url, published.campaignId);
        expect(restartedCampaign?.proposals?.map((proposal) => proposal.proposalId)).toEqual([
          initial.proposalId,
          independent.proposalId,
          replacement.proposalId,
        ]);
        expect(assessmentCalls).toBe(assessmentCallsAfterSettle);
        expect(replacementCalls).toBe(replacementCallsAfterSettle);
        const restartedDatabase = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          expect(
            restartedDatabase
              .prepare(
                "SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ? AND superseded_by_proposal_id IS NOT NULL",
              )
              .get(published.campaignId),
          ).toEqual({ count: 1 });
          expect(
            restartedDatabase
              .prepare(
                "SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ? AND supersedes_proposal_id IS NOT NULL",
              )
              .get(published.campaignId),
          ).toEqual({ count: 1 });
        } finally {
          restartedDatabase.close();
        }
      } finally {
        await restarted.close();
      }
    } finally {
      releaseIndependent();
      await server.close().catch(() => undefined);
    }
  });

  test("rejects a checkpoint replacement that selects an unauthorized source ID", async () => {
    const initial = frontierProposal("checkpoint-source", "outcome-one", ["not-admitted"]);
    const independent = frontierProposal("checkpoint-independent", "outcome-two");
    let replacementCalls = 0;
    let replacementEntered!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    let releaseIndependent!: () => void;
    const independentGate = new Promise<void>((resolve) => {
      releaseIndependent = resolve;
    });
    const replacementGenerator: CampaignReplacementGenerator = async () => {
      replacementCalls += 1;
      replacementEntered();
      return {
        proposal: {
          ...frontierProposal("unauthorized-replacement", "outcome-one"),
          supersedesProposalId: "missing-checkpoint-source",
        },
        usage: null,
      };
    };
    const checkpointGoal = {
      ...frontierGoal("campaign-repository"),
      outcomes: frontierGoal("campaign-repository").outcomes.map((outcome) =>
        outcome.id === "outcome-two" ? { ...outcome, dependsOn: [] } : outcome,
      ),
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      checkpointGoal,
      "user:campaign-366",
      async (context) => {
        if (context.contract.campaign?.outcomeId === "outcome-two") await independentGate;
        return acceptCampaignTask(context);
      },
      1,
      true,
      checkpointDirectionGapAssessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, initial);
      await proposeCampaign(server.url, published.campaignId, independent);
      await handoffCampaign(server.url, published.campaignId);
      let handedOff = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (handedOff?.planHandedOff && handedOff.status !== "accepted") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        handedOff = await getCampaign(server.url, published.campaignId);
      }
      const checkpointed = await checkpointCampaign(server.url, published.campaignId);
      expect(checkpointed.planHandedOff).toBe(true);
      await replacementStarted;
      releaseIndependent();

      let rejected = checkpointed;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (rejected.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        rejected = (await getCampaign(server.url, published.campaignId)) ?? rejected;
      }
      expect(rejected).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "replacement_invalid",
          outcomeIds: ["outcome-one"],
        },
        proposals: [
          { proposalId: initial.proposalId, status: "planned" },
          { proposalId: independent.proposalId },
        ],
      });
      expect(replacementCalls).toBe(1);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, superseded_by_proposal_id, supersedes_proposal_id, replacement_assessment_id, replacement_evidence_hash FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, initial.proposalId),
        ).toEqual({
          status: "planned",
          superseded_by_proposal_id: null,
          supersedes_proposal_id: null,
          replacement_assessment_id: null,
          replacement_evidence_hash: null,
        });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ count: 2 });
        expect(
          database
            .prepare(
              "SELECT status, proposal FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
            )
            .get(published.campaignId, "outcome-one"),
        ).toMatchObject({ status: "invalid", proposal: null });
      } finally {
        database.close();
      }
    } finally {
      releaseIndependent();
      await server.close();
    }
  });

  test("does not expose a Planned source with a live dependent at a checkpoint", async () => {
    const first = frontierProposal("chain-first", "outcome-one");
    const independent = frontierProposal("chain-independent", "outcome-two");
    const second = frontierProposal("chain-second", "outcome-one", [first.proposalId]);
    const third = frontierProposal("chain-third", "outcome-one", [second.proposalId]);
    const checkpointGoal = {
      ...frontierGoal("campaign-repository"),
      outcomes: frontierGoal("campaign-repository").outcomes.map((outcome) =>
        outcome.id === "outcome-two" ? { ...outcome, dependsOn: [] } : outcome,
      ),
      budget: {
        ...frontierGoal("campaign-repository").budget,
        maxTasks: 10,
        maxImplementerActivations: 2,
        maxReviewCycles: 2,
      },
    };
    let replacementCalls = 0;
    let exposedSupersedableProposalIds: readonly string[] | undefined;
    let replacementEntered!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    let releaseIndependent!: () => void;
    const independentGate = new Promise<void>((resolve) => {
      releaseIndependent = resolve;
    });
    const replacementGenerator: CampaignReplacementGenerator = async (request) => {
      replacementCalls += 1;
      exposedSupersedableProposalIds = request.supersedableProposalIds;
      replacementEntered();
      return {
        proposal: {
          ...frontierProposal("chain-invalid-replacement", "outcome-one"),
          supersedesProposalId: second.proposalId,
        },
        usage: null,
      };
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      checkpointGoal,
      "user:campaign-366",
      async (context) => {
        if (context.contract.campaign?.outcomeId === "outcome-two") await independentGate;
        return acceptCampaignTask(context);
      },
      1,
      true,
      checkpointDirectionGapAssessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, first);
      await proposeCampaign(server.url, published.campaignId, independent);
      await proposeCampaign(server.url, published.campaignId, second);
      await proposeCampaign(server.url, published.campaignId, third);
      await handoffCampaign(server.url, published.campaignId);

      let frontier = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const proposals = frontier?.proposals ?? [];
        const firstResource = proposals.find(
          (proposal) => proposal.proposalId === first.proposalId,
        );
        const independentResource = proposals.find(
          (proposal) => proposal.proposalId === independent.proposalId,
        );
        const secondResource = proposals.find(
          (proposal) => proposal.proposalId === second.proposalId,
        );
        const thirdResource = proposals.find(
          (proposal) => proposal.proposalId === third.proposalId,
        );
        if (
          firstResource?.ready?.taskId &&
          independentResource?.ready?.taskId &&
          secondResource?.status === "planned" &&
          thirdResource?.status === "planned"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        frontier = await getCampaign(server.url, published.campaignId);
      }
      expect(frontier?.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ proposalId: first.proposalId, ready: expect.any(Object) }),
          expect.objectContaining({
            proposalId: independent.proposalId,
            ready: expect.any(Object),
          }),
          expect.objectContaining({ proposalId: second.proposalId, status: "planned" }),
          expect.objectContaining({ proposalId: third.proposalId, status: "planned" }),
        ]),
      );
      const checkpointed = await checkpointCampaign(server.url, published.campaignId);
      expect(checkpointed.planHandedOff).toBe(true);
      await replacementStarted;
      releaseIndependent();

      let rejected = checkpointed;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (rejected.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        rejected = (await getCampaign(server.url, published.campaignId)) ?? rejected;
      }
      expect(rejected).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "replacement_invalid",
        },
      });
      expect(replacementCalls).toBe(1);
      expect(exposedSupersedableProposalIds).toEqual([third.proposalId]);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, superseded_by_proposal_id, supersedes_proposal_id FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, second.proposalId),
        ).toEqual({
          status: "planned",
          superseded_by_proposal_id: null,
          supersedes_proposal_id: null,
        });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ count: 4 });
        expect(
          database
            .prepare(
              "SELECT status, proposal FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
            )
            .get(published.campaignId, "outcome-one"),
        ).toMatchObject({ status: "invalid", proposal: null });
      } finally {
        database.close();
      }
    } finally {
      releaseIndependent();
      await server.close();
    }
  });

  test("preserves a checkpoint through a multi-Outcome assessment pass", async () => {
    const delivered = frontierProposal("checkpoint-delivered", "outcome-two");
    const source = frontierProposal("checkpoint-gap", "outcome-one", ["not-admitted"]);
    const active = frontierProposal("checkpoint-active", "outcome-two");
    const replacement = frontierProposal("checkpoint-correction", "outcome-one");
    const checkpointGoal = {
      ...frontierGoal("campaign-repository"),
      outcomes: frontierGoal("campaign-repository").outcomes.map((outcome) =>
        outcome.id === "outcome-two" ? { ...outcome, dependsOn: [] } : outcome,
      ),
      budget: {
        ...frontierGoal("campaign-repository").budget,
        maxTasks: 10,
        maxImplementerActivations: 2,
        maxReviewCycles: 2,
      },
    };
    let replacementCalls = 0;
    const assessmentOrder: string[] = [];
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let replacementEntered!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    const replacementGenerator: CampaignReplacementGenerator = async (request) => {
      replacementCalls += 1;
      replacementEntered();
      expect(request.supersedableProposalIds).toEqual([source.proposalId]);
      return {
        proposal: { ...replacement, supersedesProposalId: source.proposalId },
        usage: null,
      };
    };
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessmentOrder.push(request.outcome.id);
      return checkpointDirectionGapAssessor(request);
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      checkpointGoal,
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith(`-${active.proposalId}`)) await activeGate;
        return acceptCampaignTask(context);
      },
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, delivered);
      await proposeCampaign(server.url, published.campaignId, source);
      await proposeCampaign(server.url, published.campaignId, active);
      await handoffCampaign(server.url, published.campaignId);

      let frontier = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const proposals = frontier?.proposals ?? [];
        const deliveredResource = proposals.find(
          (proposal) => proposal.proposalId === delivered.proposalId,
        );
        const sourceResource = proposals.find(
          (proposal) => proposal.proposalId === source.proposalId,
        );
        const activeResource = proposals.find(
          (proposal) => proposal.proposalId === active.proposalId,
        );
        if (
          deliveredResource?.ready?.taskId &&
          sourceResource?.status === "planned" &&
          activeResource?.ready?.taskId
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        frontier = await getCampaign(server.url, published.campaignId);
      }
      expect(frontier?.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ proposalId: delivered.proposalId, ready: expect.any(Object) }),
          expect.objectContaining({ proposalId: source.proposalId, status: "planned" }),
          expect.objectContaining({ proposalId: active.proposalId, ready: expect.any(Object) }),
        ]),
      );

      const checkpointed = await checkpointCampaign(server.url, published.campaignId);
      let revised = checkpointed;
      await replacementStarted;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (
          revised.proposals?.some(
            (proposal) =>
              proposal.proposalId === source.proposalId &&
              proposal.status === "superseded" &&
              proposal.supersededByProposalId === replacement.proposalId,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        revised = (await getCampaign(server.url, published.campaignId)) ?? revised;
      }
      releaseActive();
      expect(replacementCalls).toBe(1);
      expect(assessmentOrder.slice(0, 2)).toEqual(["outcome-one", "outcome-two"]);
      expect(revised.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            proposalId: source.proposalId,
            status: "superseded",
            supersededByProposalId: replacement.proposalId,
          }),
          expect.objectContaining({
            proposalId: replacement.proposalId,
            supersedesProposalId: source.proposalId,
            replacement: expect.objectContaining({
              assessmentId: expect.stringMatching(/^assessment-/),
              evidenceHash: expect.any(String),
            }),
          }),
        ]),
      );
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, superseded_by_proposal_id FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, source.proposalId),
        ).toEqual({
          status: "superseded",
          superseded_by_proposal_id: replacement.proposalId,
        });
      } finally {
        database.close();
      }
    } finally {
      releaseActive();
      await server.close();
    }
  });

  test("does not revise a proposal with historical Ready evidence at a checkpoint", async () => {
    let replacementCalls = 0;
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const replacementGenerator: CampaignReplacementGenerator = async () => {
      replacementCalls += 1;
      return { proposal: frontierProposal("must-not-run", "outcome-one"), usage: null };
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("-historical-active")) {
          await activeGate;
          return context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "historical Ready fixture complete",
          );
        }
        return context.result;
      },
      1,
      true,
      checkpointOwnedGapAssessor,
      replacementGenerator,
    );
    const initial = frontierProposal("historically-ready", "outcome-one", ["never-admitted"]);
    const active = frontierProposal("historical-active", "outcome-one");
    const readyBaseSha = "a".repeat(40);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, initial);
      await proposeCampaign(server.url, published.campaignId, active);
      const beforeHandoff = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        beforeHandoff
          .prepare(
            "UPDATE campaign_proposals SET ready_base_sha = ?, ready_repository_revision = ? WHERE campaign_id = ? AND proposal_id = ?",
          )
          .run(readyBaseSha, 7, published.campaignId, initial.proposalId);
      } finally {
        beforeHandoff.close();
      }
      await handoffCampaign(server.url, published.campaignId);

      const checkpointed = await checkpointCampaign(server.url, published.campaignId);
      expect(replacementCalls).toBe(0);
      releaseActive();
      let exhausted = checkpointed;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (exhausted.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await getCampaign(server.url, published.campaignId);
        if (current) exhausted = current;
      }
      expect(exhausted).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "replacement_exhausted",
          outcomeIds: ["outcome-one"],
        },
      });
      expect(exhausted.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            proposalId: initial.proposalId,
            ready: expect.objectContaining({ baseSha: readyBaseSha, repositoryRevision: 7 }),
          }),
          expect.objectContaining({ proposalId: active.proposalId }),
        ]),
      );
      const unchanged = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          unchanged
            .prepare(
              "SELECT status, ready_base_sha, ready_repository_revision, superseded_by_proposal_id FROM campaign_proposals WHERE campaign_id = ? AND proposal_id = ?",
            )
            .get(published.campaignId, initial.proposalId),
        ).toEqual({
          status: "planned",
          ready_base_sha: readyBaseSha,
          ready_repository_revision: 7,
          superseded_by_proposal_id: null,
        });
      } finally {
        unchanged.close();
      }
    } finally {
      releaseActive();
      await server.close();
    }
  });

  test("exhausted fixed plans persist one stable decision request without closing", async () => {
    const fixtureValue = await frontierFixture(
      undefined,
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    const { contractPath, server, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("incomplete-plan", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      let firstRequest: unknown;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "blocked") {
          firstRequest = current.decisionRequest;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(firstRequest).toMatchObject({
        requestId: `decision:${published.campaignId}`,
        reason: "assessment_inconclusive",
        outcomeIds: ["outcome-two"],
      });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: firstRequest,
      });
      await handoffCampaign(server.url, published.campaignId);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: firstRequest,
      });
      await expect(
        fetch(`${server.url}/v1/campaigns/${published.campaignId}/proposals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frontierProposal("after-handoff", "outcome-two")),
        }),
      ).resolves.toMatchObject({ status: 409 });
      await server.close();
      const restarted = await startUsineServer({
        environment,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          status: "blocked",
          decisionRequest: firstRequest,
        });
        await handoffCampaign(restarted.url, published.campaignId);
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          status: "blocked",
          decisionRequest: firstRequest,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close();
    }
  });

  test("empty handed-off frontiers request a decision without closing", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await handoffCampaign(server.url, published.campaignId);
      await expect(
        waitFor(
          () => getCampaign(server.url, published.campaignId),
          (campaign) => campaign?.status === "blocked",
        ),
      ).resolves.toMatchObject({
        status: "blocked",
        planHandedOff: true,
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "assessment_inconclusive",
          outcomeIds: ["outcome-one", "outcome-two"],
        },
      });
    } finally {
      await server.close();
    }
  });

  test.each([2, null])(
    "admits one replacement under count limit %s and reassesses it",
    async (limit) => {
      const base = oneOutcomeFrontierGoal("campaign-repository");
      const contract = {
        ...base,
        budget: { ...base.budget, maxImplementerActivations: limit, maxReviewCycles: limit },
      };
      const replacement = frontierProposal("replacement", "outcome-one");
      const replacementWithBudget = {
        ...replacement,
        budget: {
          ...replacement.budget,
          maxImplementerActivations: limit === null ? null : 1,
          maxReviewCycles: limit === null ? null : 1,
        },
      };
      let calls = 0;
      let replacementCalls = 0;
      const assessor: CampaignOutcomeAssessor = async (request) => {
        calls += 1;
        if (calls === 1)
          return {
            verdict: "gaps",
            summary: "the first bounded task did not close the Outcome",
            gaps: ["the missing behavior needs one focused replacement"],
            evidence: [],
            usage: null,
          };
        const delivery = request.evidence.find((item) => item.fact === "delivery");
        return {
          verdict: "satisfied",
          summary: "the replacement closes the Outcome",
          gaps: [],
          evidence: delivery ? [{ ...delivery, criterionIndex: 0 }] : [],
          usage: null,
        };
      };
      const replacementGenerator: CampaignReplacementGenerator = async (request) => {
        replacementCalls += 1;
        expect(request.assessment).toMatchObject({ verdict: "gaps" });
        expect(request.evidenceHash).toBe(request.assessment.evidenceHash);
        expect(request.priorProposals.map((proposal) => proposal.proposalId)).toEqual(["initial"]);
        expect(request.remainingBudget.tasks).toBe(9);
        expect(request.remainingBudget.implementerActivations).toBe(limit === null ? null : 1);
        expect(request.remainingBudget.reviewCycles).toBe(limit === null ? null : 1);
        return {
          proposal: replacementWithBudget,
          usage: {
            inputTokens: 13,
            cachedInputTokens: 3,
            uncachedInputTokens: 10,
            cacheWriteInputTokens: 0,
            outputTokens: 8,
            reasoningOutputTokens: 2,
          },
        };
      };
      const { contractPath, server } = await frontierFixture(
        contract,
        "user:campaign-366",
        async (context) => acceptCampaignTask(context),
        1,
        true,
        assessor,
        replacementGenerator,
      );
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("initial", "outcome-one"),
        );
        await handoffCampaign(server.url, published.campaignId);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await getCampaign(server.url, published.campaignId);
          if (current?.status === "accepted") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const campaign = await getCampaign(server.url, published.campaignId);
        expect(calls).toBe(2);
        expect(replacementCalls).toBe(1);
        expect(campaign).toMatchObject({
          status: "accepted",
          outcomes: [{ id: "outcome-one", status: "accepted" }],
          proposals: [
            { proposalId: "initial" },
            {
              proposalId: "replacement",
              replacement: {
                assessmentId: expect.stringMatching(/^assessment-/),
                evidenceHash: expect.any(String),
                role: "replacement-planner",
                usage: { inputTokens: 13, outputTokens: 8 },
              },
            },
          ],
        });
        expect(campaign?.proposals?.map((proposal) => proposal.proposalId)).toEqual([
          "initial",
          "replacement",
        ]);
      } finally {
        await server.close();
      }
    },
  );

  test("persists runtime assessor and invalid planner runs once in Campaign evidence", async () => {
    const contract = oneOutcomeFrontierGoal("campaign-repository");
    let assessorCalls = 0;
    let replacementCalls = 0;
    const modelRun = (
      request: {
        readonly invocationId: string;
        readonly repositories: readonly {
          readonly id: string;
          readonly owner: string;
          readonly name: string;
        }[];
      },
      role: "assessor" | "replacement-planner",
    ) => {
      const repository = request.repositories[0];
      if (!repository) throw new Error("Campaign model-run fixture has no repository");
      const completedAtEpochMs = Date.now();
      return {
        invocationId: request.invocationId,
        role,
        status: "completed" as const,
        failureClass: null,
        startedAtEpochMs: completedAtEpochMs - 4,
        completedAtEpochMs,
        elapsedMs: 4,
        repositoryId: repository.id,
        repository: `${repository.owner}/${repository.name}`,
        profile: "campaign-test-profile",
        configuredProvider: "configured-provider",
        configuredModel: "configured-model",
        actualProvider: "attested-provider",
        actualModel: "attested-model",
        adapter: "sdk",
        serviceTier: "standard",
        reasoningEffort: "medium",
        usage: {
          inputTokens: 9,
          cachedInputTokens: 2,
          uncachedInputTokens: 7,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
      };
    };
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessorCalls += 1;
      return {
        verdict: "gaps",
        summary: "the blocked initial Task leaves one bounded gap",
        gaps: ["the blocked initial Task leaves one bounded gap"],
        evidence: [],
        // Deliberately disagree with the observation below. The model-run
        // observation is the only durable usage owner.
        usage: {
          inputTokens: 901,
          cachedInputTokens: 90,
          uncachedInputTokens: 811,
          cacheWriteInputTokens: 0,
          outputTokens: 902,
          reasoningOutputTokens: 9,
        },
        modelRuns: [modelRun(request, "assessor")],
      };
    };
    const replacementGenerator: CampaignReplacementGenerator = async (request) => {
      replacementCalls += 1;
      return {
        proposal: { invalid: true },
        usage: {
          inputTokens: 801,
          cachedInputTokens: 80,
          uncachedInputTokens: 721,
          cacheWriteInputTokens: 0,
          outputTokens: 802,
          reasoningOutputTokens: 8,
        },
        modelRuns: [modelRun(request, "replacement-planner")],
      };
    };
    const execute = async ({ authority, result }: CampaignExecutionContext) =>
      authority.block(
        { taskId: result.taskId, revision: result.revision },
        "the initial Task is blocked",
      );
    const { contractPath, server, stateDirectory } = await frontierFixture(
      contract,
      "user:campaign-366",
      execute,
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("initial", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(assessorCalls).toBe(1);
      expect(replacementCalls).toBe(1);
      const evidence = await lookupCampaignEvidence(stateDirectory, published.campaignId);
      const campaignRuns = evidence!.runs.filter((run) => run.taskId === null);
      expect(campaignRuns).toHaveLength(2);
      expect(campaignRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "assessor", outcome: "succeeded" }),
          expect.objectContaining({ role: "replacement-planner", outcome: "succeeded" }),
        ]),
      );
      expect(campaignRuns.find((run) => run.role === "assessor")?.usage).toMatchObject({
        inputTokens: 9,
        outputTokens: 5,
      });
      expect(campaignRuns.find((run) => run.role === "replacement-planner")?.usage).toMatchObject({
        inputTokens: 9,
        outputTokens: 5,
      });
      const publicReport = await campaignEvidence(server.url, published.campaignId, 1);
      expect(publicReport!.runs.filter((run) => run.taskId === null)).toHaveLength(2);
      expect(publicReport!.totals.invocations).toBe(evidence!.totals.invocations);
      const campaign = await getCampaign(server.url, published.campaignId);
      expect(campaign?.outcomes[0]?.assessment).toMatchObject({
        usage: { inputTokens: 9, outputTokens: 5 },
        usageSource: "model_run",
      });
      const postHog = campaignEvidenceToPostHogEvents(campaign!, evidence!, "deployment-test");
      const modelEvents = postHog.filter((event) => event.event === "$ai_generation");
      expect(modelEvents).toHaveLength(2);
      expect(new Set(modelEvents.map((event) => event.properties.invocation_id)).size).toBe(2);
      expect(modelEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ role: "assessor", outcome: "succeeded" }),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              role: "replacement-planner",
              outcome: "succeeded",
            }),
          }),
        ]),
      );
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        const assessmentRow = database
          .prepare("SELECT assessment FROM campaign_assessments WHERE campaign_id = ?")
          .get(published.campaignId);
        expect(assessmentRow?.assessment).not.toContain('"inputTokens":901');
        expect(
          database
            .prepare("SELECT usage FROM campaign_replacement_runs WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ usage: null });
      } finally {
        database.close();
      }
    } finally {
      await server.close();
    }
  });

  test("does not report an assessor generation for all-null failure usage", async () => {
    let assessorCalls = 0;
    const assessor: CampaignOutcomeAssessor = async () => {
      assessorCalls += 1;
      return {
        verdict: "inconclusive",
        summary: "the assessor failed before invoking a model",
        gaps: [],
        evidence: [],
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          uncachedInputTokens: null,
          cacheWriteInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
        },
      };
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async ({ authority, result }) =>
        authority.block(
          { taskId: result.taskId, revision: result.revision },
          "the initial Task is blocked",
        ),
      1,
      true,
      assessor,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("initial", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(assessorCalls).toBe(1);
      const evidence = await lookupCampaignEvidence(stateDirectory, published.campaignId);
      expect(
        evidence?.runs
          .filter((run) => run.taskId === null)
          .map(({ role, invocationId, adapter, usage, outcome }) => ({
            role,
            invocationId,
            adapter,
            usage,
            outcome,
          })),
      ).toEqual([]);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM campaign_model_runs WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      await server.close();
    }
  });

  test.each([
    { name: "with canonical usage", usage: lateAssessorUsage, returnsModelRun: true },
    { name: "with unavailable usage", usage: null, returnsModelRun: true },
    { name: "without a canonical model run", usage: null, returnsModelRun: false },
  ])(
    "recovers an interrupted assessor for the current evidence across restart ($name)",
    async ({ usage, returnsModelRun }) => {
      let initialAssessorFinished!: () => void;
      const initialAssessorFinishedPromise = new Promise<void>((resolve) => {
        initialAssessorFinished = resolve;
      });
      let taskStarted!: () => void;
      const taskStartedPromise = new Promise<void>((resolve) => {
        taskStarted = resolve;
      });
      let releaseTask!: () => void;
      const taskRelease = new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      let assessorStarted!: () => void;
      const assessorStartedPromise = new Promise<void>((resolve) => {
        assessorStarted = resolve;
      });
      let assessorCalls = 0;
      const assessor: CampaignOutcomeAssessor = async (request) => {
        const { invocationId, signal } = request;
        if (!signal) throw new Error("assessor cancellation fixture requires a signal");
        assessorCalls += 1;
        if (assessorCalls === 1) {
          initialAssessorFinished();
          return {
            verdict: "inconclusive" as const,
            summary: "the initial assessment predates the accepted delivery",
            gaps: [],
            evidence: [],
            usage: null,
          };
        }
        assessorStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const delivery = request.evidence.find((item) => item.fact === "delivery");
        if (!delivery) throw new Error("late assessor fixture requires accepted delivery evidence");
        const draft = {
          verdict: "satisfied" as const,
          summary: "the late assessor result would have accepted the delivered Outcome",
          gaps: [],
          evidence: request.outcome.acceptance.map((_, criterionIndex) => ({
            ...delivery,
            criterionIndex,
          })),
          usage,
        };
        if (!returnsModelRun) return draft;
        return {
          ...draft,
          modelRuns: [
            {
              invocationId,
              role: "assessor" as const,
              status: "completed" as const,
              failureClass: null,
              startedAtEpochMs: Date.now() - 10,
              completedAtEpochMs: Date.now(),
              elapsedMs: 10,
              repositoryId: null,
              repository: null,
              profile: "campaign-test-profile",
              configuredProvider: "configured-provider",
              configuredModel: "configured-model",
              actualProvider: "attested-provider",
              actualModel: "attested-model",
              adapter: "sdk",
              serviceTier: "standard",
              reasoningEffort: "medium",
              usage,
            },
          ],
        };
      };
      const { contractPath, server, stateDirectory, environment } = await frontierFixture(
        oneOutcomeFrontierGoal("campaign-repository"),
        "user:campaign-366",
        async (context) => {
          taskStarted();
          await taskRelease;
          const result = await acceptCampaignTask(context);
          return result;
        },
        1,
        true,
        assessor,
      );
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("late-assessor-delivery", "outcome-one"),
        );
        await handoffCampaign(server.url, published.campaignId);
        await taskStartedPromise;
        await checkpointCampaign(server.url, published.campaignId);
        await initialAssessorFinishedPromise;
        await waitFor(
          () => getCampaign(server.url, published.campaignId),
          (campaign) => campaign?.outcomes[0]?.assessment?.verdict === "inconclusive",
        );
        releaseTask();
        await waitFor(
          () => taskStatus(server.url, "campaign-campaign-366-v1-late-assessor-delivery"),
          (task) => task?.delivery?.effect === "github",
        );
        await assessorStartedPromise;
        await server.close();

        let originalInvocationId!: string;
        const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          expect(
            database
              .prepare("SELECT COUNT(*) AS count FROM campaign_assessments WHERE campaign_id = ?")
              .get(published.campaignId),
          ).toEqual({ count: 1 });
          const modelRun = database
            .prepare(
              "SELECT invocation_id, status, failure_class, usage FROM campaign_model_runs WHERE campaign_id = ?",
            )
            .get(published.campaignId) as {
            invocation_id: string;
            status: string;
            failure_class: string | null;
            usage: string | null;
          };
          originalInvocationId = modelRun.invocation_id;
          expect(modelRun).toMatchObject({
            status: returnsModelRun ? "completed" : "cancelled",
            failure_class: returnsModelRun ? null : "cancellation",
            usage: usage === null ? null : JSON.stringify(usage),
          });
          expect(modelRun.invocation_id).not.toContain(":cancelled");
        } finally {
          database.close();
        }

        let restartedAssessorCalls = 0;
        const restarted = await startUsineServer({
          environment,
          assessOutcome: async (request) => {
            restartedAssessorCalls += 1;
            const delivery = request.evidence.find((item) => item.fact === "delivery");
            if (!delivery) throw new Error("restart assessor fixture requires delivery evidence");
            return {
              verdict: "satisfied",
              summary: "the restarted assessor accepts the delivered Outcome",
              gaps: [],
              evidence: request.outcome.acceptance.map((_, criterionIndex) => ({
                ...delivery,
                criterionIndex,
              })),
              usage: lateAssessorUsage,
              modelRuns: [
                {
                  invocationId: request.invocationId,
                  role: "assessor" as const,
                  status: "completed" as const,
                  failureClass: null,
                  startedAtEpochMs: Date.now() - 10,
                  completedAtEpochMs: Date.now(),
                  elapsedMs: 10,
                  repositoryId: null,
                  repository: null,
                  profile: "campaign-test-profile",
                  configuredProvider: "configured-provider",
                  configuredModel: "configured-model",
                  actualProvider: "attested-provider",
                  actualModel: "attested-model",
                  adapter: "sdk",
                  serviceTier: "standard",
                  reasoningEffort: "medium",
                  usage: lateAssessorUsage,
                },
              ],
            };
          },
          host: "127.0.0.1",
          port: 0,
        });
        try {
          const recovered = await waitFor(
            () => getCampaign(restarted.url, published.campaignId),
            (campaign) => campaign?.status === "accepted",
          );
          if (!recovered) throw new Error("Campaign disappeared during assessor recovery");
          expect(recovered).toMatchObject({
            status: "accepted",
            outcomes: [{ assessment: { verdict: "satisfied" } }],
          });
          expect(assessorCalls).toBe(2);
          expect(restartedAssessorCalls).toBe(1);
          await restarted.close();

          const modelRunsAfterRecovery = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
          try {
            const rows = modelRunsAfterRecovery
              .prepare(
                "SELECT invocation_id, status, failure_class, usage FROM campaign_model_runs WHERE campaign_id = ? ORDER BY invocation_id",
              )
              .all(published.campaignId) as {
              invocation_id: string;
              status: string;
              failure_class: string | null;
              usage: string | null;
            }[];
            expect(rows).toHaveLength(2);
            expect(rows.map((row) => row.invocation_id)).toContain(originalInvocationId);
            expect(rows[0]?.invocation_id).not.toBe(rows[1]?.invocation_id);
            expect(rows[0]).toMatchObject({
              status: returnsModelRun ? "completed" : "cancelled",
              failure_class: returnsModelRun ? null : "cancellation",
              usage: usage === null ? null : JSON.stringify(usage),
            });
            expect(rows[1]).toMatchObject({
              status: "completed",
              failure_class: null,
              usage: JSON.stringify(lateAssessorUsage),
            });
          } finally {
            modelRunsAfterRecovery.close();
          }

          let secondRestartAssessorCalls = 0;
          const secondRestart = await startUsineServer({
            environment,
            assessOutcome: async () => {
              secondRestartAssessorCalls += 1;
              throw new Error("an accepted current assessment must not be reassessed");
            },
            host: "127.0.0.1",
            port: 0,
          });
          try {
            await expect(
              getCampaign(secondRestart.url, published.campaignId),
            ).resolves.toMatchObject(recovered);
            expect(secondRestartAssessorCalls).toBe(0);
          } finally {
            await secondRestart.close();
          }
        } finally {
          await restarted.close().catch(() => undefined);
        }
      } finally {
        releaseTask();
        await server.close().catch(() => undefined);
      }
    },
  );

  test("preserves a same-evidence checkpoint declared during an assessor", async () => {
    let assessorStarted!: () => void;
    const assessorStartedPromise = new Promise<void>((resolve) => {
      assessorStarted = resolve;
    });
    let releaseAssessor!: () => void;
    const assessorRelease = new Promise<void>((resolve) => {
      releaseAssessor = resolve;
    });
    let assessorCalls = 0;
    const assessor: CampaignOutcomeAssessor = async () => {
      assessorCalls += 1;
      assessorStarted();
      await assessorRelease;
      return {
        verdict: "inconclusive",
        summary: "the checkpoint assessor found no accepted delivery",
        gaps: [],
        evidence: [],
        usage: lateAssessorUsage,
      };
    };
    const { contractPath, server, stateDirectory } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      undefined,
      1,
      true,
      assessor,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await handoffCampaign(server.url, published.campaignId);
      await assessorStartedPromise;

      await checkpointCampaign(server.url, published.campaignId);
      releaseAssessor();
      const completed = await waitFor(
        () => getCampaign(server.url, published.campaignId),
        (campaign) =>
          campaign?.status === "blocked" &&
          campaign.outcomes[0]?.assessment?.verdict === "inconclusive",
      );
      if (!completed) throw new Error("Campaign disappeared during checkpoint recovery");
      expect(completed).toMatchObject({
        status: "blocked",
        decisionRequest: {
          reason: "assessment_inconclusive",
          outcomeIds: ["outcome-one"],
        },
        outcomes: [{ assessment: { verdict: "inconclusive" } }],
      });
      expect(assessorCalls).toBe(1);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, evidence_hash, usage FROM campaign_model_runs WHERE campaign_id = ?",
            )
            .get(published.campaignId),
        ).toMatchObject({
          status: "completed",
          evidence_hash: expect.any(String),
          usage: JSON.stringify(lateAssessorUsage),
        });
      } finally {
        database.close();
      }
      await server.close();
      let restartedAssessorCalls = 0;
      const restarted = await startUsineServer({
        environment: { USINE_STATE_DIR: stateDirectory },
        assessOutcome: async () => {
          restartedAssessorCalls += 1;
          return {
            verdict: "inconclusive",
            summary: "unexpected checkpoint reassessment",
            gaps: [],
            evidence: [],
            usage: null,
          };
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
          completed,
        );
        expect(restartedAssessorCalls).toBe(0);
      } finally {
        await restarted.close();
      }
    } finally {
      releaseAssessor();
      await server.close();
    }
  });

  test("continues successive corrections after final assessment and recovers malformed attempts", async () => {
    let assessmentCalls = 0;
    let replacementCalls = 0;
    const assessor: CampaignOutcomeAssessor = async (request) => {
      assessmentCalls += 1;
      if (assessmentCalls === 1) throw new Error("interrupted assessment");
      if (assessmentCalls === 2)
        return {
          verdict: "malformed",
          summary: "malformed assessment",
          gaps: [],
          evidence: [],
          usage: null,
        } as unknown as Awaited<ReturnType<CampaignOutcomeAssessor>>;
      if (assessmentCalls < 5)
        return {
          verdict: "gaps",
          summary: "the Outcome still needs another correction",
          gaps: ["the latest correction is incomplete"],
          evidence: [],
          usage: null,
        };
      return satisfiesDeliveredOutcome(request);
    };
    const replacementGenerator: CampaignReplacementGenerator = async () => {
      replacementCalls += 1;
      if (replacementCalls === 1) throw new Error("interrupted planner");
      if (replacementCalls === 2)
        return { proposal: { malformed: true }, usage: null } as unknown as Awaited<
          ReturnType<CampaignReplacementGenerator>
        >;
      return {
        proposal: quotaFreeFrontierProposal(`replacement-${replacementCalls - 2}`, "outcome-one"),
        usage: null,
      };
    };
    const { contractPath, server, stateDirectory, environment } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        quotaFreeFrontierProposal("initial", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      let completed = await getCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 600 && completed?.status !== "accepted"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = await getCampaign(server.url, published.campaignId);
      }
      if (completed?.status !== "accepted")
        throw new Error(
          `successive correction stalled: ${JSON.stringify({
            status: completed?.status,
            decisionRequest: completed?.decisionRequest,
            proposals: completed?.proposals?.map((proposal) => proposal.proposalId),
            assessmentCalls,
            replacementCalls,
          })}`,
        );
      expect(completed).toMatchObject({
        status: "accepted",
        proposals: [
          { proposalId: "initial" },
          { proposalId: "replacement-1" },
          { proposalId: "replacement-2" },
        ],
      });
      expect(assessmentCalls).toBeGreaterThanOrEqual(5);
      expect(replacementCalls).toBeGreaterThanOrEqual(4);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ? ORDER BY started_at_epoch_ms",
            )
            .all(published.campaignId, "outcome-one"),
        ).toEqual([
          { status: "unavailable" },
          { status: "invalid" },
          { status: "admitted" },
          { status: "admitted" },
        ]);
      } finally {
        database.close();
      }

      await server.close();
      const restarted = await startUsineServer({
        environment,
        assessOutcome: async () => {
          throw new Error("accepted Campaign must not reassess");
        },
        generateReplacement: async () => {
          throw new Error("accepted Campaign must not plan more work");
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
          completed,
        );
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  }, 20_000);

  test("recovers a pending replacement after late completion during shutdown", async () => {
    let replacementCalls = 0;
    let replacementEntered!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    let cancellationObserved!: () => void;
    const replacementCancelled = new Promise<void>((resolve) => {
      cancellationObserved = resolve;
    });
    let releaseCleanup!: () => void;
    const delayedCleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cancellationUsage = {
      inputTokens: 13,
      cachedInputTokens: 3,
      uncachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    };
    const assessor: CampaignOutcomeAssessor = async () => ({
      verdict: "gaps",
      summary: "the frontier remains incomplete",
      gaps: ["the reserved replacement did not finish"],
      evidence: [],
      usage: null,
    });
    let restartedReplacementCalls = 0;
    const replacementGenerator: CampaignReplacementGenerator = async ({ invocationId, signal }) => {
      if (!signal) throw new Error("replacement cancellation fixture requires a signal");
      replacementCalls += 1;
      replacementEntered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          cancellationObserved();
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            cancellationObserved();
            resolve();
          },
          { once: true },
        );
      });
      await delayedCleanup;
      return {
        proposal: frontierProposal("late-replacement", "outcome-one"),
        usage: cancellationUsage,
        modelRuns: [
          {
            invocationId,
            role: "replacement-planner",
            status: "completed" as const,
            failureClass: null,
            startedAtEpochMs: Date.now() - 10,
            completedAtEpochMs: Date.now(),
            elapsedMs: 10,
            repositoryId: "campaign-repository",
            repository: "example/campaign-repository",
            profile: "campaign-test-profile",
            configuredProvider: "configured-provider",
            configuredModel: "configured-model",
            actualProvider: "attested-provider",
            actualModel: "attested-model",
            adapter: "sdk",
            serviceTier: "standard",
            reasoningEffort: "medium",
            usage: cancellationUsage,
          },
        ],
      };
    };
    const { contractPath, server, stateDirectory, environment } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("initial", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      await replacementStarted;
      expect(replacementCalls).toBe(1);
      let closed = false;
      const close = server.close().then(() => {
        closed = true;
      });
      await replacementCancelled;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      releaseCleanup();
      await close;

      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare(
              "SELECT status, assessment_id, evidence_hash, invocation_id, role FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
            )
            .get(published.campaignId, "outcome-one"),
        ).toMatchObject({ status: "pending", role: "replacement-planner" });
      } finally {
        database.close();
      }
      const modelRuns = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        const rows = modelRuns
          .prepare(
            "SELECT invocation_id, status, failure_class, usage FROM campaign_model_runs WHERE campaign_id = ?",
          )
          .all(published.campaignId) as {
          invocation_id: string;
          status: string;
          failure_class: string | null;
          usage: string | null;
        }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "completed",
          failure_class: null,
          usage: JSON.stringify(cancellationUsage),
        });
        expect(rows[0]?.invocation_id).not.toContain(":cancelled");
      } finally {
        modelRuns.close();
      }

      const restarted = await startUsineServer({
        environment,
        assessOutcome: assessor,
        generateReplacement: async () => {
          restartedReplacementCalls += 1;
          return { proposal: frontierProposal("unexpected", "outcome-one"), usage: null };
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          status: "blocked",
          decisionRequest: {
            requestId: `decision:${published.campaignId}`,
            reason: "replacement_unavailable",
            outcomeIds: ["outcome-one"],
          },
        });
        expect(replacementCalls).toBe(1);
        expect(restartedReplacementCalls).toBe(0);
        const recovered = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          const row = recovered
            .prepare(
              "SELECT status, proposal, usage, completed_at_epoch_ms FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
            )
            .get(published.campaignId, "outcome-one");
          expect(row).toMatchObject({
            status: "unavailable",
            proposal: null,
            usage: null,
            completed_at_epoch_ms: expect.any(Number),
          });
        } finally {
          recovered.close();
        }
        const modelRuns = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          const row = modelRuns
            .prepare(
              "SELECT invocation_id, status, failure_class, usage FROM campaign_model_runs WHERE campaign_id = ?",
            )
            .get(published.campaignId) as {
            invocation_id: string;
            status: string;
            failure_class: string | null;
            usage: string | null;
          };
          expect(row).toMatchObject({
            status: "completed",
            failure_class: null,
            usage: JSON.stringify(cancellationUsage),
          });
          expect(row.invocation_id).not.toContain(":cancelled");
        } finally {
          modelRuns.close();
        }
      } finally {
        await restarted.close();
      }
    } finally {
      releaseCleanup?.();
      await server.close().catch(() => undefined);
    }
  });

  test("does not treat a dependency-blocked replacement as useful work", async () => {
    let replacementCalls = 0;
    const assessor: CampaignOutcomeAssessor = async () => ({
      verdict: "gaps",
      summary: "the blocked branch leaves the Outcome incomplete",
      gaps: ["a replacement cannot depend on unavailable work"],
      evidence: [],
      usage: null,
    });
    const replacementGenerator: CampaignReplacementGenerator = async () => {
      replacementCalls += 1;
      return {
        proposal: frontierProposal("replacement", "outcome-one", ["initial"]),
        usage: null,
      };
    };
    const initial = { ...frontierProposal("initial", "outcome-one"), effects: ["shell"] };
    const { contractPath, server, environment } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) =>
        context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "the initial branch is unavailable",
        ),
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, initial);
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 250; attempt += 1) {
        if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const first = await getCampaign(server.url, published.campaignId);
      expect(first).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "branches_blocked",
          outcomeIds: ["outcome-one"],
        },
        proposals: [
          { proposalId: "initial", status: "blocked" },
          {
            proposalId: "replacement",
            status: "planned",
            blocker: "proposal dependency has no accepted delivery",
          },
        ],
      });
      expect(replacementCalls).toBe(1);
      await server.close();

      const restarted = await startUsineServer({
        environment,
        assessOutcome: async () => {
          throw new Error("a dependency-blocked decision must not reassess");
        },
        generateReplacement: async () => {
          throw new Error("a dependency-blocked decision must not replan");
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        if (!first) throw new Error("Campaign disappeared before restart");
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
          first,
        );
        expect(replacementCalls).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("revalidates a later Outcome replacement against the consumed Task budget", async () => {
    let replacementCalls = 0;
    let plannerRemainingTasks: number | undefined;
    let plannerDeadlineEpochMs: number | undefined;
    const assessor: CampaignOutcomeAssessor = async () => ({
      verdict: "gaps",
      summary: "both Outcomes remain incomplete",
      gaps: ["the bounded frontier remains incomplete"],
      evidence: [],
      usage: null,
    });
    const replacementGenerator: CampaignReplacementGenerator = async (request) => {
      replacementCalls += 1;
      plannerRemainingTasks = request.remainingBudget.tasks;
      plannerDeadlineEpochMs = request.deadlineEpochMs;
      return {
        proposal: frontierProposal(
          `replacement-${request.outcome.id}`,
          request.outcome.id,
          request.outcome.id === "outcome-one" ? ["initial-one"] : [],
        ),
        usage: null,
      };
    };
    const contract = {
      ...frontierGoal("campaign-repository"),
      budget: {
        ...frontierGoal("campaign-repository").budget,
        maxElapsedMs: 120_000,
        maxTasks: 3,
      },
    };
    const initialOne = frontierProposal("initial-one", "outcome-one");
    const initialTwo = frontierProposal("initial-two", "outcome-two");
    const { contractPath, server, stateDirectory, environment } = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) =>
        context.authority.block(
          { taskId: context.result.taskId, revision: context.result.revision },
          "the initial branch is unavailable",
        ),
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(server.url, published.campaignId, initialOne);
      await proposeCampaign(server.url, published.campaignId, initialTwo);
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(replacementCalls).toBe(1);
      expect(plannerRemainingTasks).toBe(1);
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        const campaignCreatedAt = (
          database
            .prepare("SELECT created_at FROM campaigns WHERE campaign_id = ?")
            .get(published.campaignId) as { created_at: number }
        ).created_at;
        expect(plannerDeadlineEpochMs).toBe(campaignCreatedAt + contract.budget.maxElapsedMs);
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ count: 3 });
        expect(
          database
            .prepare(
              "SELECT outcome_id, status FROM campaign_replacement_runs WHERE campaign_id = ? ORDER BY outcome_id",
            )
            .all(published.campaignId),
        ).toEqual([
          { outcome_id: "outcome-one", status: "admitted" },
          { outcome_id: "outcome-two", status: "budget_exhausted" },
        ]);
      } finally {
        database.close();
      }
      const first = await getCampaign(server.url, published.campaignId);
      expect(first).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "replacement_budget_exhausted",
        },
      });

      await server.close();
      const restarted = await startUsineServer({
        environment,
        assessOutcome: async () => {
          throw new Error("a consumed budget must not reassess");
        },
        generateReplacement: async () => {
          throw new Error("a consumed budget must not replan");
        },
        host: "127.0.0.1",
        port: 0,
      });
      try {
        if (!first) throw new Error("Campaign disappeared before budget decision persisted");
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
          first,
        );
        expect(replacementCalls).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  test("upgrades a persisted assessment-gaps frontier once after restart", async () => {
    const contract = oneOutcomeFrontierGoal("campaign-repository");
    const fixtureValue = await frontierFixture(contract);
    const { contractPath, server, stateDirectory, environment } = fixtureValue;
    let published;
    try {
      published = await publishCampaign(server.url, { contractPath });
    } finally {
      await server.close();
    }

    const outcome = { ...contract.outcomes[0]!, status: "live" as const };
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify({ outcome, evidence: [] }), "utf8")
      .digest("hex");
    const completedAtEpochMs = Date.now();
    const assessment = {
      role: "assessor",
      assessmentId: "legacy-gaps-assessment",
      outcomeId: outcome.id,
      evidenceHash,
      verdict: "gaps",
      summary: "the persisted assessment identified an incomplete frontier",
      gaps: ["the frontier remains incomplete"],
      evidence: [],
      usage: {
        inputTokens: 17,
        cachedInputTokens: 3,
        uncachedInputTokens: 14,
        cacheWriteInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 1,
      },
      startedAtEpochMs: completedAtEpochMs - 1,
      completedAtEpochMs,
    };
    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO campaign_assessments (campaign_id, outcome_id, role, evidence_hash, assessment_id, assessment, started_at_epoch_ms, completed_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          published.campaignId,
          outcome.id,
          "assessor",
          evidenceHash,
          assessment.assessmentId,
          JSON.stringify(assessment),
          assessment.startedAtEpochMs,
          assessment.completedAtEpochMs,
        );
      database
        .prepare(
          "INSERT INTO campaign_model_runs (invocation_id, campaign_id, outcome_id, role, assessment_id, evidence_hash, status, failure_class, started_at_epoch_ms, completed_at_epoch_ms, elapsed_ms, adapter, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          assessment.assessmentId,
          published.campaignId,
          outcome.id,
          "assessor",
          assessment.assessmentId,
          evidenceHash,
          "completed",
          null,
          assessment.startedAtEpochMs,
          assessment.completedAtEpochMs,
          1,
          "legacy-compatibility",
          JSON.stringify({
            inputTokens: 23,
            cachedInputTokens: 4,
            uncachedInputTokens: 19,
            cacheWriteInputTokens: 0,
            outputTokens: 12,
            reasoningOutputTokens: 2,
          }),
        );
      database
        .prepare(
          "UPDATE campaigns SET plan_handed_off = 1, status = 'blocked', decision_request = ?, assessment_requested = 0 WHERE campaign_id = ?",
        )
        .run(
          JSON.stringify({
            requestId: `decision:${published.campaignId}`,
            reason: "assessment_gaps",
            outcomeIds: [outcome.id],
          }),
          published.campaignId,
        );
    } finally {
      database.close();
    }

    let replacementCalls = 0;
    const replacement = frontierProposal("upgraded-replacement", outcome.id);
    const execute = async (context: CampaignExecutionContext) =>
      context.authority.block(
        { taskId: context.result.taskId, revision: context.result.revision },
        "the upgraded replacement is unavailable",
      );
    const restarted = await startUsineServer({
      environment,
      assessOutcome: async () => {
        throw new Error("a persisted assessment-gaps frontier must not reassess");
      },
      generateReplacement: async () => {
        replacementCalls += 1;
        return { proposal: replacement, usage: null };
      },
      execute,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const upgraded = await waitFor(
        () => getCampaign(restarted.url, published.campaignId),
        (campaign) =>
          campaign?.proposals?.some(({ proposalId }) => proposalId === replacement.proposalId) ??
          false,
      );
      expect(replacementCalls).toBe(1);
      expect(upgraded).toMatchObject({
        proposals: [{ proposalId: replacement.proposalId }],
        outcomes: [
          {
            assessment: {
              usage: { inputTokens: 23, outputTokens: 12 },
              usageSource: "legacy_compatibility",
            },
          },
        ],
      });
      await restarted.close();
      const finalRestart = await startUsineServer({
        environment,
        assessOutcome: async () => {
          throw new Error("the upgraded frontier must not reassess");
        },
        generateReplacement: async () => {
          throw new Error("the one upgrade opportunity must not repeat");
        },
        execute,
        host: "127.0.0.1",
        port: 0,
      });
      try {
        expect(replacementCalls).toBe(1);
        await expect(getCampaign(finalRestart.url, published.campaignId)).resolves.toMatchObject({
          proposals: [{ proposalId: replacement.proposalId }],
        });
      } finally {
        await finalRestart.close();
      }
    } finally {
      await restarted.close().catch(() => undefined);
    }
  });

  test("rejects a deferred replacement after Campaign abandonment", async () => {
    let replacementCalls = 0;
    let replacementEntered!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    let releaseReplacement!: () => void;
    const replacementRelease = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const assessor: CampaignOutcomeAssessor = async () => ({
      verdict: "gaps",
      summary: "the delivered leaf does not satisfy the Outcome",
      gaps: ["the Outcome remains incomplete"],
      evidence: [],
      usage: null,
    });
    const replacementGenerator: CampaignReplacementGenerator = async () => {
      replacementCalls += 1;
      replacementEntered();
      await replacementRelease;
      return { proposal: frontierProposal("stale-replacement", "outcome-one"), usage: null };
    };
    const { contractPath, server, stateDirectory, environment } = await frontierFixture(
      oneOutcomeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => acceptCampaignTask(context),
      1,
      true,
      assessor,
      replacementGenerator,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("initial", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      await replacementStarted;
      environment.USINE_CAMPAIGN_ABANDONMENT_SOURCE = "user:campaign-366";
      await expect(abandonCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "abandoned",
      });
      releaseReplacement();

      let replacementStatus: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          const row = database
            .prepare(
              "SELECT status FROM campaign_replacement_runs WHERE campaign_id = ? AND outcome_id = ?",
            )
            .get(published.campaignId, "outcome-one");
          if (
            typeof row === "object" &&
            row !== null &&
            "status" in row &&
            typeof row.status === "string"
          )
            replacementStatus = row.status;
        } finally {
          database.close();
        }
        if (replacementStatus === "invalid") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(replacementCalls).toBe(1);
      expect(replacementStatus).toBe("invalid");
      const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
      try {
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM campaign_proposals WHERE campaign_id = ?")
            .get(published.campaignId),
        ).toEqual({ count: 1 });
      } finally {
        database.close();
      }
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "abandoned",
      });

      await server.close();
      const restarted = await startUsineServer({
        environment,
        assessOutcome: async () => {
          throw new Error("an abandoned Campaign must not reassess");
        },
        generateReplacement: async () => {
          throw new Error("an abandoned Campaign must not replan");
        },
        execute: async (context) =>
          context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "the stale replacement must not execute",
          ),
        host: "127.0.0.1",
        port: 0,
      });
      try {
        await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject({
          status: "abandoned",
        });
        expect(replacementCalls).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      releaseReplacement?.();
      await server.close().catch(() => undefined);
    }
  });

  test.each([
    {
      name: "remaining Task budget",
      contract: {
        ...oneOutcomeFrontierGoal("campaign-repository"),
        budget: { ...oneOutcomeFrontierGoal("campaign-repository").budget, maxTasks: 1 },
      },
      initial: frontierProposal("initial", "outcome-one"),
      replacement: frontierProposal("replacement", "outcome-one"),
      elapsed: false,
      expectedPlannerCalls: 0,
    },
    {
      name: "remaining activation budget",
      contract: oneOutcomeFrontierGoal("campaign-repository"),
      initial: frontierProposal("initial", "outcome-one"),
      replacement: frontierProposal(
        "replacement",
        "outcome-one",
        [],
        false,
        "campaign-repository",
        2,
      ),
      elapsed: false,
      expectedPlannerCalls: 1,
    },
    {
      name: "remaining review budget",
      contract: {
        ...oneOutcomeFrontierGoal("campaign-repository"),
        budget: { ...oneOutcomeFrontierGoal("campaign-repository").budget, maxReviewCycles: 2 },
      },
      initial: frontierProposal("initial", "outcome-one"),
      replacement: {
        ...frontierProposal("replacement", "outcome-one"),
        budget: { ...frontierProposal("replacement", "outcome-one").budget, maxReviewCycles: 2 },
      },
      elapsed: false,
      expectedPlannerCalls: 1,
    },
    {
      name: "remaining elapsed budget",
      contract: {
        ...oneOutcomeFrontierGoal("campaign-repository"),
        budget: { ...oneOutcomeFrontierGoal("campaign-repository").budget, maxElapsedMs: 1_000 },
      },
      initial: {
        ...frontierProposal("initial", "outcome-one"),
        budget: { ...frontierProposal("initial", "outcome-one").budget, maxElapsedMs: 1_000 },
      },
      replacement: frontierProposal("replacement", "outcome-one"),
      elapsed: true,
      expectedPlannerCalls: 0,
    },
  ] as const)(
    "rejects replacement when $name is exhausted",
    async ({ contract, initial, replacement, elapsed, expectedPlannerCalls }) => {
      let replacementCalls = 0;
      const assessor: CampaignOutcomeAssessor = async () => ({
        verdict: "gaps",
        summary: "the frontier remains incomplete",
        gaps: ["no remaining budget dimension can admit replacement work"],
        evidence: [],
        usage: null,
      });
      const replacementGenerator: CampaignReplacementGenerator = async () => {
        replacementCalls += 1;
        return { proposal: replacement, usage: null };
      };
      const { contractPath, server, stateDirectory } = await frontierFixture(
        contract,
        "user:campaign-366",
        async (context) => acceptCampaignTask(context),
        1,
        true,
        assessor,
        replacementGenerator,
      );
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(server.url, published.campaignId, initial);
        if (elapsed) {
          // The elapsed case needs only the Campaign clock exhausted; the Task deadline remains valid.
          const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
          try {
            database
              .prepare("UPDATE campaigns SET created_at = ? WHERE campaign_id = ?")
              .run(Date.now() - 2_000, published.campaignId);
          } finally {
            database.close();
          }
        }
        await handoffCampaign(server.url, published.campaignId);
        for (let attempt = 0; attempt < 250; attempt += 1) {
          if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
          status: "blocked",
          decisionRequest: {
            reason: "replacement_budget_exhausted",
            outcomeIds: ["outcome-one"],
          },
        });
        expect(replacementCalls).toBe(expectedPlannerCalls);
        const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
        try {
          expect(
            database
              .prepare("SELECT status FROM campaign_replacement_runs WHERE campaign_id = ?")
              .get(published.campaignId),
          ).toMatchObject({ status: "budget_exhausted" });
        } finally {
          database.close();
        }
      } finally {
        await server.close();
      }
    },
  );

  test.each([
    {
      name: "strict-schema output",
      proposal: { ...frontierProposal("replacement", "outcome-one"), unexpected: true },
      reason: "replacement_invalid",
      storedStatus: "invalid",
    },
    {
      name: "wrong Outcome",
      proposal: frontierProposal("replacement", "outcome-two"),
      reason: "replacement_invalid",
      storedStatus: "invalid",
    },
    {
      name: "out-of-authority Repository",
      proposal: { ...frontierProposal("replacement", "outcome-one"), repositoryId: "other" },
      reason: "replacement_invalid",
      storedStatus: "invalid",
    },
    {
      name: "out-of-authority effect",
      proposal: { ...frontierProposal("replacement", "outcome-one"), effects: ["shell"] },
      reason: "replacement_invalid",
      storedStatus: "invalid",
    },
    {
      name: "out-of-authority merge",
      proposal: { ...frontierProposal("replacement", "outcome-one"), merge: true },
      reason: "replacement_invalid",
      storedStatus: "invalid",
    },
    {
      name: "duplicate owned work",
      proposal: frontierProposal("initial", "outcome-one"),
      reason: "replacement_duplicate",
      storedStatus: "duplicate",
    },
    {
      name: "remaining budget excess",
      proposal: {
        ...frontierProposal("replacement", "outcome-one"),
        budget: {
          ...frontierProposal("replacement", "outcome-one").budget,
          maxImplementerActivations: 2,
        },
      },
      reason: "replacement_budget_exhausted",
      storedStatus: "budget_exhausted",
    },
    {
      name: "unavailable result",
      proposal: null,
      reason: "replacement_unavailable",
      storedStatus: "unavailable",
    },
  ] as const)(
    "rejects $name and consumes exactly one replacement opportunity",
    async ({ proposal, reason, storedStatus }) => {
      let replacementCalls = 0;
      const assessor: CampaignOutcomeAssessor = async () => ({
        verdict: "gaps",
        summary: "the bounded frontier remains incomplete",
        gaps: ["one replacement opportunity is available"],
        evidence: [],
        usage: null,
      });
      const replacementGenerator: CampaignReplacementGenerator = async () => {
        replacementCalls += 1;
        return { proposal, usage: null };
      };
      const { contractPath, server, stateDirectory, environment } = await frontierFixture(
        oneOutcomeFrontierGoal("campaign-repository"),
        "user:campaign-366",
        async (context) => acceptCampaignTask(context),
        1,
        true,
        assessor,
        replacementGenerator,
      );
      try {
        const published = await publishCampaign(server.url, { contractPath });
        await proposeCampaign(
          server.url,
          published.campaignId,
          frontierProposal("initial", "outcome-one"),
        );
        await handoffCampaign(server.url, published.campaignId);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if ((await getCampaign(server.url, published.campaignId))?.status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const first = await getCampaign(server.url, published.campaignId);
        if (!first) throw new Error("Campaign disappeared before replacement decision persisted");
        expect(first).toMatchObject({
          status: "blocked",
          decisionRequest: {
            requestId: `decision:${published.campaignId}`,
            reason,
            outcomeIds: ["outcome-one"],
          },
        });
        expect(replacementCalls).toBe(1);
        await server.close();

        const restarted = await startUsineServer({
          environment,
          assessOutcome: assessor,
          generateReplacement: replacementGenerator,
          host: "127.0.0.1",
          port: 0,
        });
        try {
          await expect(getCampaign(restarted.url, published.campaignId)).resolves.toMatchObject(
            first,
          );
          expect(replacementCalls).toBe(1);
          const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
          try {
            expect(
              database
                .prepare(
                  "SELECT status, role, usage FROM campaign_replacement_runs WHERE campaign_id = ?",
                )
                .get(published.campaignId),
            ).toMatchObject({ status: storedStatus, role: "replacement-planner", usage: null });
          } finally {
            database.close();
          }
        } finally {
          await restarted.close();
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  );

  test("continues an independent branch around a blocked branch", async () => {
    const base = frontierGoal("campaign-repository");
    const contract = {
      ...mergeFrontierGoal("campaign-repository"),
      outcomes: base.outcomes.map((outcome) => ({ ...outcome, dependsOn: [] })),
    };
    let executions = 0;
    const { contractPath, server } = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) => {
        executions += 1;
        if (context.result.taskId.endsWith("blocked-branch"))
          return context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "independent branch is blocked",
          );
        return acceptCampaignTask(context, true);
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("blocked-branch", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("useful-branch", "outcome-two", [], true),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "blocked") break;
      }
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: {
          reason: "assessment_inconclusive",
          outcomeIds: ["outcome-one"],
        },
        outcomes: [
          { id: "outcome-one", status: "planned", evidence: null },
          { id: "outcome-two", status: "accepted", evidence: { outcomeId: "outcome-two" } },
        ],
      });
      expect(executions).toBe(2);
    } finally {
      await server.close();
    }
  });

  test("requires every fixed-plan proposal for an Outcome to be accepted", async () => {
    const { contractPath, server } = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("partial-two"))
          return context.authority.block(
            { taskId: context.result.taskId, revision: context.result.revision },
            "one required proposal is blocked",
          );
        return acceptCampaignTask(context, true);
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("partial-one", "outcome-one", [], true),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("partial-two", "outcome-one", [], true),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        outcomes: [
          { id: "outcome-one", status: "planned", evidence: null },
          { id: "outcome-two", status: "planned", evidence: null },
        ],
        decisionRequest: {
          reason: "assessment_inconclusive",
          outcomeIds: ["outcome-one", "outcome-two"],
        },
      });
    } finally {
      await server.close();
    }
  });

  test("does not count a blocked dependency without a Task result as useful work", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const blocked = await proposeCampaign(server.url, published.campaignId, {
        ...frontierProposal("blocked-predecessor", "outcome-one"),
        effects: ["outside"],
      });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("blocked-successor", "outcome-two", ["blocked-predecessor"]),
      );
      expect(blocked.proposals?.[0]).toMatchObject({
        proposalId: "blocked-predecessor",
        status: "blocked",
        blocker: "proposal effect is outside the Goal authority envelope",
        ready: null,
      });
      expect(blocked.proposals?.[0]?.ready?.taskId ?? null).toBeNull();
      await expect(serverSnapshot(server.url)).resolves.toMatchObject({ tasks: [] });
      await handoffCampaign(server.url, published.campaignId);
      await expect(
        waitFor(
          () => getCampaign(server.url, published.campaignId),
          (campaign) => campaign?.status === "blocked",
        ),
      ).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: { reason: "branches_blocked" },
        proposals: [
          {
            proposalId: "blocked-predecessor",
            status: "blocked",
            blocker: "proposal effect is outside the Goal authority envelope",
            ready: null,
          },
          { proposalId: "blocked-successor", status: "planned" },
        ],
      });
    } finally {
      await server.close();
    }
  });

  test("accepts reviewed_pr evidence for its Outcome while another Outcome remains incomplete", async () => {
    const { contractPath, server } = await frontierFixture(
      mergeFrontierGoal("campaign-repository"),
      "user:campaign-366",
      async (context) => {
        const reviewed = await reviewCampaignTask(context);
        if (!reviewed.candidateSha) throw new Error("fixture review has no candidate");
        return context.authority.recordDelivery(
          { taskId: reviewed.taskId, revision: reviewed.revision },
          {
            sha: reviewed.candidateSha,
            effect: "github",
            prNumber: 1,
            url: "https://example.invalid/pull/1",
            attestationId: `fixture-${reviewed.taskId}`,
            merge: null,
          },
        );
      },
      1,
      true,
      satisfiesDeliveredOutcome,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("pr-only", "outcome-one"),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const current = await taskStatus(server.url, "campaign-campaign-366-v1-pr-only");
        if (current?.state === "reviewed_pr") break;
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getCampaign(server.url, published.campaignId);
        if (current?.status === "blocked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        outcomes: [
          {
            id: "outcome-one",
            status: "accepted",
            evidence: { outcomeId: "outcome-one", merged: false, mergeCommitSha: null },
          },
          { id: "outcome-two", status: "planned", evidence: null },
        ],
        decisionRequest: { reason: "assessment_inconclusive", outcomeIds: ["outcome-two"] },
      });
    } finally {
      await server.close();
    }
  });

  test("does not accept check success or model completion without accepted delivery", async () => {
    const base = frontierGoal("campaign-repository");
    const contract = {
      ...frontierGoal("campaign-repository"),
      outcomes: base.outcomes.map((outcome) => ({ ...outcome, dependsOn: [] })),
    };
    const { contractPath, server } = await frontierFixture(
      contract,
      "user:campaign-366",
      async (context) => {
        if (context.result.taskId.endsWith("check-only")) return checkCampaignTask(context);
        return context.result;
      },
      2,
    );
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("check-only", "outcome-one"),
      );
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("model-only", "outcome-two"),
      );
      await handoffCampaign(server.url, published.campaignId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await taskStatus(server.url, "campaign-campaign-366-v1-check-only");
        if (current?.state === "checked") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(
        taskStatus(server.url, "campaign-campaign-366-v1-check-only"),
      ).resolves.toMatchObject({ state: "checked", check: { status: "passed" } });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "planning",
        planHandedOff: true,
        outcomes: [
          { id: "outcome-one", status: "planned", evidence: null },
          { id: "outcome-two", status: "planned", evidence: null },
        ],
      });
    } finally {
      await server.close();
    }
  });

  test("requires explicit host authority for abandonment", async () => {
    const fixtureValue = await frontierFixture();
    const { contractPath, server, environment } = fixtureValue;
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const unauthorized = await fetch(
        `${server.url}/v1/campaigns/${published.campaignId}/abandon`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(unauthorized.status).toBe(403);
      environment.USINE_CAMPAIGN_ABANDONMENT_SOURCE = "user:campaign-366";
      const response = await fetch(`${server.url}/v1/campaigns/${published.campaignId}/abandon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "abandoned",
      });
      await handoffCampaign(server.url, published.campaignId);
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "abandoned",
      });
    } finally {
      await server.close();
    }
  });

  test("does not infer an Outcome dependency from a Ready proposal", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("outcome-one-proposal", "outcome-one"),
      );
      const result = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("outcome-two-proposal", "outcome-two"),
      );
      expect(result.proposals).toMatchObject([
        { proposalId: "outcome-one-proposal", status: "ready" },
        {
          proposalId: "outcome-two-proposal",
          status: "planned",
          blocker: "outcome dependency has no accepted delivery",
          ready: null,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("keeps an Outcome-dependent proposal planned when its dependency has no proposal", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const result = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("missing-outcome-predecessor", "outcome-two"),
      );
      expect(result.proposals).toMatchObject([
        {
          proposalId: "missing-outcome-predecessor",
          status: "planned",
          blocker: "outcome dependency has no admitted proposal",
          ready: null,
        },
      ]);
      await expect(serverSnapshot(server.url)).resolves.toMatchObject({ tasks: [] });
    } finally {
      await server.close();
    }
  });

  test("keeps proposals outside the Goal envelope non-executable", async () => {
    const { contractPath, server } = await frontierFixture();
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const proposals = [
        [
          "wrong-repository",
          {
            ...frontierProposal("wrong-repository", "outcome-one"),
            repositoryId: "other-repository",
          },
        ],
        [
          "wrong-effect",
          { ...frontierProposal("wrong-effect", "outcome-one"), effects: ["shell"] },
        ],
        [
          "wrong-budget",
          {
            ...frontierProposal("wrong-budget", "outcome-one"),
            budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_001 },
          },
        ],
        ["wrong-merge", { ...frontierProposal("wrong-merge", "outcome-one"), merge: true }],
      ] as const;
      const blockers = [
        "proposal repository is outside the Goal authority envelope",
        "proposal effect is outside the Goal authority envelope",
        "proposal budget is outside the Goal budget envelope",
        "proposal merge authority is outside the Goal authority envelope",
      ];
      for (const [index, [proposalId, proposal]] of proposals.entries()) {
        const result = await proposeCampaign(server.url, published.campaignId, proposal);
        expect(result.proposals?.at(-1)).toMatchObject({
          proposalId,
          status: "blocked",
          blocker: blockers[index],
          ready: null,
        });
      }
    } finally {
      await server.close();
    }
  });

  test("treats omitted authority allowlists as empty and requires a registered head", async () => {
    const noAllowlist = {
      ...frontierGoal("campaign-repository"),
      id: "campaign-366-no-allowlist",
      authority: {
        source: "user:campaign-366",
        publish: true,
        delivery: true,
        merge: false,
      },
    };
    const omitted = await frontierFixture(noAllowlist);
    try {
      const published = await publishCampaign(omitted.server.url, {
        contractPath: omitted.contractPath,
      });
      const result = await proposeCampaign(
        omitted.server.url,
        published.campaignId,
        frontierProposal("omitted-allowlist", "outcome-one"),
      );
      expect(result.proposals).toMatchObject([
        {
          status: "blocked",
          blocker: "proposal repository is outside the Goal authority envelope",
          ready: null,
        },
      ]);
    } finally {
      await omitted.server.close();
    }

    const unregisteredContract = {
      ...frontierGoal("unregistered-repository"),
      id: "campaign-366-unregistered",
    };
    const unregistered = await frontierFixture(unregisteredContract);
    try {
      const published = await publishCampaign(unregistered.server.url, {
        contractPath: unregistered.contractPath,
      });
      const result = await proposeCampaign(unregistered.server.url, published.campaignId, {
        ...frontierProposal("unregistered", "outcome-one"),
        repositoryId: "unregistered-repository",
      });
      expect(result.proposals).toMatchObject([
        {
          status: "blocked",
          blocker: "proposal repository is not registered",
          ready: null,
        },
      ]);
    } finally {
      await unregistered.server.close();
    }
  });

  test("keeps proposals for superseded Outcomes non-executable", async () => {
    const contract = frontierGoal("campaign-repository");
    const superseded = {
      ...contract,
      id: "campaign-366-superseded",
      outcomes: contract.outcomes.map((outcome, index) =>
        index === 0 ? { ...outcome, status: "superseded" as const } : outcome,
      ),
    };
    const { contractPath, server } = await frontierFixture(superseded);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const result = await proposeCampaign(
        server.url,
        published.campaignId,
        frontierProposal("superseded-outcome", "outcome-one"),
      );
      expect(result.outcomes.find((outcome) => outcome.id === "outcome-one")).toMatchObject({
        status: "superseded",
      });
      expect(result.proposals).toMatchObject([
        {
          status: "blocked",
          blocker: "proposal outcome is not live",
          ready: null,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("blocks an all-superseded handed-off Campaign with a stable decision request", async () => {
    const contract = frontierGoal("campaign-repository");
    const superseded = {
      ...contract,
      id: "campaign-366-all-superseded",
      outcomes: contract.outcomes.map((outcome) => ({ ...outcome, status: "superseded" as const })),
    };
    const { contractPath, server } = await frontierFixture(superseded);
    try {
      const published = await publishCampaign(server.url, { contractPath });
      const handedOff = await handoffCampaign(server.url, published.campaignId);
      expect(handedOff).toMatchObject({
        status: "blocked",
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "plan_exhausted",
          outcomeIds: [],
        },
      });
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        decisionRequest: handedOff.decisionRequest,
      });
    } finally {
      await server.close();
    }
  });

  test("keeps a Ready proposal's exact base across a newer Goal version", async () => {
    const { root, contractPath, server } = await frontierFixture();
    try {
      const first = await publishCampaign(server.url, { contractPath });
      const oldProjection = await proposeCampaign(
        server.url,
        first.campaignId,
        frontierProposal("old-proposal", "outcome-one"),
      );
      const oldReady = oldProjection.proposals?.[0]?.ready;
      expect(oldReady).not.toBeNull();
      const newerPath = join(root, "goal-v2.json");
      await writeFile(
        newerPath,
        JSON.stringify({ ...frontierGoal("campaign-repository"), version: 2 }),
      );
      await execa("git", ["add", "goal-v2.json"], { cwd: root });
      await execa("git", ["commit", "-m", "publish newer Goal version"], { cwd: root });
      await publishCampaign(server.url, { contractPath: newerPath });
      await expect(getCampaign(server.url, first.campaignId)).resolves.toMatchObject({
        proposals: [
          {
            proposalId: "old-proposal",
            status: "blocked",
            blocker: "goal publication is superseded",
            ready: {
              baseSha: oldReady?.baseSha,
              repositoryRevision: oldReady?.repositoryRevision,
            },
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  test("records newer Goal supersession as monotonic Campaign progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-campaign-supersession-"));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory);
    const environment = { USINE_GOAL_PUBLICATION_SOURCE: "user:campaign-366" };
    const first = await publishCampaignToState(
      stateDirectory,
      JSON.stringify(frontierGoal("campaign-repository")),
      environment,
    );
    const before = await lookupCampaignEvidence(stateDirectory, first.campaignId);
    if (!before) throw new Error("initial Campaign evidence is missing");
    const durableTime = before.progress.occurredAtEpochMs + 60_000;
    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    try {
      database
        .prepare("UPDATE campaigns SET updated_at = ? WHERE campaign_id = ?")
        .run(durableTime, first.campaignId);
    } finally {
      database.close();
    }

    await publishCampaignToState(
      stateDirectory,
      JSON.stringify({ ...frontierGoal("campaign-repository"), version: 2 }),
      environment,
    );

    const after = await lookupCampaignEvidence(stateDirectory, first.campaignId);
    expect(after?.progress).toEqual({
      revision: before.progress.revision + 1,
      occurredAtEpochMs: durableTime + 1,
    });
    expect(after?.progress.revision).toBeGreaterThan(before.progress.revision);
    expect(after?.progress.occurredAtEpochMs).toBeGreaterThan(before.progress.occurredAtEpochMs);

    const campaign = await lookupCampaign(stateDirectory, first.campaignId);
    const beforeEvent = campaignEvidenceToPostHogEvents(campaign!, before, "deployment-test").find(
      (event) => event.event === "usine_campaign_progress",
    );
    const afterEvent = campaignEvidenceToPostHogEvents(campaign!, after!, "deployment-test").find(
      (event) => event.event === "usine_campaign_progress",
    );
    expect(afterEvent?.uuid).not.toBe(beforeEvent?.uuid);
    expect(afterEvent?.timestamp).toBe(new Date(durableTime + 1).toISOString());
    expect(Date.parse(afterEvent?.timestamp ?? "")).toBeGreaterThan(
      Date.parse(beforeEvent?.timestamp ?? ""),
    );

    await publishCampaignToState(
      stateDirectory,
      JSON.stringify({ ...frontierGoal("campaign-repository"), version: 2 }),
      environment,
    );
    await expect(lookupCampaignEvidence(stateDirectory, first.campaignId)).resolves.toMatchObject({
      progress: after?.progress,
    });
  });
});
