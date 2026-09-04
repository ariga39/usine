import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import {
  getCampaign,
  proposeCampaign,
  publishCampaign,
  registerRepository,
  serverSnapshot,
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

function frontierProposal(proposalId: string, outcomeId: string, dependsOn: string[] = []) {
  return {
    proposalId,
    outcomeId,
    dependsOn,
    repositoryId: "campaign-repository",
    instructions: `Implement ${proposalId}.`,
    acceptance: [`${proposalId} is complete.`],
    nonGoals: [],
    effects: ["github"],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
    merge: false,
  };
}

async function frontierFixture(
  contract: unknown = frontierGoal("campaign-repository"),
  publicationSource: string | null = "user:campaign-366",
  execute?: Parameters<typeof startUsineServer>[0]["execute"],
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
  if (publicationSource !== null) environment.USINE_GOAL_PUBLICATION_SOURCE = publicationSource;
  const server = await startUsineServer({
    environment,
    execute,
    host: "127.0.0.1",
    port: 0,
  });
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
  return { root, stateDirectory, contractPath, server };
}

test("admits one Ready proposal through the Task leaf without a Task submission", async () => {
  let executions = 0;
  const { contractPath, server } = await frontierFixture(
    undefined,
    "user:campaign-366",
    async ({ authority, result }) => {
      executions += 1;
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
    const taskId = ready && "taskId" in ready ? ready.taskId : undefined;
    expect(taskId).toEqual("campaign-campaign-366-v1-automatic-admission");

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
    expect(first.proposals?.[0]?.ready?.taskId).toBe("campaign-campaign-366-v1-capacity-first");
    expect(second.proposals?.[1]?.ready?.taskId).toBeNull();
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
    const taskId = proposed.proposals?.[0]?.ready?.taskId;
    expect(taskId).toBe("campaign-campaign-366-v1-restartable");
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
