import { createHmac } from "node:crypto";
import { createHermesBridge, type HermesBridgeUpstream } from "../src/bridge.js";
import { createHermesBridgeMcpServer, startHermesBridgeMcpHttp } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiEventEnvelope, ApiTaskResource } from "@usine/runtime";
import { describe, expect, test } from "vite-plus/test";

interface RecordedRequest {
  headers: Headers;
  body: string;
}

function recordRequest(init: RequestInit | undefined): RecordedRequest {
  return {
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : "",
  };
}

const task = (
  state: ApiTaskResource["state"],
  retryable = false,
  taskId = "task-269",
): ApiTaskResource => ({
  schemaVersion: 3,
  taskId,
  contractHash: "a".repeat(64),
  revision: 4,
  deadlineEpochMs: 2_000,
  state,
  mergeAuthorized: false,
  candidateSha: null,
  candidateFence: null,
  check: null,
  review: null,
  delivery: null,
  blocker: null,
  waiting: state === "waiting" ? { reason: "network_interruption" } : null,
  retryable,
  activeActivation: null,
  writer: { repositoryIdentity: "example/repository" },
  repository: { id: "repository-269", owner: "example", name: "repository", baseBranch: "main" },
  evidence: {
    implementerActivations: 1,
    reviewCycles: 0,
    changesRequestedBatches: 0,
    restartRecoveries: 0,
  },
});

const event = (type: ApiEventEnvelope["event"]["data"]["type"]): ApiEventEnvelope => ({
  taskId: "task-269",
  repositoryId: "repository-269",
  event: {
    taskId: "task-269",
    sequence: 9,
    eventId: "event-269",
    occurredAtEpochMs: 1_000,
    data:
      type === "coding_tool_completed"
        ? {
            type,
            role: "implementer",
            activation: 1,
            tool: "read",
            outcome: "succeeded",
            sessionId: "session-269",
            outcomeId: "outcome-269",
          }
        : {
            type: "task_waiting",
            reason: "network_interruption",
            activation: 1,
          },
  },
});

function upstream(resource: ApiTaskResource): HermesBridgeUpstream {
  return {
    serverSnapshot: async () => ({
      schemaVersion: 1,
      revision: 1,
      server: { status: "ok", revision: 1 },
      repositories: [],
      tasks: [],
      codingSessions: [],
    }),
    listTasks: async () => ({ tasks: [] }),
    getTask: async () => resource,
    taskHistory: async () => ({ taskId: resource.taskId, events: [], nextSequence: 0 }),
    submitTask: async () => resource,
    retryTask: async () => resource,
    subscribe: async function* () {},
  };
}

function listedUpstream(resources: ApiTaskResource[]): HermesBridgeUpstream {
  const first = resources[0];
  if (!first) throw new Error("test requires one Task");
  const source = upstream(first);
  return {
    ...source,
    listTasks: async () => ({
      tasks: resources.map((resource) => ({
        taskId: resource.taskId,
        revision: resource.revision,
        deadlineEpochMs: resource.deadlineEpochMs,
        state: resource.state,
        candidateSha: resource.candidateSha,
        activeActivation: resource.activeActivation,
        retryable: resource.retryable ?? false,
        writer: resource.writer,
        evidence: resource.evidence,
      })),
    }),
    getTask: async (taskId) => resources.find((resource) => resource.taskId === taskId) ?? null,
  };
}

describe("Hermes supervisor bridge attention", () => {
  test("wakes current retryable waiting Tasks on startup and baselines existing terminals", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: listedUpstream([
        task("waiting", true, "task-waiting"),
        task("blocked", false, "task-terminal"),
      ]),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.reconcile("startup");

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({
      event: "usine_attention",
      taskId: "task-waiting",
      state: "waiting",
    });
  });

  test("re-reads the TaskResource and ignores a coding-tool invalidation while non-actionable", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("admitted")),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(event("coding_tool_completed"));

    expect(requests).toHaveLength(0);
  });

  test("sends one signed wake for a current retryable Task", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("waiting", true)),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(event("task_waiting"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("X-Webhook-Timestamp")).toBe("1");
    expect(requests[0]?.headers.get("X-Webhook-Signature-V2")).toMatch(/^[0-9a-f]{64}$/);
    expect(requests[0]?.headers.get("X-Request-ID")).toBeTruthy();
    const body = requests[0]?.body;
    expect(requests[0]?.headers.get("X-Webhook-Signature-V2")).toBe(
      createHmac("sha256", "test-secret").update(`1.${body}`).digest("hex"),
    );
    expect(JSON.parse(body ?? "")).toEqual({
      event: "usine_attention",
      taskId: "task-269",
      repositoryId: "repository-269",
      state: "waiting",
    });
  });

  test("wakes a terminal Task once after an intermediate event is re-read", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(event("coding_tool_completed"));
    await bridge.handleEvent(event("coding_tool_completed"));

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({
      event: "usine_attention",
      state: "blocked",
    });
  });

  test("retries with one request identity and coalesces duplicate terminal observations", async () => {
    const requests: RecordedRequest[] = [];
    let attempts = 0;
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      maxWebhookAttempts: 2,
      sleep: async () => undefined,
      fetch: async (_input, init) => {
        attempts += 1;
        requests.push(recordRequest(init));
        return new Response(attempts === 1 ? "" : null, { status: attempts === 1 ? 503 : 204 });
      },
      now: () => 1_000,
    });

    await Promise.all([
      bridge.handleEvent(event("coding_tool_completed")),
      bridge.handleEvent(event("coding_tool_completed")),
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("X-Request-ID")).toBe(requests[1]?.headers.get("X-Request-ID"));
  });

  test("emits one unavailable and one reconnected signal per observed outage", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("admitted")),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.notifyUnavailable();
    await bridge.notifyUnavailable();
    await bridge.notifyReconnected();
    await bridge.notifyReconnected();

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0].body)).toEqual({ event: "usine_instance_unavailable" });
    expect(JSON.parse(requests[1].body)).toEqual({ event: "usine_instance_reconnected" });
  });

  test("reconciles a terminal found after reconnect without replaying an offline terminal wake", async () => {
    const requests: RecordedRequest[] = [];
    const resources = [task("admitted")];
    const bridge = createHermesBridge({
      upstream: listedUpstream(resources),
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.notifyUnavailable();
    resources[0] = task("blocked");
    await bridge.notifyReconnected();

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0].body)).toEqual({ event: "usine_instance_unavailable" });
    expect(JSON.parse(requests[1].body)).toEqual({ event: "usine_instance_reconnected" });
  });

  test("exposes only bounded snapshot, Task inspection, submit, and retry MCP tools", async () => {
    const source = upstream(task("admitted"));
    let submitted: { contractPath: string; repositoryId?: string } | undefined;
    let retried: string | undefined;
    source.submitTask = async (input) => {
      submitted = input;
      return task("admitted");
    };
    source.retryTask = async (taskId) => {
      retried = taskId;
      return task("admitted");
    };
    const server = createHermesBridgeMcpServer(source);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "usine_server_snapshot",
        "usine_task_list",
        "usine_task_get",
        "usine_task_history",
        "usine_task_submit",
        "usine_task_retry",
      ]);
      expect(tools.tools.some((tool) => tool.name.includes("repository_register"))).toBe(false);
      const result = await client.callTool({
        name: "usine_task_get",
        arguments: { taskId: "task-269" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(task("admitted")) }]);
      await client.callTool({
        name: "usine_task_submit",
        arguments: { contractPath: "<COMMITTED_CONTRACT_PATH>", repositoryId: "repository-269" },
      });
      await client.callTool({ name: "usine_task_retry", arguments: { taskId: "task-269" } });
      expect(submitted).toEqual({
        contractPath: "<COMMITTED_CONTRACT_PATH>",
        repositoryId: "repository-269",
      });
      expect(retried).toBe("task-269");
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });

  test("rejects non-loopback MCP binding", async () => {
    await expect(
      startHermesBridgeMcpHttp({ upstream: upstream(task("admitted")), host: "0.0.0.0" }),
    ).rejects.toThrow("loopback");
  });
});
