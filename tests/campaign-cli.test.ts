import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
const campaign = {
  schemaVersion: 1,
  campaignId: "campaign-365:v1",
  goalId: "campaign-365",
  goalVersion: 1,
  contractHash: "a".repeat(64),
  objective: "Deliver the authorized campaign",
  outcomes: [
    {
      id: "outcome-root",
      title: "Publish the root outcome",
      acceptance: ["The root outcome is represented by a durable Campaign."],
      dependsOn: [],
      parentId: null,
      status: "planned",
      evidence: null,
    },
  ],
  authority: {
    source: "user:issue-363",
    publish: true,
    delivery: true,
    merge: false,
  },
  budget: { maxElapsedMs: 60_000, maxTasks: 4, maxPlannerActivations: 1 },
  status: "planning",
  planHandedOff: false,
  decisionRequest: null,
  revision: 1,
} as const;

const frontierCampaign = {
  ...campaign,
  campaignId: "campaign-366:v1",
  goalId: "campaign-366",
  objective: "Deliver a bounded campaign frontier",
  outcomes: [
    {
      id: "outcome-one",
      title: "Complete the first outcome",
      acceptance: ["The first outcome has executable work."],
      dependsOn: [],
      parentId: null,
      status: "planned",
      evidence: null,
    },
    {
      id: "outcome-two",
      title: "Complete the dependent outcome",
      acceptance: ["The dependent outcome has executable work."],
      dependsOn: ["outcome-one"],
      parentId: null,
      status: "planned",
      evidence: null,
    },
  ],
  authority: {
    ...campaign.authority,
    repositories: ["campaign-repository"],
    effects: ["github"],
  },
  budget: {
    ...campaign.budget,
    maxImplementerActivations: 1,
    maxReviewCycles: 1,
  },
  proposals: [
    {
      proposalId: "proposal-one",
      outcomeId: "outcome-one",
      sequence: 1,
      status: "ready",
      blocker: null,
      ready: {
        repositoryId: "campaign-repository",
        baseSha: "a".repeat(40),
        repositoryRevision: 1,
        instructions: "Implement proposal-one.",
        acceptance: ["proposal-one is complete."],
        nonGoals: [],
        effects: ["github"],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
        merge: false,
      },
    },
    {
      proposalId: "proposal-two",
      outcomeId: "outcome-two",
      sequence: 2,
      status: "planned",
      blocker: "proposal dependency has no accepted delivery",
      ready: null,
    },
  ],
} as const;

async function serve(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Campaign CLI fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respondJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

test("built CLI publishes a Campaign as JSON", async () => {
  let receivedPublish = false;
  const server = await serve((request, response) => {
    if (request.method === "POST" && request.url === "/v1/campaigns") {
      receivedPublish = true;
      respondJson(response, 200, campaign);
      return;
    }
    respondJson(response, 404, { error: "not_found", message: "route not found" });
  });
  try {
    const run = await execa("node", [cliPath, "campaign", "publish", "goal.json", "--json"], {
      env: { USINE_SERVER_URL: server.url },
      reject: false,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual(campaign);
    expect(receivedPublish).toBe(true);
  } finally {
    await server.close();
  }
});

test("built CLI reports a missing Campaign with the not-found diagnostic", async () => {
  const server = await serve((_request, response) => {
    respondJson(response, 404, { error: "not_found", message: "campaign not found" });
  });
  try {
    const run = await execa("node", [cliPath, "campaign", "get", "missing:v1", "--json"], {
      env: { USINE_SERVER_URL: server.url },
      reject: false,
    });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toEqual({
      error: "campaign_not_found",
      campaignId: "missing:v1",
    });
  } finally {
    await server.close();
  }
});

test("built CLI exposes the durable Ready frontier through propose and get", async () => {
  let receivedProposal = false;
  let receivedGet = false;
  const server = await serve((request, response) => {
    const requestUrl = decodeURIComponent(request.url ?? "");
    if (request.method === "POST" && requestUrl === "/v1/campaigns/campaign-366:v1/proposals") {
      receivedProposal = true;
      respondJson(response, 200, frontierCampaign);
      return;
    }
    if (request.method === "GET" && requestUrl === "/v1/campaigns/campaign-366:v1") {
      receivedGet = true;
      respondJson(response, 200, frontierCampaign);
      return;
    }
    respondJson(response, 404, { error: "not_found", message: "route not found" });
  });
  const proposalPath = join(await mkdtemp(join(tmpdir(), "usine-campaign-cli-")), "proposal.json");
  await writeFile(proposalPath, JSON.stringify({ proposalId: "proposal-one" }));
  try {
    const propose = await execa(
      "node",
      [cliPath, "campaign", "propose", "campaign-366:v1", proposalPath, "--json"],
      { env: { USINE_SERVER_URL: server.url }, reject: false },
    );
    expect(propose.exitCode, propose.stderr).toBe(0);
    expect(
      JSON.parse(propose.stdout).proposals.map((proposal: { status: string }) => proposal.status),
    ).toEqual(["ready", "planned"]);
    expect(receivedProposal).toBe(true);

    const get = await execa("node", [cliPath, "campaign", "get", "campaign-366:v1", "--json"], {
      env: { USINE_SERVER_URL: server.url },
      reject: false,
    });
    expect(get.exitCode).toBe(0);
    expect(
      JSON.parse(get.stdout).proposals.map((proposal: { status: string }) => proposal.status),
    ).toEqual(["ready", "planned"]);
    expect(receivedGet).toBe(true);
  } finally {
    await server.close();
  }
});

test("built CLI preserves Campaign content conflicts", async () => {
  const server = await serve((_request, response) => {
    respondJson(response, 409, {
      code: "campaign_content_conflict",
      message: "goal publication identity is already bound to different content",
      retryable: false,
    });
  });
  try {
    const run = await execa("node", [cliPath, "campaign", "publish", "goal.json", "--json"], {
      env: { USINE_SERVER_URL: server.url },
      reject: false,
    });
    expect(run.exitCode).toBe(6);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: "campaign_content_conflict",
      kind: "server",
    });
  } finally {
    await server.close();
  }
});
