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

const eventFor = (
  taskId: string,
  type: ApiEventEnvelope["event"]["data"]["type"],
  sequence = 9,
): ApiEventEnvelope => ({
  taskId,
  repositoryId: "repository-269",
  event: {
    taskId,
    sequence,
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

const event = (type: ApiEventEnvelope["event"]["data"]["type"]): ApiEventEnvelope =>
  eventFor("task-269", type);

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

async function settleWebhookDelivery(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Hermes supervisor bridge attention", () => {
  test("emits exactly one initial reconciliation signal after a successful startup read", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: listedUpstream([task("blocked")]),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.reconcile("startup");
    await settleWebhookDelivery();
    await bridge.reconcile("startup");

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toEqual({
      event: "usine_instance_reconciled",
      sourceId: "usine-instance-269",
    });
  });

  test("does not classify a startup webhook failure as a Usine outage", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: listedUpstream([task("blocked")]),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      maxWebhookAttempts: 1,
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("bad", { status: 400 });
      },
      now: () => 1_000,
    });

    await expect(bridge.reconcile("startup")).resolves.toBeUndefined();
    await settleWebhookDelivery();
    await bridge.notifyReconnected();

    expect(
      requests.every((request) => JSON.parse(request.body).event !== "usine_instance_unavailable"),
    ).toBe(true);
  });

  test("does not block event reconciliation or announce outage on webhook failure", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      maxWebhookAttempts: 1,
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("busy", { status: 503 });
      },
      now: () => 1_000,
    });

    await expect(bridge.handleEvent(event("coding_tool_completed"))).resolves.toBeUndefined();
    await settleWebhookDelivery();

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body).event).toBe("usine_attention");
    await bridge.notifyReconnected();
    expect(requests).toHaveLength(1);
  });

  test("wakes current retryable waiting Tasks on startup and baselines existing terminals", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: listedUpstream([
        task("waiting", true, "task-waiting"),
        task("blocked", false, "task-terminal"),
      ]),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.reconcile("startup");
    await settleWebhookDelivery();

    expect(requests).toHaveLength(2);
    const attention = requests.find(
      (request) => JSON.parse(request.body).event === "usine_attention",
    );
    expect(attention).toBeDefined();
    expect(JSON.parse(attention?.body ?? "")).toMatchObject({
      event: "usine_attention",
      sourceId: "usine-instance-269",
      taskId: "task-waiting",
      state: "waiting",
    });
    expect(
      requests.filter((request) => JSON.parse(request.body).event === "usine_instance_reconciled"),
    ).toHaveLength(1);
  });

  test("re-reads the TaskResource and ignores a coding-tool invalidation while non-actionable", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("admitted")),
      sourceId: "usine-instance-269",
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
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(event("task_waiting"));
    await settleWebhookDelivery();

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
      sourceId: "usine-instance-269",
      taskId: "task-269",
      repositoryId: "repository-269",
      revision: 4,
      eventSequence: 9,
      state: "waiting",
    });
  });

  test("anchors a changed Task revision and event sequence to a new delivery identity", async () => {
    const requests: RecordedRequest[] = [];
    let current = task("blocked");
    const source = upstream(current);
    source.getTask = async () => current;
    const bridge = createHermesBridge({
      upstream: source,
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(eventFor("task-269", "coding_tool_completed", 9));
    await settleWebhookDelivery();
    current = { ...current, revision: 5 };
    await bridge.handleEvent(eventFor("task-269", "coding_tool_completed", 10));
    await settleWebhookDelivery();

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].body)).toMatchObject({
      sourceId: "usine-instance-269",
      revision: 5,
      eventSequence: 10,
      state: "blocked",
    });
    expect(requests[0]?.headers.get("X-Request-ID")).not.toBe(
      requests[1]?.headers.get("X-Request-ID"),
    );
  });

  test("wakes a terminal Task once after an intermediate event is re-read", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      sourceId: "usine-instance-269",
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
    await settleWebhookDelivery();

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({
      event: "usine_attention",
      sourceId: "usine-instance-269",
      state: "blocked",
    });
  });

  test("retries with one request identity and coalesces duplicate terminal observations", async () => {
    const requests: RecordedRequest[] = [];
    let attempts = 0;
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      sourceId: "usine-instance-269",
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
    await settleWebhookDelivery();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("X-Request-ID")).toBe(requests[1]?.headers.get("X-Request-ID"));
  });

  test("refreshes the timestamp and signature while keeping the body and request identity on retry", async () => {
    const requests: RecordedRequest[] = [];
    let attempts = 0;
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      maxWebhookAttempts: 2,
      sleep: async () => undefined,
      fetch: async (_input, init) => {
        attempts += 1;
        requests.push(recordRequest(init));
        return new Response(attempts === 1 ? "busy" : null, {
          status: attempts === 1 ? 503 : 204,
        });
      },
      now: (() => {
        let timestamp = 1_000_000;
        return () => (timestamp += 1_000);
      })(),
    });

    await bridge.handleEvent(event("coding_tool_completed"));
    await settleWebhookDelivery();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests[0]?.headers.get("X-Request-ID")).toBe(requests[1]?.headers.get("X-Request-ID"));
    expect(requests[0]?.headers.get("X-Webhook-Timestamp")).not.toBe(
      requests[1]?.headers.get("X-Webhook-Timestamp"),
    );
    expect(requests[1]?.headers.get("X-Webhook-Signature-V2")).toBe(
      createHmac("sha256", "test-secret")
        .update(`${requests[1]?.headers.get("X-Webhook-Timestamp")}.${requests[1]?.body}`)
        .digest("hex"),
    );
  });

  test("stops a pending retry when the bridge closes", async () => {
    const requests: RecordedRequest[] = [];
    let releaseSleep!: () => void;
    let signalSleep!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      signalSleep = resolve;
    });
    const bridge = createHermesBridge({
      upstream: upstream(task("blocked")),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      maxWebhookAttempts: 2,
      sleep: async () => {
        signalSleep();
        await new Promise<void>((resolve) => {
          releaseSleep = resolve;
        });
      },
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("busy", { status: 503 });
      },
      now: () => 1_000,
    });

    await bridge.handleEvent(event("coding_tool_completed"));
    await settleWebhookDelivery();
    await sleepStarted;
    const firstClose = bridge.close();
    releaseSleep();
    await firstClose;
    await expect(bridge.close()).resolves.toBeUndefined();

    expect(requests).toHaveLength(1);
  });

  test("close resolves and drops a queued reconciliation behind an active delivery", async () => {
    const requests: RecordedRequest[] = [];
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const bridge = createHermesBridge({
      upstream: listedUpstream([task("blocked"), task("blocked", false, "task-270")]),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        signalFirstStarted();
        const signal = init?.signal;
        if (!signal) throw new Error("expected an abort signal");
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          if (signal.aborted) reject(new Error("aborted"));
        });
        return new Response(null, { status: 204 });
      },
      now: () => 1_000,
    });

    const first = bridge.handleEvent(eventFor("task-269", "coding_tool_completed", 9));
    await firstStarted;
    await bridge.handleEvent(eventFor("task-270", "coding_tool_completed", 10));

    await bridge.close();
    await first;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  test("coalesces changed signals behind one active delivery and does not retry a permanent client error", async () => {
    const requests: RecordedRequest[] = [];
    const statuses: number[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const bridge = createHermesBridge({
      upstream: listedUpstream([
        task("blocked"),
        task("blocked", false, "task-270"),
        task("blocked", false, "task-271"),
        task("blocked", false, "task-272"),
        task("blocked", false, "task-273"),
        task("blocked", false, "task-274"),
      ]),
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        requests.push(recordRequest(init));
        if (requests.length === 1) {
          signalFirstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          active -= 1;
          statuses.push(200);
          return new Response("ok", { status: 200 });
        }
        active -= 1;
        statuses.push(400);
        return new Response("bad", { status: 400 });
      },
      now: () => 1_000,
    });

    const first = bridge.handleEvent(eventFor("task-269", "coding_tool_completed", 9));
    await firstStarted;
    const second = bridge.handleEvent(eventFor("task-270", "coding_tool_completed", 10));
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    const later = [271, 272, 273, 274].map((taskId, index) =>
      bridge.handleEvent(eventFor(`task-${taskId}`, "coding_tool_completed", 11 + index)),
    );
    await Promise.all([second, ...later]);
    releaseFirst();
    const results = await Promise.allSettled([first, second, ...later]);
    await settleWebhookDelivery();

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(requests).toHaveLength(2);
    expect(statuses).toEqual([200, 400]);
    expect(maxActive).toBe(1);
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      event: "usine_instance_reconciled",
      sourceId: "usine-instance-269",
    });
  });

  test("reserves the first slot before the consumer starts and bounds a same-turn burst", async () => {
    const requests: RecordedRequest[] = [];
    const resources = [
      task("blocked"),
      task("blocked", false, "task-270"),
      task("blocked", false, "task-271"),
      task("blocked", false, "task-272"),
    ];
    const source = listedUpstream(resources);
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    source.getTask = async (taskId) => {
      await readsReleased;
      return resources.find((resource) => resource.taskId === taskId) ?? null;
    };
    const bridge = createHermesBridge({
      upstream: source,
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response(null, { status: 204 });
      },
      now: () => 1_000,
    });

    const deliveries = resources.map((resource, index) =>
      bridge.handleEvent(eventFor(resource.taskId, "coding_tool_completed", 20 + index)),
    );
    await Promise.resolve();
    releaseReads();
    await Promise.all(deliveries);
    for (let attempt = 0; attempt < 10 && requests.length < 2; attempt += 1) {
      await settleWebhookDelivery();
    }

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]?.body ?? "").event).toBe("usine_attention");
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      event: "usine_instance_reconciled",
      sourceId: "usine-instance-269",
    });
    await bridge.close();
  });

  test("emits one unavailable and one reconnected signal per observed outage", async () => {
    const requests: RecordedRequest[] = [];
    const bridge = createHermesBridge({
      upstream: upstream(task("admitted")),
      sourceId: "usine-instance-269",
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
    expect(JSON.parse(requests[0].body)).toEqual({
      event: "usine_instance_unavailable",
      sourceId: "usine-instance-269",
    });
    expect(JSON.parse(requests[1].body)).toEqual({
      event: "usine_instance_reconnected",
      sourceId: "usine-instance-269",
    });
  });

  test("reconciles a terminal found after reconnect without replaying an offline terminal wake", async () => {
    const requests: RecordedRequest[] = [];
    const resources = [task("admitted")];
    const bridge = createHermesBridge({
      upstream: listedUpstream(resources),
      sourceId: "usine-instance-269",
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
    expect(JSON.parse(requests[0].body)).toEqual({
      event: "usine_instance_unavailable",
      sourceId: "usine-instance-269",
    });
    expect(JSON.parse(requests[1].body)).toEqual({
      event: "usine_instance_reconnected",
      sourceId: "usine-instance-269",
    });
  });

  test("announces recovery only after a successful reconciliation read", async () => {
    const requests: RecordedRequest[] = [];
    const source = listedUpstream([task("admitted")]);
    const listTasks = source.listTasks.bind(source);
    let reachable = false;
    source.listTasks = async (limit) => {
      if (!reachable) throw new Error("Usine is unavailable");
      return listTasks(limit);
    };
    const bridge = createHermesBridge({
      upstream: source,
      sourceId: "usine-instance-269",
      webhookUrl: "<HERMES_WEBHOOK_URL>",
      webhookSecret: "test-secret",
      fetch: async (_input, init) => {
        requests.push(recordRequest(init));
        return new Response("ok", { status: 200 });
      },
      now: () => 1_000,
    });

    await bridge.notifyUnavailable();
    await bridge.notifyReconnected();
    expect(requests).toHaveLength(1);

    reachable = true;
    await bridge.notifyReconnected();

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1].body)).toEqual({
      event: "usine_instance_reconnected",
      sourceId: "usine-instance-269",
    });
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
