import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import { getCampaign, publishCampaign } from "../apps/cli/src/server-client.js";

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
