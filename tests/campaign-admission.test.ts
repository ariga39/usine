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
  if (publicationSource !== null) environment.USINE_GOAL_PUBLICATION_SOURCE = publicationSource;
  const server = await startUsineServer({
    environment,
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
