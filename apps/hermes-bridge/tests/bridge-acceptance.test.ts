import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHermesBridge } from "../src/index.js";
import { startUsineServer } from "@usine/runtime";
import type { ApiTaskResource } from "@usine/runtime";
import type { RepositorySnapshot, TaskContract } from "@usine/task-authority";
import { describe, expect, test } from "vite-plus/test";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for acceptance state");
}

function toolValue<T>(result: unknown): T {
  if (typeof result !== "object" || result === null || !("content" in result))
    throw new Error("MCP tool returned an invalid result");
  if ("isError" in result && result.isError === true) throw new Error("MCP tool call failed");
  if (!Array.isArray(result.content)) throw new Error("MCP tool returned no content");
  const content = result.content[0];
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  )
    throw new Error("MCP tool returned no JSON text");
  return JSON.parse(content.text) as T;
}

interface HermesWebhookRequest {
  readonly headers: Headers;
  readonly body: string;
}

interface HermesWebhookFixture {
  readonly url: string;
  readonly requests: HermesWebhookRequest[];
  readonly reconciled: Promise<HermesWebhookRequest>;
  readonly releaseAttention: () => void;
  readonly attentionCompleted: () => boolean;
  close(): Promise<void>;
}

async function startHermesWebhookFixture(): Promise<HermesWebhookFixture> {
  const requests: HermesWebhookRequest[] = [];
  const reconciled = deferred<HermesWebhookRequest>();
  const release = deferred<void>();
  let attentionStarted = false;
  let attentionResponseCompleted = false;

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readHttpBody(request);
    const recorded = { headers: new Headers(request.headers as Record<string, string>), body };
    requests.push(recorded);
    const payload = JSON.parse(body) as { event?: string };
    if (payload.event === "usine_instance_reconciled") reconciled.resolve(recorded);
    if (payload.event === "usine_attention" && !attentionStarted) {
      attentionStarted = true;
      await release.promise;
    }
    attentionResponseCompleted = payload.event === "usine_attention" || attentionResponseCompleted;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hermes fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    requests,
    reconciled: reconciled.promise,
    releaseAttention: () => release.resolve(),
    attentionCompleted: () => attentionResponseCompleted,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function waitForWebhookAttention(
  fixture: HermesWebhookFixture,
  state?: string,
): Promise<HermesWebhookRequest> {
  const request = await waitFor(
    async () => {
      const recordedRequest = fixture.requests.find((candidate) => {
        const payload = JSON.parse(candidate.body) as { event?: string; state?: string };
        return (
          payload.event === "usine_attention" && (state === undefined || payload.state === state)
        );
      });
      return recordedRequest;
    },
    (recordedRequest) => recordedRequest !== undefined,
  );
  if (!request) throw new Error("Hermes attention request was not recorded");
  return request;
}

async function waitForWebhookReconciliation(
  fixture: HermesWebhookFixture,
  occurrence: number,
): Promise<HermesWebhookRequest> {
  const request = await waitFor(
    async () => {
      const reconciliations = fixture.requests.filter((candidate) => {
        const payload = JSON.parse(candidate.body) as { event?: string };
        return payload.event === "usine_instance_reconciled";
      });
      return reconciliations[occurrence - 1];
    },
    (recordedRequest) => recordedRequest !== undefined,
  );
  if (!request) throw new Error("Hermes reconciliation request was not recorded");
  return request;
}

function expectSignedWebhook(request: HermesWebhookRequest, secret: string): void {
  const timestamp = request.headers.get("X-Webhook-Timestamp");
  expect(timestamp).toMatch(/^1700000000$/);
  expect(request.headers.get("X-Webhook-Signature-V2")).toBe(
    createHmac("sha256", secret).update(`${timestamp}.${request.body}`).digest("hex"),
  );
  expect(request.headers.get("X-Request-ID")).toMatch(/^usine-[0-9a-f]{32}$/);
}

async function readHttpBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("Hermes supervisor bridge acceptance", () => {
  test("supervises a real Usine server through Streamable HTTP MCP and a signed Hermes webhook", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-hermes-acceptance-"));
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state");
    await mkdir(repository);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execa("git", ["config", "user.name", "Test"], { cwd: repository });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "Hermes acceptance\n");
    await execa("git", ["add", "."], { cwd: repository });
    await execa("git", ["commit", "-m", "base"], { cwd: repository });

    const taskId = "hermes-bridge-acceptance-269";
    const baseSha = await git(repository, "rev-parse", "HEAD");
    const contractPath = join(repository, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise the existing Usine APIs through the external bridge.",
      acceptance: ["The bridge can inspect and explicitly retry the Task."],
      nonGoals: [],
      budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: "https://github.com/example/hermes-bridge-acceptance-269/issues/269",
        delivery: true,
      },
      delivery: {
        branch: "agent/hermes-bridge-acceptance-269",
        issue: 269,
        title: "Hermes bridge acceptance",
        body: "Hermes bridge acceptance",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract));
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

    const environment: NodeJS.ProcessEnv = {
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
      USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
      USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:1",
      USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
    };
    let activations = 0;
    const server = await startUsineServer({
      environment,
      execute: async ({ authority, contract: admittedContract, result }) => {
        const reservation = await authority.reserveActivation(
          result.taskId,
          admittedContract.budget.maxImplementerActivations,
        );
        activations = reservation.activation;
        if (reservation.activation === 1) {
          return authority.recordWaiting(
            { taskId: result.taskId, revision: reservation.result.revision },
            {
              reason: "network_interruption",
              resumeState: "admitted",
              activation: reservation.activation,
            },
          );
        }
        return authority.block(
          { taskId: result.taskId, revision: reservation.result.revision },
          "fake downstream completed",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    const repositorySnapshot: RepositorySnapshot = {
      id: taskId,
      path: await realpath(repository),
      owner: "example",
      name: taskId,
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    };
    const webhook = await startHermesWebhookFixture();
    const bridge = await startHermesBridge({
      usineUrl: server.url,
      sourceId: "test-instance-269",
      webhookUrl: webhook.url,
      webhookSecret: "test-webhook-secret",
      now: () => 1_700_000_000_000,
      mcpHost: "127.0.0.1",
      mcpPort: 0,
    });
    const client = new Client({ name: "standard-mcp-client", version: "1.0.0" });
    try {
      const registration = await fetch(new URL("/v1/repositories", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(repositorySnapshot),
      });
      expect(registration.ok).toBe(true);
      const transport = new StreamableHTTPClientTransport(new URL(bridge.mcp.url));
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "usine_server_snapshot",
        "usine_task_list",
        "usine_task_get",
        "usine_task_history",
        "usine_task_submit",
        "usine_task_retry",
      ]);
      const initial = await webhook.reconciled;
      expect(JSON.parse(initial.body)).toEqual({
        event: "usine_instance_reconciled",
        sourceId: "test-instance-269",
      });
      expectSignedWebhook(initial, "test-webhook-secret");

      expect(
        toolValue(await client.callTool({ name: "usine_server_snapshot", arguments: {} })),
      ).toMatchObject({
        server: { status: "ok" },
      });
      const submitted = toolValue<ApiTaskResource>(
        await client.callTool({
          name: "usine_task_submit",
          arguments: { contractPath, repositoryId: taskId },
        }),
      );
      expect(submitted).toMatchObject({ taskId, state: "admitted" });

      await waitFor(
        async () =>
          toolValue<ApiTaskResource>(
            await client.callTool({ name: "usine_task_get", arguments: { taskId } }),
          ),
        (resource) => resource.state === "waiting" && resource.retryable === true,
      );
      const listed = toolValue<{ tasks: ApiTaskResource[] }>(
        await client.callTool({ name: "usine_task_list", arguments: {} }),
      );
      expect(listed.tasks).toContainEqual(expect.objectContaining({ taskId, state: "waiting" }));
      const history = toolValue<{ taskId: string; events: Array<{ data: { type: string } }> }>(
        await client.callTool({ name: "usine_task_history", arguments: { taskId } }),
      );
      expect(history.taskId).toBe(taskId);
      expect(history.events.some((historyEvent) => historyEvent.data.type === "task_waiting")).toBe(
        true,
      );

      const attention = await waitForWebhookAttention(webhook);
      const attentionPayload = JSON.parse(attention.body) as Record<string, unknown>;
      expect(attentionPayload).toMatchObject({
        event: "usine_attention",
        sourceId: "test-instance-269",
        taskId,
        state: "waiting",
      });
      expectSignedWebhook(attention, "test-webhook-secret");

      const retried = toolValue<ApiTaskResource>(
        await client.callTool({ name: "usine_task_retry", arguments: { taskId } }),
      );
      expect(retried).toMatchObject({ taskId, state: "admitted" });
      const blocked = await waitFor(
        async () =>
          toolValue<ApiTaskResource>(
            await client.callTool({ name: "usine_task_get", arguments: { taskId } }),
          ),
        (resource) => resource.state === "blocked",
      );
      expect(blocked).toMatchObject({ state: "blocked", evidence: { implementerActivations: 2 } });
      expect(activations).toBe(2);
      expect(webhook.attentionCompleted()).toBe(false);

      webhook.releaseAttention();
      const reconciliation = await waitForWebhookReconciliation(webhook, 2);
      expect(JSON.parse(reconciliation.body)).toEqual({
        event: "usine_instance_reconciled",
        sourceId: "test-instance-269",
      });
      expectSignedWebhook(reconciliation, "test-webhook-secret");
      expect(
        webhook.requests.some((request) => {
          const payload = JSON.parse(request.body) as { event?: string; state?: string };
          return payload.event === "usine_attention" && payload.state === "blocked";
        }),
      ).toBe(false);
      expect(
        (await client.callTool({ name: "usine_task_retry", arguments: { taskId } })).isError,
      ).toBe(true);

      const replacement = new Client({ name: "replacement-mcp-client", version: "1.0.0" });
      const simultaneousA = new Client({ name: "simultaneous-a", version: "1.0.0" });
      const simultaneousB = new Client({ name: "simultaneous-b", version: "1.0.0" });
      const finalClient = new Client({ name: "final-mcp-client", version: "1.0.0" });
      try {
        await replacement.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url)));
        await expect(
          client.callTool({ name: "usine_task_get", arguments: { taskId } }),
        ).rejects.toThrow();
        expect(
          (
            await replacement.callTool({
              name: "usine_task_get",
              arguments: { taskId },
            })
          ).isError,
        ).not.toBe(true);
        const simultaneousResults = await Promise.allSettled([
          simultaneousA.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url))),
          simultaneousB.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url))),
        ]);
        const simultaneousClients = [simultaneousA, simultaneousB];
        const usableSimultaneousClients: Client[] = [];
        for (const [index, candidate] of simultaneousClients.entries()) {
          if (simultaneousResults[index]?.status !== "fulfilled") continue;
          try {
            const result = await candidate.callTool({
              name: "usine_task_get",
              arguments: { taskId },
            });
            if (result.isError !== true) usableSimultaneousClients.push(candidate);
          } catch {
            // A fulfilled initialize can already have been replaced by the other client.
          }
        }
        expect(usableSimultaneousClients).toHaveLength(1);
        const simultaneousWinner = usableSimultaneousClients[0];
        if (!simultaneousWinner) throw new Error("one simultaneous MCP session must be usable");
        await finalClient.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url)));
        await expect(
          simultaneousWinner.callTool({ name: "usine_task_get", arguments: { taskId } }),
        ).rejects.toThrow();
        expect(
          (
            await finalClient.callTool({
              name: "usine_task_get",
              arguments: { taskId },
            })
          ).isError,
        ).not.toBe(true);
      } finally {
        await Promise.all(
          [replacement, simultaneousA, simultaneousB, finalClient].map((candidate) =>
            candidate.close().catch(() => undefined),
          ),
        );
      }
    } finally {
      webhook.releaseAttention();
      await client.close().catch(() => undefined);
      await bridge.close();
      await webhook.close();
      await server.close();
    }
  }, 30_000);
});
