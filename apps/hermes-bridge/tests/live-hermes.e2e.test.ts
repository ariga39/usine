import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type ResultPromise } from "execa";
import { startUsineServer } from "@usine/runtime";
import type { ApiTaskResource } from "@usine/runtime";
import type { RepositorySnapshot, TaskContract } from "@usine/task-authority";
import { describe, expect, test } from "vite-plus/test";

const live = process.env.USINE_HERMES_LIVE_E2E === "1";
const bridgeDirectory = dirname(fileURLToPath(import.meta.url));

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("port reservation failed");
  return address.port;
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status >= 200 && response.status < 600) return;
    } catch {
      // The owned child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("owned Hermes child did not become ready");
}

async function waitForHermesHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) {
        const body = (await response.json()) as { status?: unknown; platform?: unknown };
        if (body.status === "ok" && body.platform === "webhook") return;
      }
    } catch {
      // The owned Hermes child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("owned Hermes webhook health endpoint did not become ready");
}

async function waitForTask(
  serverUrl: string,
  taskId: string,
  predicate: (task: ApiTaskResource) => boolean,
): Promise<ApiTaskResource> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${serverUrl}/v1/tasks/${encodeURIComponent(taskId)}`);
    if (response.ok) {
      const task = (await response.json()) as ApiTaskResource;
      if (predicate(task)) return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for authoritative Task state");
}

interface LocalModelToolNames {
  readonly snapshot?: string;
  readonly list?: string;
  readonly get?: string;
  readonly history?: string;
  readonly submit?: string;
  readonly retry?: string;
}

interface ResolvedLocalModelTools {
  readonly names: LocalModelToolNames;
  readonly searchWrapper?: string;
  readonly describeWrapper?: string;
  readonly callWrapper?: string;
  readonly matchedCount: number;
  readonly distinctNameCount: number;
  readonly distinctSuffixCount: number;
}

interface LocalModelFixture {
  readonly url: string;
  readonly toolNames: LocalModelToolNames;
  readonly requestCount: number;
  readonly streamRequested: boolean;
  readonly resolvedBridgeToolCount: number;
  readonly toolCallOrder: readonly string[];
  readonly protocolError: string | undefined;
  close(): Promise<void>;
}

async function startLocalOpenAiModel(port: number, taskId: string): Promise<LocalModelFixture> {
  let toolNames: LocalModelToolNames = {};
  let requestCount = 0;
  let streamRequested = false;
  let resolvedBridgeToolCount = 0;
  let toolCallOrder: readonly string[] = [];
  let protocolError: string | undefined;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      requestCount += 1;
      const body = await readJsonBody(request);
      streamRequested = streamRequested || body.stream === true;
      const advertised = Array.isArray(body.tools) ? body.tools : [];
      const resolution = resolveToolNames(advertised);
      if (resolution.matchedCount === 0) {
        writeModelCompletion(response, body, "Acknowledged.");
        return;
      }
      resolvedBridgeToolCount = resolution.distinctSuffixCount;
      if (
        resolution.matchedCount !== 6 ||
        resolution.distinctNameCount !== 6 ||
        resolution.distinctSuffixCount !== 6 ||
        resolution.searchWrapper === undefined ||
        resolution.describeWrapper === undefined ||
        resolution.callWrapper === undefined
      ) {
        protocolError = "invalid_request";
        writeJson(response, 400, { error: { message: "invalid bridge tool surface" } });
        return;
      }
      const nextToolNames = resolution.names;
      toolNames = nextToolNames;
      const invoked = invokedToolNames(body.messages, resolution.callWrapper);
      if (invoked === undefined) {
        protocolError = "invalid_request";
        writeJson(response, 400, { error: { message: "invalid model request" } });
        return;
      }
      const expected = [toolNames.get, toolNames.history, toolNames.retry];
      const labels = new Map([
        [toolNames.get, "get"],
        [toolNames.history, "history"],
        [toolNames.retry, "retry"],
      ]);
      toolCallOrder = invoked.map((name) => labels.get(name) ?? "unknown");
      if (invoked.some((name, index) => name !== expected[index])) {
        protocolError = "wrong_order";
        writeJson(response, 400, { error: { message: "unexpected tool order" } });
        return;
      }
      if (invoked.length < expected.length) {
        const name = expected[invoked.length];
        if (name === undefined) throw new Error("expected bridge tool name is unavailable");
        writeModelCompletion(
          response,
          body,
          "",
          toolCallResponse(body.model, resolution.callWrapper, name, invoked.length, taskId),
        );
        return;
      }
      writeModelCompletion(response, body, "Observed the Task and history, then retried it.");
    } catch {
      writeJson(response, 400, { error: { message: "invalid model request" } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get toolNames() {
      return toolNames;
    },
    get requestCount() {
      return requestCount;
    },
    get streamRequested() {
      return streamRequested;
    },
    get resolvedBridgeToolCount() {
      return resolvedBridgeToolCount;
    },
    get toolCallOrder() {
      return toolCallOrder;
    },
    get protocolError() {
      return protocolError;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function writeModelCompletion(
  response: ServerResponse,
  body: Record<string, unknown>,
  content: string,
  toolCall?: Record<string, unknown>,
): void {
  if (body.stream !== true) {
    writeJson(response, 200, toolCall ?? finalModelResponse(body.model, content));
    return;
  }
  const stream =
    toolCall === undefined
      ? finalModelStream(body.model, content)
      : toolCallStream(body.model, toolCall);
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  for (const chunk of stream) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolCallStream(
  model: unknown,
  completion: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const choices = completion.choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error("invalid tool response");
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null || !("message" in choice))
    throw new Error("invalid tool response");
  const message = choice.message;
  if (typeof message !== "object" || message === null || !("tool_calls" in message))
    throw new Error("invalid tool response");
  return [
    {
      id: completion.id,
      object: "chat.completion.chunk",
      model: completion.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: message.tool_calls },
          finish_reason: null,
        },
      ],
    },
    {
      id: completion.id,
      object: "chat.completion.chunk",
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function finalModelStream(model: unknown, content: string): readonly Record<string, unknown>[] {
  const completionModel = typeof model === "string" ? model : "usine-hermes-live";
  return [
    {
      id: "chatcmpl-usine-live-final",
      object: "chat.completion.chunk",
      model: completionModel,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-usine-live-final",
      object: "chat.completion.chunk",
      model: completionModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function resolveToolNames(tools: readonly unknown[]): ResolvedLocalModelTools {
  const suffixes = {
    snapshot: "usine_server_snapshot",
    list: "usine_task_list",
    get: "usine_task_get",
    history: "usine_task_history",
    submit: "usine_task_submit",
    retry: "usine_task_retry",
  } as const;
  const names = new Map<keyof LocalModelToolNames, string[]>();
  const advertisedNames = new Set<string>();
  let searchWrapper: string | undefined;
  let describeWrapper: string | undefined;
  let callWrapper: string | undefined;
  let matchedCount = 0;
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const functionValue = "function" in tool ? tool.function : tool;
    if (typeof functionValue !== "object" || functionValue === null) continue;
    if (!("name" in functionValue) || typeof functionValue.name !== "string") continue;
    const name = functionValue.name;
    if (name === "tool_call") {
      callWrapper = name;
      continue;
    }
    if (name === "tool_search") searchWrapper = name;
    else if (name === "tool_describe") describeWrapper = name;
    else continue;
    if (name !== "tool_search") continue;
    const description =
      "description" in functionValue && typeof functionValue.description === "string"
        ? functionValue.description
        : "";
    for (const deferredName of deferredNames(description)) {
      const match = (Object.entries(suffixes) as [keyof LocalModelToolNames, string][]).find(
        ([, suffix]) => deferredName.endsWith(suffix),
      );
      if (match === undefined) continue;
      matchedCount += 1;
      advertisedNames.add(deferredName);
      const [key] = match;
      names.set(key, [...(names.get(key) ?? []), deferredName]);
    }
  }
  return {
    names: {
      snapshot: names.get("snapshot")?.[0],
      list: names.get("list")?.[0],
      get: names.get("get")?.[0],
      history: names.get("history")?.[0],
      submit: names.get("submit")?.[0],
      retry: names.get("retry")?.[0],
    },
    searchWrapper,
    describeWrapper,
    callWrapper,
    matchedCount,
    distinctNameCount: advertisedNames.size,
    distinctSuffixCount: names.size,
  };
}

function deferredNames(description: string): readonly string[] {
  return [
    ...description.matchAll(
      /\bmcp__[A-Za-z0-9_-]+__usine_(?:server_snapshot|task_list|task_get|task_history|task_submit|task_retry)\b/g,
    ),
  ].map(([name]) => name);
}

function invokedToolNames(messages: unknown, callWrapper: string): readonly string[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const names: string[] = [];
  for (const message of messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("tool_calls" in message)
    )
      continue;
    if (!Array.isArray(message.tool_calls)) return undefined;
    for (const call of message.tool_calls) {
      if (typeof call !== "object" || call === null || !("function" in call)) continue;
      const functionValue = call.function;
      if (
        typeof functionValue === "object" &&
        functionValue !== null &&
        "name" in functionValue &&
        functionValue.name === callWrapper
      ) {
        if (!("arguments" in functionValue)) return undefined;
        const rawArguments = functionValue.arguments;
        let parsedArguments: unknown = rawArguments;
        if (typeof rawArguments === "string") {
          try {
            parsedArguments = JSON.parse(rawArguments);
          } catch {
            return undefined;
          }
        }
        if (
          typeof parsedArguments !== "object" ||
          parsedArguments === null ||
          !("name" in parsedArguments) ||
          typeof parsedArguments.name !== "string" ||
          !("arguments" in parsedArguments) ||
          typeof parsedArguments.arguments !== "object" ||
          parsedArguments.arguments === null
        )
          return undefined;
        names.push(parsedArguments.name);
      }
    }
  }
  return names;
}

function toolCallResponse(
  model: unknown,
  wrapperName: string,
  name: string,
  index: number,
  taskId: string,
): Record<string, unknown> {
  return {
    id: `chatcmpl-usine-live-${index}`,
    object: "chat.completion",
    model: typeof model === "string" ? model : "usine-hermes-live",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-usine-live-${index}`,
              type: "function",
              function: {
                name: wrapperName,
                arguments: JSON.stringify({ name, arguments: { taskId } }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function finalModelResponse(model: unknown, content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-usine-live-final",
    object: "chat.completion",
    model: typeof model === "string" ? model : "usine-hermes-live",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

async function waitForAgentRetry(
  serverUrl: string,
  taskId: string,
  hermesEnvironment: NodeJS.ProcessEnv,
  model: LocalModelFixture,
): Promise<ApiTaskResource> {
  let currentTask: ApiTaskResource | undefined;
  let evidence = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [taskResponse, exported] = await Promise.all([
      fetch(`${serverUrl}/v1/tasks/${encodeURIComponent(taskId)}`).catch(() => undefined),
      execa(
        "hermes",
        [
          "sessions",
          "export",
          "-",
          "--format",
          "jsonl",
          "--redact",
          "--yes",
          "--source",
          "webhook",
        ],
        { env: hermesEnvironment },
      )
        .then((result) => result.stdout)
        .catch(() => ""),
    ]);
    if (taskResponse?.ok) currentTask = (await taskResponse.json()) as ApiTaskResource;
    if (exported !== "") evidence = exported;

    const positions = toolPositions(evidence, model.toolNames);
    if (
      currentTask?.state === "blocked" &&
      currentTask.evidence.implementerActivations === 2 &&
      positions[0] >= 0 &&
      positions[0] < positions[1] &&
      positions[1] < positions[2]
    )
      return currentTask;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `live Hermes fixture timeout: modelRequestCount=${model.requestCount}; streamRequested=${model.streamRequested}; resolvedBridgeToolCount=${model.resolvedBridgeToolCount}; protocolError=${model.protocolError ?? "none"}; returnedToolCallOrder=${model.toolCallOrder.join(">") || "none"}; returnedToolCallCount=${model.toolCallOrder.length}`,
  );
}

function toolPositions(evidence: string, toolNames: LocalModelToolNames): [number, number, number] {
  return [
    toolNames.get === undefined ? -1 : evidence.indexOf(toolNames.get),
    toolNames.history === undefined ? -1 : evidence.indexOf(toolNames.history),
    toolNames.retry === undefined ? -1 : evidence.indexOf(toolNames.retry),
  ];
}

async function stopOwned(child: ResultPromise | undefined): Promise<void> {
  if (!child) return;
  let settled = false;
  const exited = child.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const waitForExit = async (): Promise<boolean> => {
    return Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
  };
  await Promise.resolve();
  if (settled) return;
  if (!settled) child.kill("SIGTERM");
  if (settled || (await waitForExit())) return;
  if (!settled) child.kill("SIGKILL");
  if (!(await waitForExit())) throw new Error("owned Hermes child did not exit after SIGKILL");
}

async function expectPortClosed(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("owned Hermes port remained open after child exit");
}

describe("live Hermes bridge", () => {
  test.skipIf(!live)(
    "activates an isolated Hermes agent through the packaged bridge and explicit retry route",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "usine-hermes-live-"));
      const hermesHome = join(root, "hermes");
      const stateDirectory = join(root, "usine-state");
      const repository = join(root, "repository");
      await mkdir(repository, { recursive: true });
      let webhookPort: number;
      let bridgePort: number;
      let modelPort: number;
      try {
        webhookPort = await reservePort();
        bridgePort = await reservePort();
        modelPort = await reservePort();
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
      const route = `usine-live-${process.pid}-${Date.now()}`;
      const sourceId = `usine-live-${process.pid}`;
      const taskId = `usine-live-task-${process.pid}`;
      const webhookSecret = `live-secret-${process.pid}`;
      let bridgeChild: ResultPromise | undefined;
      let hermesChild: ResultPromise | undefined;
      let localModel: LocalModelFixture | undefined;
      const server = await startUsineServer({
        environment: {
          USINE_STATE_DIR: stateDirectory,
          USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
          USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
          USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:1",
          USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
        },
        execute: async ({ authority, contract, result }) => {
          const reservation = await authority.reserveActivation(
            result.taskId,
            contract.budget.maxImplementerActivations,
          );
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
            "live Hermes bridge completed explicit retry",
          );
        },
        host: "127.0.0.1",
        port: 0,
      });

      try {
        await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
        await execa("git", ["config", "user.name", "Live Test"], { cwd: repository });
        await execa("git", ["config", "user.email", "live@example.invalid"], { cwd: repository });
        await writeFile(join(repository, "README.md"), "live Hermes bridge\n");
        await execa("git", ["add", "."], { cwd: repository });
        await execa("git", ["commit", "-m", "base"], { cwd: repository });
        const baseSha = (
          await execa("git", ["rev-parse", "HEAD"], { cwd: repository })
        ).stdout.trim();
        const contractPath = join(repository, "task.json");
        const contract: TaskContract = {
          id: taskId,
          repositoryId: taskId,
          baseSha,
          instructions:
            "Observe the current Task and its durable history through the Usine bridge.",
          acceptance: ["The already-authorized explicit retry is invoked only after both reads."],
          nonGoals: [],
          budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
          authorization: {
            source: `https://github.com/example/${taskId}/issues/273`,
            delivery: true,
          },
          delivery: {
            branch: `agent/${taskId}`,
            issue: 273,
            title: "Live Hermes bridge",
            body: "Live Hermes bridge",
          },
        };
        await writeFile(contractPath, JSON.stringify(contract));
        await execa("git", ["add", "task.json"], { cwd: repository });
        await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
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
        const registration = await fetch(`${server.url}/v1/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(repositorySnapshot),
        });
        expect(registration.ok).toBe(true);

        const model = await startLocalOpenAiModel(modelPort, taskId);
        localModel = model;
        await waitForPort(modelPort);
        await mkdir(hermesHome, { recursive: true });
        const prompt = `For Task ${taskId}, first call usine_task_get and usine_task_history through the configured Usine MCP server. Only after both current reads, if the Task is waiting and retryable, call usine_task_retry. Report the observed state and history before the retry.`;
        await writeFile(
          join(hermesHome, "config.yaml"),
          JSON.stringify({
            model: {
              provider: "custom",
              model: "usine-hermes-live",
              base_url: model.url,
              api_key: "local-test",
            },
            platforms: {
              webhook: {
                enabled: true,
                extra: {
                  host: "127.0.0.1",
                  port: webhookPort,
                  secret: webhookSecret,
                  routes: {
                    [route]: { secret: webhookSecret, prompt, deliver: "log" },
                  },
                },
              },
            },
            mcp_servers: {
              "usine-bridge": {
                url: `http://127.0.0.1:${bridgePort}/mcp`,
              },
            },
          }),
        );
        const hermesEnvironment: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          HERMES_HOME: hermesHome,
        };

        bridgeChild = execa(process.execPath, [join(bridgeDirectory, "../dist/cli.mjs")], {
          env: {
            PATH: process.env.PATH,
            USINE_SERVER_URL: server.url,
            USINE_SOURCE_ID: sourceId,
            HERMES_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/webhooks/${route}`,
            HERMES_WEBHOOK_SECRET: webhookSecret,
            HERMES_BRIDGE_HOST: "127.0.0.1",
            HERMES_BRIDGE_PORT: String(bridgePort),
          },
        });
        await waitForPort(bridgePort);

        hermesChild = execa("hermes", ["gateway", "run", "--external-supervisor", "--quiet"], {
          env: hermesEnvironment,
        });
        await waitForHermesHealth(webhookPort);

        const submission = await fetch(`${server.url}/v1/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contractPath, repositoryId: taskId }),
        });
        if (!submission.ok) throw new Error(`Task submission failed: HTTP ${submission.status}`);
        const waiting = await waitForTask(
          server.url,
          taskId,
          (task) => task.state === "waiting" && task.retryable === true,
        );
        expect(waiting).toMatchObject({ taskId, state: "waiting", retryable: true });
        const blocked = await waitForAgentRetry(server.url, taskId, hermesEnvironment, model);
        expect(blocked).toMatchObject({
          taskId,
          state: "blocked",
          evidence: { implementerActivations: 2 },
        });
        expect(model.protocolError).toBeUndefined();
        expect(Object.values(model.toolNames)).toHaveLength(6);
        expect(model.toolCallOrder).toEqual(["get", "history", "retry"]);
      } finally {
        await stopOwned(hermesChild);
        await stopOwned(bridgeChild);
        await localModel?.close();
        await expectPortClosed(webhookPort);
        await expectPortClosed(bridgePort);
        await expectPortClosed(modelPort);
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
