import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { registerRepositoryResource, startUsineServer } from "@usine/runtime";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { executeDeliveryRun, type DeliveryRunServices } from "@usine/delivery-run";
import {
  openSqliteDatabase,
  resolveTaskContract,
  TaskAuthority,
  type TaskResult,
} from "@usine/task-authority";
import {
  campaignEvidence,
  getCampaign,
  handoffCampaign,
  proposeCampaign,
  publishCampaign,
  registerRepository,
  retryTask,
  serverSnapshot,
  taskEvidence,
  taskEvents,
  taskStatus,
} from "../apps/cli/src/server-client.js";

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
    budget: {
      maxElapsedMs: 60_000,
      maxTasks: 4,
      maxPlannerActivations: 1,
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
    budget: {
      maxElapsedMs: 60_000,
      maxTasks: 10,
      maxPlannerActivations: 1,
      maxImplementerActivations: 1,
      maxReviewCycles: 1,
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

function mergeFrontierGoal(repositoryId: string) {
  const contract = frontierGoal(repositoryId);
  return { ...contract, authority: { ...contract.authority, merge: true } };
}

function oneOutcomeFrontierGoal(repositoryId: string) {
  const contract = frontierGoal(repositoryId);
  return {
    ...contract,
    outcomes: [contract.outcomes[0]],
    budget: { ...contract.budget, maxImplementerActivations: 2 },
  };
}

async function frontierFixture(
  contract: unknown = frontierGoal("campaign-repository"),
  publicationSource: string | null = "user:campaign-366",
  execute?: Parameters<typeof startUsineServer>[0]["execute"],
  activeTaskCapacity = 1,
  register = true,
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
        status: 500,
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
        status: 500,
      });
    } finally {
      await restarted.close();
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

  test("exhausted fixed plans persist one stable decision request without closing", async () => {
    const fixtureValue = await frontierFixture(undefined, "user:campaign-366", async (context) =>
      acceptCampaignTask(context),
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
        reason: "plan_exhausted",
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
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
        status: "blocked",
        planHandedOff: true,
        decisionRequest: {
          requestId: `decision:${published.campaignId}`,
          reason: "plan_exhausted",
          outcomeIds: ["outcome-one", "outcome-two"],
        },
      });
    } finally {
      await server.close();
    }
  });

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
          reason: "branches_blocked",
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
        decisionRequest: { reason: "branches_blocked", outcomeIds: ["outcome-one", "outcome-two"] },
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
      await expect(getCampaign(server.url, published.campaignId)).resolves.toMatchObject({
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
        decisionRequest: { reason: "plan_exhausted" },
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
});
