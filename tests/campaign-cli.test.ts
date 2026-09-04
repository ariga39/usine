import { createServer } from "node:http";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { join } from "node:path";

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
  revision: 1,
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
