import { access, chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Codex,
  type CodexOptions,
  type RunResult,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  CodexCodingSession,
  codingSessionAdapterForProfile,
  codingSessionAdapterProfilesFromEnvironment,
  type CodingSessionMcpServer,
  type CodingSessionObservation,
  createOpenAICompatibleRoleOutputTransform,
  createCodexLauncher,
  discoverOwnedExecutions,
  executionLifecycle,
  explicitWorkerEnvironment,
  implementerOutputSchema,
  ROLE_RESULT_LIMITS,
  codexExecutionIdentityPath,
  removeCodexExecutionIdentity,
  readSessionArchive,
  readSessionArchiveManifest,
  listSessionArchives,
  resolveCodexProfile,
  reviewerOutputSchema,
  type SessionArchive,
  type CodexProfileResolver,
} from "@usine/coding-session";
import { decodeTaskObservationEventInput, type TaskContract } from "@usine/task-authority";
import { sessionArchiveProfileSnapshot } from "../src/session-archive.js";
import { createCodexCodingSessionForTesting } from "../src/coding-session.js";
import { codexAdapterConfig } from "../src/codex-adapter-config.js";
import { normalizeCodingSessionMcpServer } from "../src/coding-session-policy.js";
import type {
  CodingSessionAdapter,
  CodingSessionAdapterRequest,
} from "../src/coding-session-adapter.js";
import { z } from "zod";

const sha = "a".repeat(40);
const contract = { id: "session-test" } as TaskContract;
const implementerExecution = { taskId: contract.id, role: "implementer" as const, attempt: "1" };
const reviewerExecution = { taskId: contract.id, role: "reviewer" as const, attempt: "1-a" };
const opencodeExecution = { taskId: contract.id, role: "reviewer" as const, attempt: "1-b" };
const syntheticProfileResolver: CodexProfileResolver = async (profile) => {
  const selection = {
    model: profile === "reviewer-profile" ? "reviewer-model" : "implementer-model",
    modelReasoningEffort: profile === "reviewer-profile" ? ("high" as const) : ("low" as const),
    developerInstructions:
      profile === "reviewer-profile"
        ? "Reviewer role instruction: inspect the candidate independently."
        : "Implementer role instruction: implement the frozen task contract.",
  };
  return profile === "implementer-profile"
    ? Object.assign(selection, {
        config: { developer_instructions: "hidden conflicting instruction" },
      })
    : selection;
};

function completeArchive(archive: SessionArchive) {
  if (!("items" in archive)) throw new Error("expected a complete archive");
  return archive;
}

function sdkTurn(finalResponse: string, usage: RunResult["usage"] = null): RunResult {
  return { items: [], finalResponse, usage };
}

function testClient(
  run: (prompt: string, options?: TurnOptions) => Promise<RunResult>,
  id: string | null = null,
  onStart?: (options: ThreadOptions) => void,
  completedItems: readonly ThreadItem[] = [],
): Codex {
  const client = new Codex();
  const thread = client.startThread();
  Object.defineProperty(thread, "id", { configurable: true, value: id });
  thread.run = run;
  thread.runStreamed = async (prompt, options) => ({
    events: (async function* (): AsyncGenerator<ThreadEvent> {
      if (typeof prompt !== "string") throw new Error("test prompt must be a string");
      const result = await run(prompt, options);
      yield { type: "thread.started", thread_id: id ?? "thread-test" };
      yield { type: "turn.started" };
      for (const item of completedItems) yield { type: "item.completed", item };
      yield {
        type: "item.completed",
        item: { type: "agent_message", id: "message", text: result.finalResponse },
      };
      yield {
        type: "turn.completed",
        usage: result.usage ?? {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };
    })(),
  });
  client.startThread = (options: ThreadOptions = {}) => {
    onStart?.(options);
    return thread;
  };
  return client;
}

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

async function fakeAppServerEnvironment(
  mode:
    | "success"
    | "interrupt"
    | "mismatch"
    | "malformed"
    | "transport"
    | "capability"
    | "thread-failure"
    | "schema-invalid"
    | "stderr"
    | "wait" = "success",
  expectedMcpConfig: unknown = null,
  expectedModel = "fixture-model",
  expectedReasoning = "minimal",
  expectedDeveloperInstructions = "Fixture reviewer instructions",
): Promise<{
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  protocolLogPath: string;
  pidPath: string;
  runtimePath: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "usine-app-server-"));
  const bin = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const stateDirectory = join(root, "state");
  await mkdir(join(stateDirectory, "reviewer"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const protocolLogPath = join(codexHome, "protocol.log");
  const pidPath = join(codexHome, "app-server.pid");
  const runtimePath = resolve(tmpdir(), "usine-app-server-runtime-path");
  await writeFile(join(codexHome, "fixture-mode"), `${mode}\n`);
  await writeFile(protocolLogPath, "");
  await writeFile(
    join(codexHome, "reviewer-profile.config.toml"),
    'model = "fixture-model"\nmodel_reasoning_effort = "minimal"\ndeveloper_instructions = "Fixture reviewer instructions"\n',
  );
  const executable = join(bin, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const mode = readFileSync(process.env.CODEX_HOME + "/fixture-mode", "utf8").trim();
const expectedMcpConfig = ${JSON.stringify(expectedMcpConfig)};
const expectedModel = ${JSON.stringify(expectedModel)};
const expectedReasoning = ${JSON.stringify(expectedReasoning)};
const expectedDeveloperInstructions = ${JSON.stringify(expectedDeveloperInstructions)};
if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected Codex transport arguments\\n");
  process.exit(2);
}
if (process.env.USINE_CODING_SESSION_IDENTITY_PATH || process.env.USINE_CODING_SESSION_WORKSPACE) {
  process.stderr.write("unexpected execution identity environment\\n");
  process.exit(4);
}
writeFileSync(process.env.CODEX_HOME + "/app-server.pid", String(process.pid));
if (mode === "stderr") {
  process.stderr.write("profile configuration failed secret=should-not-escape\\n");
  process.exit(1);
}
let buffer = "";
const record = (event) => appendFileSync(process.env.CODEX_HOME + "/protocol.log", event + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const emitTurn = () => {
  send({ method: "turn/started", params: { threadId: "thread-fixture", turn: { id: "turn-fixture" } } });
  if (mode === "interrupt" || mode === "wait") return;
  if (mode === "malformed") return process.stdout.write("malformed\\n");
  if (mode === "transport") return setImmediate(() => process.exit(0));
  const output = mode === "schema-invalid"
    ? JSON.stringify({ invalid: true })
    : JSON.stringify({ sha: "${sha}", verdict: "approved", summary: "app-server", findings: [] });
  send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "commandExecution", id: "command-fixture", status: "completed" } } });
  send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "mcpToolCall", id: "mcp-fixture", server: "github_read?token=host-secret", tool: "github_issue_get?token=host-secret", arguments: { issue: 285, workspace: ${JSON.stringify(runtimePath)} }, result: { content: [{ type: "text", text: ${JSON.stringify("app-server tool output " + runtimePath)} }] }, status: "completed" } } });
  send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "agentMessage", id: "message-fixture", text: output } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-fixture", turnId: "turn-fixture", tokenUsage: { last: { inputTokens: 200, cachedInputTokens: 40, cacheWriteInputTokens: 60, outputTokens: 7, reasoningOutputTokens: 3 } } } });
  send({ method: "turn/completed", params: { threadId: mode === "mismatch" ? "wrong-thread" : "thread-fixture", turn: { id: "turn-fixture", status: "completed", error: null } } });
};
const handle = (message) => {
  record(message.method ?? "response");
  if (message.method === "initialize") {
    if (mode === "wait") return;
    send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fixture", codexHome: ".", platformFamily: "unix", platformOs: "test" } });
  }
  else if (message.method === "thread/start") {
    if (mode === "thread-failure") {
      process.stderr.write("network connection refused secret=should-not-escape\\n");
      process.exit(1);
    }
    if (message.params?.config?.model !== expectedModel ||
        message.params?.config?.model_reasoning_effort !== expectedReasoning ||
        message.params?.config?.developer_instructions !== expectedDeveloperInstructions ||
        message.params?.approvalPolicy !== "never" ||
        message.params?.sandbox !== "read-only") {
      process.stderr.write("profile configuration was not forwarded\\n");
      process.exit(3);
    }
    if (
      expectedMcpConfig !== null &&
      (message.params?.config?.approval_policy !== expectedMcpConfig.approval_policy ||
        JSON.stringify(message.params?.config?.mcp_servers) !== JSON.stringify(expectedMcpConfig.mcp_servers))
    ) {
      process.stderr.write("MCP configuration was not forwarded\\n");
      process.exit(3);
    }
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-fixture" } } });
    setImmediate(() => send({ method: "thread/started", params: { thread: { id: "thread-fixture" } } }));
  } else if (message.method === "turn/start") {
    if (mode === "capability") {
      send({ method: "server/request", id: 99, params: { capability: "unsupported" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-fixture" } } });
    setImmediate(emitTurn);
  } else if (message.method === "turn/interrupt") {
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "interrupted", error: null } } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\\n").slice(0, -1)) handle(JSON.parse(line));
  buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
});
process.stdin.on("end", () => {
  record("transport-release");
  process.exit(0);
});
process.stdin.resume();
setInterval(() => undefined, 1_000);
`,
  );
  await chmod(executable, 0o755);
  return {
    environment: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_HOME: codexHome,
      CI: "true",
    },
    stateDirectory,
    protocolLogPath,
    pidPath,
    runtimePath,
    close: async () => undefined,
  };
}

async function expectAppServerChildSettled(fixture: {
  pidPath: string;
  stateDirectory: string;
}): Promise<void> {
  const pid = Number(await readFile(fixture.pidPath, "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(access(join(fixture.stateDirectory, "codex-executions"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function startFakeGithubHost(): Promise<{
  connectClient: () => Promise<Client>;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const mcp = new McpServer({ name: "fake-github-host", version: "1.0.0" });
  const issue = {
    owner: "example",
    repository: "authorized",
    number: 189,
    title: "Read-only MCP context",
  };
  mcp.registerTool(
    "github_issue_get",
    {
      description: "Read the admitted GitHub Issue.",
      inputSchema: { owner: z.string(), repository: z.string(), issue: z.number() },
    },
    async (input) => {
      calls.push({ name: "github_issue_get", arguments: input });
      if (
        input.owner !== issue.owner ||
        input.repository !== issue.repository ||
        input.issue !== issue.number
      )
        return {
          isError: true,
          content: [{ type: "text", text: "GitHub repository or Issue is outside the admission" }],
        };
      return { content: [{ type: "text", text: JSON.stringify(issue) }] };
    },
  );
  mcp.registerTool(
    "github_issue_update",
    {
      description: "Mutation endpoint that must never be usable by a worker.",
      inputSchema: {
        owner: z.string(),
        repository: z.string(),
        issue: z.number(),
        title: z.string(),
      },
    },
    async (input) => {
      calls.push({ name: "github_issue_update", arguments: input });
      return {
        isError: true,
        content: [{ type: "text", text: "GitHub mutation is not available to Coding Session" }],
      };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  return {
    connectClient: async () => {
      const client = new Client({ name: "usine-coding-session-test", version: "1.0.0" });
      await client.connect(clientTransport);
      return client;
    },
    calls,
    close: async () => {
      await mcp.close();
    },
  };
}

function textContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const item = value.find(
    (candidate): candidate is { readonly type: "text"; readonly text: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "type" in candidate &&
      candidate.type === "text" &&
      "text" in candidate &&
      typeof candidate.text === "string",
  );

  return item?.text;
}

describe("Coding Session", () => {
  test("retains starting and live execution identities and removes a confirmed-stopped identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-identity-"));
    const workspace = join(stateDirectory, "workspace");
    const identityPath = codexExecutionIdentityPath(stateDirectory, implementerExecution);
    await mkdir(join(stateDirectory, "codex-executions"), { recursive: true });

    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "starting",
        reference: implementerExecution,
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(false);
    await expect(access(identityPath)).resolves.toBeUndefined();

    const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!liveChild.pid) throw new Error("live child has no PID");
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(liveChild.pid)], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "running",
        reference: implementerExecution,
        pid: liveChild.pid,
        startedAt,
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(false);
    await expect(readFile(identityPath, "utf8")).resolves.toContain('"state":"running"');
    process.kill(-liveChild.pid, "SIGKILL");
    await new Promise<void>((resolve) => liveChild.once("exit", () => resolve()));

    const stoppedChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (!stoppedChild.pid) throw new Error("stopped child has no PID");
    await new Promise<void>((resolve, reject) => {
      stoppedChild.once("error", reject);
      stoppedChild.once("exit", () => resolve());
    });
    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "running",
        reference: implementerExecution,
        pid: stoppedChild.pid,
        startedAt: "confirmed-stopped",
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(true);
    await expect(access(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("discovers valid implementer and reviewer launcher identities by task ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-discovery-"));
    const implementer = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "writer"),
      implementerExecution,
    );
    const reviewerReference = {
      taskId: "review-task",
      role: "reviewer" as const,
      attempt: "1-a" + sha,
    };
    const reviewer = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "reviewer"),
      reviewerReference,
    );

    await expect(discoverOwnedExecutions(stateDirectory, contract.id)).resolves.toEqual([
      { reference: implementerExecution, workspace: join(stateDirectory, "writer") },
    ]);
    await expect(
      discoverOwnedExecutions(stateDirectory, reviewerReference.taskId),
    ).resolves.toEqual([
      { reference: reviewerReference, workspace: join(stateDirectory, "reviewer") },
    ]);
    await expect(readFile(implementer.launcherPath, "utf8")).resolves.toContain(
      'reference: {"taskId":"session-test","role":"implementer","attempt":"1"}',
    );
    await expect(readFile(reviewer.identityPath, "utf8")).resolves.toContain('"role":"reviewer"');
  });

  test("fails closed when a launcher has no companion identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-incomplete-"));
    const launcher = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "workspace"),
      implementerExecution,
    );
    await unlink(launcher.identityPath);
    await expect(discoverOwnedExecutions(stateDirectory, contract.id)).rejects.toThrow(
      "Codex execution launcher has no durable identity",
    );
  });

  test("converges concurrent reviewer interrupt and reap on one owned execution", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-race-"));
    const workspace = join(stateDirectory, "reviewer");
    const reference = {
      taskId: "review-race",
      role: "reviewer" as const,
      attempt: `1-${sha}`,
    };
    const launcher = await createCodexLauncher(stateDirectory, workspace, reference);
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!child.pid) throw new Error("reviewer child has no PID");
    try {
      const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
        encoding: "utf8",
      }).trim();
      await writeFile(
        launcher.identityPath,
        JSON.stringify({
          version: 2,
          state: "running",
          reference,
          pid: child.pid,
          startedAt,
          workspace,
        }) + "\n",
      );
      const handle = { reference, workspace };
      const results = await Promise.allSettled([
        executionLifecycle.interrupt(stateDirectory, handle),
        executionLifecycle.reap(stateDirectory, handle),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      await expect(discoverOwnedExecutions(stateDirectory, reference.taskId)).resolves.toEqual([]);
      await expect(access(launcher.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(launcher.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
      let states: string[] = [];
      try {
        states = execFileSync("ps", ["-o", "stat=", "-g", String(child.pid)], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean);
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 1)) throw error;
      }
      expect(states.every((state) => /^[ZX]/.test(state.trim()))).toBe(true);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The shared termination transition may already have removed the group.
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  test("owns task cleanup behind the Coding Session boundary", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-session-cleanup-"));
    const workspace = join(stateDirectory, "reviewer");
    const reference = {
      taskId: "session-cleanup",
      role: "reviewer" as const,
      attempt: `1-${sha}`,
    };
    const launcher = await createCodexLauncher(stateDirectory, workspace, reference);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("reviewer child has no PID");
    try {
      const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
        encoding: "utf8",
      }).trim();
      await writeFile(
        launcher.identityPath,
        JSON.stringify({
          version: 2,
          state: "running",
          reference,
          pid: child.pid,
          startedAt,
          workspace,
        }) + "\n",
      );

      const session = new CodexCodingSession(undefined, {
        environment: {},
        executionStateDirectory: stateDirectory,
      });
      await session.cleanupTask(stateDirectory, reference.taskId);

      await expect(discoverOwnedExecutions(stateDirectory, reference.taskId)).resolves.toEqual([]);
      await expect(access(launcher.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(launcher.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The Coding Session cleanup may already have removed the group.
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  test("uses the SDK public lifecycle without creating an execution identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-sdk-lifecycle-"));
    const fakeClient = testClient(
      async () => sdkTurn(JSON.stringify({ status: "proposed", summary: "sdk" })),
      "sdk-thread",
    );
    const fakeThread = fakeClient.startThread();
    const startThread = vi.spyOn(Codex.prototype, "startThread").mockImplementation(function (
      _options: ThreadOptions = {},
    ) {
      return fakeThread;
    });
    try {
      const session = new CodexCodingSession(undefined, {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
      });
      await expect(
        session.run({
          role: "implementer",
          workspace: "fixtures/writer",
          contract,
          prompt: "work",
          profile: "implementer-profile",
          sandbox: "workspace-write",
          deadlineEpochMs: Date.now() + 10_000,
          outputSchema: implementerOutputSchema,
          execution: implementerExecution,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        output: { status: "proposed", summary: "sdk" },
        effectiveProfile: { adapter: "sdk" },
      });
    } finally {
      startThread.mockRestore();
    }

    await expect(access(join(stateDirectory, "codex-executions"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("selects the app-server by profile while preserving the SDK path for other roles", async () => {
    const fixture = await fakeAppServerEnvironment(
      "success",
      undefined,
      "reviewer-model",
      "high",
      "Reviewer role instruction: inspect the candidate independently.",
    );
    const session = new CodexCodingSession(
      async (request) =>
        testClient(
          async () =>
            sdkTurn(JSON.stringify({ status: "proposed", summary: request.profile }), {
              input_tokens: 2,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 0,
            }),
          "sdk-thread",
        ),
      {
        environment: fixture.environment,
        executionStateDirectory: fixture.stateDirectory,
        adapterSelectionEnvironment: {
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
        },
        profileResolver: syntheticProfileResolver,
      },
    );

    await expect(
      session.run({
        role: "implementer",
        workspace: join(fixture.stateDirectory, "writer"),
        contract,
        prompt: "work",
        profile: "writer-profile",
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: implementerOutputSchema,
        execution: implementerExecution,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { status: "proposed", summary: "writer-profile" },
    });
    await expect(
      session.run({
        role: "reviewer",
        workspace: join(fixture.stateDirectory, "reviewer"),
        contract,
        prompt: "review",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { verdict: "approved", summary: "app-server" },
    });
  });

  test("defaults to SDK and ignores adapter selection variables in provider environment", async () => {
    let sdkCalls = 0;
    const session = new CodexCodingSession(
      async () => {
        sdkCalls += 1;
        return testClient(async () =>
          sdkTurn(
            JSON.stringify({ sha, verdict: "approved", summary: "sdk-default", findings: [] }),
          ),
        );
      },
      {
        environment: {
          CI: "true",
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
          USINE_OPENCODE2_PROFILES: "opencode-profile",
        },
        profileResolver: syntheticProfileResolver,
      },
    );

    await expect(
      session.run({
        role: "reviewer",
        workspace: "fixtures/reviewer",
        contract,
        prompt: "review",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { verdict: "approved", summary: "sdk-default" },
      effectiveProfile: { adapter: "sdk" },
    });
    expect(sdkCalls).toBe(1);
  });

  test("maps unsafe effective model and provider identities to null before Task observation", async () => {
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () => sdkTurn(JSON.stringify({ status: "proposed", summary: "safe" })),
          "thread",
        ),
      {
        environment: { CI: "true" },
        profileResolver: async () =>
          Object.assign(
            {
              model: "https://private.example/v1/model",
              modelReasoningEffort: "low" as const,
            },
            { config: { model_provider: "private.example" } },
          ),
      },
    );

    const observation = await session.run({
      role: "implementer",
      workspace: "fixtures/writer",
      contract,
      prompt: "work",
      profile: "writer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
    });

    expect(observation.effectiveProfile).toMatchObject({ model: null, modelProvider: null });
    expect(() =>
      decodeTaskObservationEventInput({
        eventId: "unsafe-profile-observation",
        occurredAtEpochMs: 1,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: "coding-session:1:implementer",
          requestedProfile: observation.requestedProfile,
          effectiveProfile: {
            ...observation.effectiveProfile,
            model: "https://private.example/v1/model",
            modelProvider: "private.example",
          },
          usage: observation.usage,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeTaskObservationEventInput({
        eventId: "safe-profile-observation",
        occurredAtEpochMs: 1,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: "coding-session:1:implementer",
          requestedProfile: observation.requestedProfile,
          effectiveProfile: observation.effectiveProfile,
          usage: observation.usage,
        },
      }),
    ).not.toThrow();
  });

  test("uses a digest-only identity for hidden provider and catalog configuration", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "usine-codex-profile-digest-"));
    const profilePath = join(codexHome, "reviewer-profile.config.toml");
    const writeProfile = async (providerUrl: string, catalogUrl: string) => {
      await writeFile(
        profilePath,
        [
          'model = "reviewer-model"',
          `model_catalog_json = '{"endpoint":"${catalogUrl}"}'`,
          "[model_providers.private]",
          `base_url = "${providerUrl}"`,
          "",
        ].join("\n"),
      );
    };
    await writeProfile("https://provider-one.example.test", "https://catalog-one.example.test");
    const first = await resolveCodexProfile("reviewer-profile", { CODEX_HOME: codexHome });
    await writeProfile("https://provider-two.example.test", "https://catalog-one.example.test");
    const providerChanged = await resolveCodexProfile("reviewer-profile", {
      CODEX_HOME: codexHome,
    });
    await writeProfile("https://provider-two.example.test", "https://catalog-two.example.test");
    const catalogChanged = await resolveCodexProfile("reviewer-profile", { CODEX_HOME: codexHome });

    expect(first.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(providerChanged.configSha256).not.toBe(first.configSha256);
    expect(catalogChanged.configSha256).not.toBe(providerChanged.configSha256);
    const archiveProfile = sessionArchiveProfileSnapshot("reviewer-profile", {
      ...catalogChanged,
      ...catalogChanged.config,
    });
    expect(JSON.stringify(archiveProfile)).not.toContain("provider-two.example.test");
    expect(JSON.stringify(archiveProfile)).not.toContain("catalog-two.example.test");
    expect(archiveProfile).not.toHaveProperty("modelProviders");
    expect(archiveProfile).not.toHaveProperty("modelCatalogJson");
  });

  test("applies synthetic role model selection at both adapter boundaries", async () => {
    const fixture = await fakeAppServerEnvironment(
      "success",
      null,
      "reviewer-model",
      "high",
      "Reviewer role instruction: inspect the candidate independently.",
    );
    let sdkThreadOptions: ThreadOptions | undefined;
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () => sdkTurn(JSON.stringify({ status: "proposed", summary: "sdk" })),
          "sdk-thread",
          (options) => {
            sdkThreadOptions = options;
          },
        ),
      {
        environment: fixture.environment,
        executionStateDirectory: fixture.stateDirectory,
        adapterSelectionEnvironment: {
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
        },
        profileResolver: syntheticProfileResolver,
      },
    );

    await expect(
      session.run({
        role: "implementer",
        workspace: join(fixture.stateDirectory, "writer"),
        contract,
        prompt: "work",
        profile: "implementer-profile",
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: implementerOutputSchema,
        execution: implementerExecution,
      }),
    ).resolves.toMatchObject({ status: "completed", output: { summary: "sdk" } });
    expect(sdkThreadOptions).toMatchObject({
      model: "implementer-model",
      modelReasoningEffort: "low",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

    await expect(
      session.run({
        role: "reviewer",
        workspace: join(fixture.stateDirectory, "reviewer"),
        contract,
        prompt: "review",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
      }),
    ).resolves.toMatchObject({ status: "completed", output: { summary: "app-server" } });
  });

  test("forwards distinct role developer instructions through the official SDK config", async () => {
    const capturedConfigs: CodexOptions[] = [];
    const capturedThreads: ThreadOptions[] = [];
    const prompts: string[] = [];
    const turnOptions: TurnOptions[] = [];
    const fakeClient = testClient(async (prompt, options) => {
      prompts.push(prompt);
      if (options) turnOptions.push(options);
      return sdkTurn(
        prompt === "review"
          ? JSON.stringify({ sha, verdict: "approved", summary: "sdk-review", findings: [] })
          : JSON.stringify({ status: "proposed", summary: "sdk-implementer" }),
      );
    }, "sdk-thread");
    const fakeThread = fakeClient.startThread();
    const startThread = vi.spyOn(Codex.prototype, "startThread").mockImplementation(function (
      this: Codex,
      options: ThreadOptions = {},
    ) {
      capturedConfigs.push((this as unknown as { options: CodexOptions }).options);
      capturedThreads.push(options);
      return fakeThread;
    });
    try {
      const session = new CodexCodingSession(undefined, {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
      });
      await expect(
        session.run({
          role: "implementer",
          workspace: "fixtures/writer",
          contract,
          prompt: "work",
          profile: "implementer-profile",
          sandbox: "workspace-write",
          deadlineEpochMs: Date.now() + 10_000,
          outputSchema: implementerOutputSchema,
          execution: implementerExecution,
        }),
      ).resolves.toMatchObject({ status: "completed", output: { summary: "sdk-implementer" } });
      await expect(
        session.run({
          role: "reviewer",
          workspace: "fixtures/reviewer",
          contract,
          prompt: "review",
          profile: "reviewer-profile",
          sandbox: "read-only",
          deadlineEpochMs: Date.now() + 10_000,
          outputSchema: reviewerOutputSchema,
          execution: reviewerExecution,
        }),
      ).resolves.toMatchObject({ status: "completed", output: { summary: "sdk-review" } });
    } finally {
      startThread.mockRestore();
    }

    expect(capturedConfigs.map((options) => options.config?.model)).toEqual([
      "implementer-model",
      "reviewer-model",
    ]);
    expect(capturedConfigs.map((options) => options.config?.developer_instructions)).toEqual([
      "Implementer role instruction: implement the frozen task contract.",
      "Reviewer role instruction: inspect the candidate independently.",
    ]);
    expect(
      capturedConfigs.every((options) => options.env?.developer_instructions === undefined),
    ).toBe(true);
    expect(capturedThreads).toEqual([
      expect.objectContaining({
        model: "implementer-model",
        modelReasoningEffort: "low",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      }),
      expect.objectContaining({
        model: "reviewer-model",
        modelReasoningEffort: "high",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ]);
    expect(prompts).toEqual(["work", "review"]);
    expect(turnOptions.every((options) => options.outputSchema !== undefined)).toBe(true);
  });

  test("selects one static adapter per profile and rejects overlapping selections", () => {
    const profiles = codingSessionAdapterProfilesFromEnvironment({
      USINE_CODEX_APP_SERVER_PROFILES: " app-server-profile,shared-profile ",
      USINE_OPENCODE2_PROFILES: " opencode-profile ",
    });
    expect(profiles).toEqual({
      appServerProfiles: ["app-server-profile", "shared-profile"],
      openCode2Profiles: ["opencode-profile"],
    });
    expect(codingSessionAdapterForProfile("sdk-profile", profiles)).toBe("sdk");
    expect(codingSessionAdapterForProfile("app-server-profile", profiles)).toBe("app-server");
    expect(codingSessionAdapterForProfile("opencode-profile", profiles)).toBe("opencode2");
    expect(() =>
      codingSessionAdapterProfilesFromEnvironment({
        USINE_CODEX_APP_SERVER_PROFILES: "shared-profile",
        USINE_OPENCODE2_PROFILES: "shared-profile",
      }),
    ).toThrow("assigned to both codex-app-server and opencode2");
    expect(
      () =>
        new CodexCodingSession(undefined, {
          environment: { CI: "true" },
          adapterSelectionEnvironment: {
            USINE_CODEX_APP_SERVER_PROFILES: "shared-profile",
            USINE_OPENCODE2_PROFILES: "shared-profile",
          },
        }),
    ).toThrow("assigned to both codex-app-server and opencode2");
  });

  test("executes an app-server reviewer and settles its direct child without an identity", async () => {
    const mcpServer: CodingSessionMcpServer = {
      name: "github_read",
      url: "https://github.example.test/mcp?task=session-test",
      enabledTools: ["github_issue_get", "github_pull_request_reviews"],
      startupTimeoutMs: 4_000,
      toolTimeoutMs: 7_000,
      required: true,
    };
    const fixture = await fakeAppServerEnvironment(
      "success",
      codexAdapterConfig(
        {
          model: "fixture-model",
          reasoningEffort: "minimal",
          developerInstructions: "Fixture reviewer instructions",
        },
        normalizeCodingSessionMcpServer(mcpServer),
      ),
    );
    const observations: CodingSessionObservation[] = [];
    const finalObservationEntered = deferred<void>();
    const releaseFinalObservation = deferred<void>();
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const pending = session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      mcpServer,
      execution: reviewerExecution,
      onObservation: async (event) => {
        observations.push(event);
        if (event.type === "turn_completed") {
          finalObservationEntered.resolve();
          return releaseFinalObservation.promise;
        }
      },
    });
    await finalObservationEntered.promise;
    expect(observations).toHaveLength(6);
    releaseFinalObservation.resolve();
    const observation = await pending;
    expect(observation).toMatchObject({
      status: "completed",
      output: { verdict: "approved", summary: "app-server" },
      usage: {
        inputTokens: 200,
        cachedInputTokens: 40,
        uncachedInputTokens: 100,
        cacheWriteInputTokens: 60,
        outputTokens: 7,
        reasoningOutputTokens: 3,
      },
    });
    expect(observations).toEqual([
      { type: "thread_started" },
      { type: "turn_started", turn: 1 },
      { type: "tool_completed", tool: "shell", outcome: "succeeded" },
      {
        type: "mcp_tool_completed",
        server: "unknown",
        tool: "unknown",
        outcome: "succeeded",
      },
      {
        type: "usage_observed",
        source: "provider",
        semantics: "replacement",
        usage: {
          inputTokens: 200,
          cachedInputTokens: 40,
          uncachedInputTokens: 100,
          cacheWriteInputTokens: 60,
          outputTokens: 7,
          reasoningOutputTokens: 3,
        },
      },
      { type: "turn_completed", turn: 1, outcome: "succeeded" },
    ]);
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
    await expectAppServerChildSettled(fixture);
    const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
    const archive = completeArchive(
      await readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
    );
    expect(archive).toMatchObject({
      schemaVersion: 1,
      role: "reviewer",
      attempt: "1-a",
      adapter: "app-server",
      sessionId: "thread-fixture",
      rawFinalResponse: JSON.stringify({
        sha,
        verdict: "approved",
        summary: "app-server",
        findings: [],
      }),
      normalizedOutput: { sha, verdict: "approved", summary: "app-server", findings: [] },
      usage: {
        inputTokens: 200,
        cachedInputTokens: 40,
        uncachedInputTokens: 100,
        cacheWriteInputTokens: 60,
        outputTokens: 7,
        reasoningOutputTokens: 3,
      },
      completeness: "complete",
      profile: {
        name: "reviewer-profile",
        model: "fixture-model",
        modelReasoningEffort: "minimal",
        developerInstructions: "Fixture reviewer instructions",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(observation.effectiveProfile?.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.effectiveProfile?.configSha256).not.toBe(archive.profile.sha256);
    expect(archive.items.map((item) => item.type)).toEqual([
      "command_execution",
      "mcp_tool_call",
      "agent_message",
    ]);
    expect(archive.items).toContainEqual(
      expect.objectContaining({
        type: "mcp_tool_call",
        arguments: { issue: 285, workspace: fixture.runtimePath },
        output: {
          content: [{ type: "text", text: `app-server tool output ${fixture.runtimePath}` }],
        },
      }),
    );
    expect(JSON.stringify(archive)).toContain(fixture.runtimePath);
  });

  test("interrupts an app-server turn and settles its direct child after notification", async () => {
    const fixture = await fakeAppServerEnvironment("interrupt");
    const controller = new AbortController();
    const started = deferred<void>();
    const observations: CodingSessionObservation[] = [];
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const pending = session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      signal: controller.signal,
      onObservation: (event) => {
        observations.push(event);
        if (event.type === "turn_started") started.resolve();
      },
    });
    await started.promise;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", output: null });
    const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
    const archive = completeArchive(
      await readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
    );
    expect(archive).toMatchObject({
      status: "cancelled",
      adapter: "app-server",
      phase: "turn",
      sessionId: "thread-fixture",
      completeness: "partial",
    });
    const protocol = (await readFile(fixture.protocolLogPath, "utf8")).trim().split("\n");
    expect(protocol).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/interrupt",
      "transport-release",
    ]);
    const observationCount = observations.length;
    await Promise.resolve();
    expect(observations).toHaveLength(observationCount);
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
    await expectAppServerChildSettled(fixture);
  });

  test("applies the shared schema-invalid terminal output behavior to app-server", async () => {
    const fixture = await fakeAppServerEnvironment("schema-invalid");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
      roleOutputTransform: async () => ({ invalid: true }),
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failureCode: "role_output_schema_invalid",
    });
    const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
    const archive = completeArchive(
      await readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
    );
    expect(archive).toMatchObject({
      status: "failed",
      adapter: "app-server",
      rawFinalResponse: JSON.stringify({ invalid: true }),
      normalizedOutput: { invalid: true },
      completeness: "complete",
    });
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
    await expectAppServerChildSettled(fixture);
  });

  test("cancels an app-server startup at its shared deadline", async () => {
    const fixture = await fakeAppServerEnvironment("wait");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 500,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "cancelled",
      output: null,
      phase: "startup",
      failureClass: "timeout",
    });
    const protocolLog = (await readFile(fixture.protocolLogPath, "utf8")).trim();
    const protocol = protocolLog === "" ? [] : protocolLog.split("\n");
    expect(protocol).not.toContain("turn/interrupt");
    const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
    await expect(
      readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
    ).resolves.toMatchObject({
      status: "cancelled",
      completeness: "partial",
    });
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
    await expectAppServerChildSettled(fixture);
  });

  test.each(["malformed", "transport", "capability"] as const)(
    "fails closed on app-server %s without starting a replacement",
    async (mode) => {
      const fixture = await fakeAppServerEnvironment(mode);
      const session = new CodexCodingSession(undefined, {
        environment: fixture.environment,
        executionStateDirectory: fixture.stateDirectory,
        adapterSelectionEnvironment: {
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
        },
      });
      const observation = await session.run({
        role: "reviewer",
        workspace: join(fixture.stateDirectory, "reviewer"),
        contract,
        prompt: "review",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
      });
      expect(observation).toMatchObject({ status: "failed", output: null });
      const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
      await expect(
        readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
      ).resolves.toMatchObject({
        completeness: "partial",
      });
      await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual(
        [],
      );
      await expectAppServerChildSettled(fixture);
    },
  );

  test("classifies bounded app-server stderr without exposing its contents", async () => {
    const fixture = await fakeAppServerEnvironment("stderr");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      failure: "app-server transport closed (configuration)",
      phase: "startup",
      failureClass: "configuration",
    });
    expect(observation.failure).not.toContain("should-not-escape");
    await expectAppServerChildSettled(fixture);
  });

  test("keeps an App Server thread-start failure out of the turn phase", async () => {
    const fixture = await fakeAppServerEnvironment("thread-failure");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      phase: "thread",
      failureClass: "network",
    });
    expect(JSON.stringify(observation)).not.toContain("should-not-escape");
    const archives = await listSessionArchives(fixture.stateDirectory, contract.id);
    await expect(
      readSessionArchive(fixture.stateDirectory, archives[0]!.archiveId),
    ).resolves.toMatchObject({
      completeness: "partial",
    });
  });

  test("fails closed on an app-server identity mismatch and does not retry", async () => {
    const fixture = await fakeAppServerEnvironment("mismatch");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      adapterSelectionEnvironment: {
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
      },
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: join(fixture.stateDirectory, "reviewer"),
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({ status: "failed", output: null });
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
    await expectAppServerChildSettled(fixture);
  });

  test("pre-approves exactly the enabled MCP tools", () => {
    const enabledTools = ["github_issue_get", "github_pull_request_reviews"] as const;
    const server = {
      name: "github_read",
      url: "https://github.example.test/mcp",
      enabledTools,
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      required: true,
    } as const;
    const config = z
      .object({
        approval_policy: z.literal("never"),
        mcp_servers: z.record(
          z.string(),
          z.object({
            enabled_tools: z.array(z.string()),
            tools: z.record(z.string(), z.object({ approval_mode: z.literal("approve") })),
          }),
        ),
      })
      .parse(
        JSON.parse(
          JSON.stringify(
            codexAdapterConfig({ model: "fixture-model" }, normalizeCodingSessionMcpServer(server)),
          ),
        ),
      );
    const configured = config.mcp_servers[server.name];
    expect(config.approval_policy).toBe("never");
    expect(configured.enabled_tools).toEqual([...enabledTools]);
    expect(Object.keys(configured.tools)).toEqual([...enabledTools]);
    for (const tool of enabledTools) expect(configured.tools[tool]?.approval_mode).toBe("approve");
  });

  test("rejects unusable MCP server policy inputs", () => {
    const server: CodingSessionMcpServer = {
      name: "github_read",
      url: "https://github.example.test/mcp",
      enabledTools: ["github_issue_get"],
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      required: true,
    };
    const invalidServers: CodingSessionMcpServer[] = [
      { ...server, name: "github/read" },
      { ...server, url: "ftp://github.example.test/mcp" },
      { ...server, url: "https://user:secret@github.example.test/mcp" },
      { ...server, enabledTools: [] },
      { ...server, enabledTools: [" "] },
      { ...server, startupTimeoutMs: 0 },
      { ...server, toolTimeoutMs: Number.POSITIVE_INFINITY },
    ];
    for (const invalidServer of invalidServers)
      expect(() => normalizeCodingSessionMcpServer(invalidServer)).toThrow();
  });

  test("reads the admitted Issue through read-only MCP without giving the worker credentials", async () => {
    const host = await startFakeGithubHost();
    const observations: unknown[] = [];
    const session = new CodexCodingSession(
      async (request) => {
        if (!request.mcpServer) throw new Error("GitHub read MCP server is missing");
        expect(request.mcpServer).toMatchObject({
          name: "github_read",
          enabledTools: ["github_issue_get"],
        });
        expect(JSON.stringify(request.mcpServer)).not.toContain("worker-github-secret");
        expect(explicitWorkerEnvironment(request.environment ?? {})).not.toHaveProperty(
          "GITHUB_TOKEN",
        );
        const client = await host.connectClient();
        return testClient(async () => {
          try {
            const authorized = await client.callTool({
              name: "github_issue_get",
              arguments: { owner: "example", repository: "authorized", issue: 189 },
            });
            const crossRepository = await client.callTool({
              name: "github_issue_get",
              arguments: { owner: "example", repository: "other", issue: 189 },
            });
            const mutation = await client.callTool({
              name: "github_issue_update",
              arguments: {
                owner: "example",
                repository: "authorized",
                issue: 189,
                title: "attack",
              },
            });
            if (authorized.isError || !crossRepository.isError || !mutation.isError)
              throw new Error("GitHub MCP boundary did not fail closed");
            const issueText = textContent(authorized.content);
            if (!issueText) throw new Error("authorized Issue was not returned over MCP");
            const issue: unknown = JSON.parse(issueText);
            if (
              typeof issue !== "object" ||
              issue === null ||
              !("title" in issue) ||
              typeof issue.title !== "string"
            ) {
              throw new Error("authorized Issue response had no title");
            }
            await request.onObservation?.({
              type: "tool_completed",
              tool: "unknown",
              outcome: "succeeded",
            });
            return sdkTurn(JSON.stringify({ status: "proposed", summary: issue.title }));
          } finally {
            await client.close();
          }
        });
      },
      {
        environment: { GITHUB_TOKEN: "worker-github-secret" },
        profileResolver: syntheticProfileResolver,
      },
    );
    try {
      const observation = await session.run({
        role: "implementer",
        workspace: ".",
        contract,
        prompt: "Use the configured GitHub read-only MCP server for the current Issue.",
        profile: "implementer-profile",
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 30_000,
        outputSchema: implementerOutputSchema,
        mcpServer: {
          name: "github_read",
          url: "http://fake-github-host.test/mcp?task=session-test",
          enabledTools: ["github_issue_get"],
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
          required: true,
        },
        execution: implementerExecution,
        environment: { GITHUB_TOKEN: "worker-github-secret" },
        onObservation: (event) => {
          observations.push(event);
        },
      });
      expect(observation).toMatchObject({
        status: "completed",
        output: { status: "proposed", summary: "Read-only MCP context" },
      });
      expect(host.calls.map(({ name }) => name)).toEqual([
        "github_issue_get",
        "github_issue_get",
        "github_issue_update",
      ]);
      expect(JSON.stringify(observation)).not.toContain("worker-github-secret");
      expect(JSON.stringify(observations)).not.toContain("worker-github-secret");
    } finally {
      await host.close();
    }
  });

  test("sanitizes MCP lifecycle observations and preserves unavailable fallback", async () => {
    const observations: unknown[] = [];
    const mcpItem = {
      type: "mcp_tool_call",
      id: "mcp-call",
      server: "github_read?token=host-secret",
      tool: "github_issue_get",
      status: "completed",
      arguments: { token: "host-secret" },
      result: {
        content: [{ type: "text", text: "private response" }],
        structured_content: { body: "private response" },
      },
    } satisfies ThreadItem;
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () => sdkTurn(JSON.stringify({ status: "proposed", summary: "ok" })),
          null,
          undefined,
          [mcpItem],
        ),
      {
        environment: {},
        profileResolver: syntheticProfileResolver,
        mcpServerFactory: async () => ({
          serverName: "github_read?token=host-secret",
          status: "unavailable",
          reason: "startup_timeout",
        }),
      },
    );
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      onObservation: (event) => {
        observations.push(event);
      },
    });
    expect(observation.status).toBe("completed");
    expect(observations).toContainEqual({
      type: "mcp_unavailable",
      server: "unknown",
      reason: "startup_timeout",
    });
    expect(observations).toContainEqual({
      type: "mcp_tool_completed",
      server: "unknown",
      tool: "github_issue_get",
      outcome: "succeeded",
    });
    expect(JSON.stringify(observations)).not.toContain("host-secret");
    expect(JSON.stringify(observations)).not.toContain("private response");
  });

  test("rejects an unusable profile before creating a Codex client", async () => {
    let created = false;
    const session = new CodexCodingSession(async () => {
      created = true;
      return testClient(async () => sdkTurn("{}"));
    });
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: " ",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
    });
    expect(created).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "codex_profile_unusable",
    });
  });

  test("rejects a well-formed named profile that is absent from the Codex home", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "usine-codex-home-"));
    const session = new CodexCodingSession(undefined, { environment: { CODEX_HOME: codexHome } });
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "missing-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "codex_profile_unusable",
    });
    expect(observation.failure).toContain("missing-profile");
  });

  test.each([
    ["missing model", 'model_reasoning_effort = "low"\n'],
    ["unsupported reasoning effort", 'model = "fixture-model"\nmodel_reasoning_effort = "ultra"\n'],
    ["disallowed features", 'model = "fixture-model"\nfeatures = { shell = true }\n'],
    ["blank developer instructions", 'model = "fixture-model"\ndeveloper_instructions = "   "\n'],
    ["non-string developer instructions", 'model = "fixture-model"\ndeveloper_instructions = 42\n'],
    ["malformed TOML", "model =\n"],
  ])("rejects %s profile configuration before provider work", async (_name, contents) => {
    const codexHome = await mkdtemp(join(tmpdir(), "usine-codex-profile-config-"));
    await writeFile(join(codexHome, "reviewer-profile.config.toml"), contents);
    const session = new CodexCodingSession(undefined, { environment: { CODEX_HOME: codexHome } });
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failureCode: "codex_profile_unusable",
    });
    expect(observation.failure).not.toContain("ultra");
  });

  test("passes only the portable worker environment", () => {
    const env = explicitWorkerEnvironment({
      OPENAI_API_KEY: "secret",
      USINE_ROLE_OUTPUT_API_KEY: "coordinator-secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      NPM_TOKEN: "package-secret",
      PATH: "/portable/bin",
      LANG: "C",
      CODEX_HOME: "codex-home-sentinel",
      USINE_CODEX_APP_SERVER_PROFILES: "host-private-app-server",
      USINE_OPENCODE2_PROFILES: "host-private-opencode2",
    });
    expect(env).toEqual({
      CI: "true",
      PATH: "/portable/bin",
      LANG: "C",
      CODEX_HOME: "codex-home-sentinel",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("USINE_ROLE_OUTPUT_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });

  test("maps SDK terminal output through the task-oriented port", async () => {
    let requestOptions: TurnOptions | undefined;
    let transformCalls = 0;
    const session = new CodexCodingSession(
      async () =>
        testClient(async (_prompt, options) => {
          requestOptions = options;
          return sdkTurn(JSON.stringify({ status: "proposed", summary: "done" }), {
            input_tokens: 12,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 7,
            reasoning_output_tokens: 3,
          });
        }, "opaque-thread"),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => {
          transformCalls += 1;
          return { status: "blocked", summary: "unexpected normalization" };
        },
      },
    );
    const observation = await session.run<{ status: string; summary: string }>({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      output: { status: "proposed" },
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(transformCalls).toBe(0);
    expect(requestOptions).toMatchObject({
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["proposed", "blocked"] },
          summary: { type: "string" },
        },
        required: ["status", "summary"],
        additionalProperties: false,
      },
    });
    expect(requestOptions).not.toHaveProperty("env");
  });

  test("accounts for a role-output normalizer as a separate invocation", async () => {
    const observations: CodingSessionObservation[] = [];
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () =>
            sdkTurn("provider prose", {
              input_tokens: 100,
              cached_input_tokens: 40,
              cache_write_input_tokens: 60,
              output_tokens: 7,
              reasoning_output_tokens: 3,
            }),
          "normalizer-provider-session",
        ),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async ({ onUsage }) => {
          await onUsage?.({
            semantics: "replacement",
            usage: {
              inputTokens: 5,
              cachedInputTokens: 2,
              uncachedInputTokens: 3,
              outputTokens: 2,
              reasoningOutputTokens: 1,
            },
          });
          return { status: "proposed", summary: "normalized" };
        },
      },
    );
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      onObservation: (event) => {
        observations.push(event);
      },
    });

    expect(observation).toMatchObject({
      status: "completed",
      output: { summary: "normalized" },
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        uncachedInputTokens: 0,
        cacheWriteInputTokens: 60,
        outputTokens: 7,
        reasoningOutputTokens: 3,
      },
      normalizer: {
        status: "succeeded",
        usage: {
          inputTokens: 5,
          cachedInputTokens: 2,
          uncachedInputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    });
    expect(observations.filter((event) => event.type === "usage_observed")).toEqual([
      {
        type: "usage_observed",
        source: "provider",
        semantics: "replacement",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 40,
          uncachedInputTokens: 0,
          cacheWriteInputTokens: 60,
          outputTokens: 7,
          reasoningOutputTokens: 3,
        },
      },
      {
        type: "usage_observed",
        source: "role_output_normalizer",
        semantics: "replacement",
        usage: {
          inputTokens: 5,
          cachedInputTokens: 2,
          uncachedInputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    ]);
  });

  test("normalizes one prose-wrapped reviewer response through the coordinator transform", async () => {
    const reviewer = {
      sha: "29122cf5c32a160d5ed6c6a7f68d61fc2c0c9117",
      verdict: "approved",
      summary: "The candidate satisfies the task contract.",
      findings: [],
    } as const;
    const finalResponse = [
      "The fresh review is complete.",
      "",
      "```json",
      JSON.stringify(reviewer),
      "```",
      "",
      "No further findings.",
    ].join("\n");
    let transformCalls = 0;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(finalResponse)),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async ({ finalResponse: response, outputSchema, signal }) => {
          transformCalls += 1;
          expect(response).toBe(finalResponse);
          expect(signal.aborted).toBe(false);
          return outputSchema.parse(reviewer);
        },
      },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(transformCalls).toBe(1);
    expect(observation).toMatchObject({
      status: "completed",
      output: reviewer,
      failure: null,
    });
  });

  test("uses chat completions for the schema-constrained production transform", async () => {
    const reviewer = {
      sha,
      verdict: "approved",
      summary: "ok",
      findings: [],
    } as const;
    const apiKey = "fixture-only-key";
    const model = "fixture-model";
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transform = createOpenAICompatibleRoleOutputTransform({
      apiKey,
      baseURL: "https://fixture.invalid/v1",
      model,
      fetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, init });
        return new Response(
          JSON.stringify({
            id: "fixture-completion",
            object: "chat.completion",
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(reviewer) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const output = await transform({
      finalResponse: "The review is wrapped in harmless prose.",
      outputSchema: reviewerOutputSchema,
      signal: new AbortController().signal,
    });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/v1/chat/completions");
    if (typeof requests[0].init?.body !== "string") throw new Error("expected JSON request body");
    const body = JSON.parse(requests[0].init.body) as Record<string, unknown>;
    expect(body.model).toBe(model);
    expect(body).toHaveProperty("response_format");
    expect(JSON.stringify(body)).toContain("findings");
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(output).toEqual(reviewer);
    expect(JSON.stringify(output)).not.toContain(apiKey);
  });

  test("propagates caller cancellation to the SDK turn", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let sdkSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(
      async () =>
        testClient(async (_prompt, options) => {
          sdkSignal = options?.signal;
          started.resolve();
          return new Promise<RunResult>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("SDK turn aborted")),
              {
                once: true,
              },
            );
          });
        }),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );
    const pending = session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const observation = await pending;
    expect(sdkSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({
      status: "cancelled",
      output: null,
      phase: "turn",
      failureClass: "cancellation",
    });
  });

  test("propagates caller cancellation to the bounded output transform", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let transformSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async ({ signal }) => {
          transformSignal = signal;
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("transform aborted")), {
              once: true,
            });
          });
        },
      },
    );
    const pending = session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const observation = await pending;
    expect(transformSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({
      status: "cancelled",
      output: null,
      phase: "output",
      failureClass: "cancellation",
    });
  });

  test("bounds the output transform by the remaining deadline", async () => {
    const started = deferred<void>();
    let transformSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async ({ signal }) => {
          transformSignal = signal;
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("transform timed out")), {
              once: true,
            });
          });
        },
      },
    );
    const pending = session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 250,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    await started.promise;
    const observation = await pending;
    expect(transformSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({
      status: "cancelled",
      output: null,
      phase: "output",
      failureClass: "timeout",
    });
  });

  test("preserves the deadline reserve before starting a provider", async () => {
    let started = false;
    const session = new CodexCodingSession(async () => {
      started = true;
      throw new Error("provider should not start");
    });
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 50,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(started).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failure: "elapsed budget exhausted",
      phase: "startup",
      failureClass: "timeout",
    });
  });

  test.each([
    ["network connection refused with secret", "network"],
    ["rate limit 429 from provider", "rate_limit"],
    ["request timed out", "timeout"],
    ["invalid profile configuration", "configuration"],
    ["permission denied by provider", "authority"],
    ["transport closed unexpectedly", "transport"],
    ["unclassified provider failure", "unknown"],
  ] as const)("projects provider failure %s as %s", async (message, failureClass) => {
    const session = new CodexCodingSession(
      async () => {
        throw new Error(`${message} raw-secret-marker`);
      },
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      phase: "startup",
      failureClass,
    });
    expect(JSON.stringify(observation)).not.toContain("raw-secret-marker");
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong status", JSON.stringify({ status: "finished", summary: "done" })],
    ["missing summary", JSON.stringify({ status: "proposed" })],
  ])("fails closed on implementer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(finalResponse)),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong verdict", JSON.stringify({ sha, verdict: "wrong", summary: "ok", findings: [] })],
    ["missing summary", JSON.stringify({ sha, verdict: "approved", findings: [] })],
    [
      "non-string finding",
      JSON.stringify({ sha, verdict: "approved", summary: "ok", findings: [7] }),
    ],
  ])("fails closed on reviewer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(finalResponse)),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test("accepts a bounded reviewer result at every role-result limit", async () => {
    const reviewer = {
      sha,
      verdict: "changes_requested" as const,
      summary: "s".repeat(ROLE_RESULT_LIMITS.summaryMaxLength),
      findings: Array.from({ length: ROLE_RESULT_LIMITS.findingMaxCount }, () =>
        "f".repeat(ROLE_RESULT_LIMITS.findingMaxLength),
      ),
    };
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(JSON.stringify(reviewer))),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({ status: "completed", output: reviewer });
  });

  test("rejects an excessive implementer summary at the Coding Session boundary", async () => {
    const session = new CodexCodingSession(
      async () =>
        testClient(async () =>
          sdkTurn(
            JSON.stringify({
              status: "proposed",
              summary: "s".repeat(ROLE_RESULT_LIMITS.summaryMaxLength + 1),
            }),
          ),
        ),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );

    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test.each([
    [
      "summary length",
      {
        summary: "s".repeat(ROLE_RESULT_LIMITS.summaryMaxLength + 1),
        findings: [],
      },
    ],
    [
      "finding count",
      {
        summary: "ok",
        findings: Array.from({ length: ROLE_RESULT_LIMITS.findingMaxCount + 1 }, () => "fix"),
      },
    ],
    [
      "finding length",
      {
        summary: "ok",
        findings: ["f".repeat(ROLE_RESULT_LIMITS.findingMaxLength + 1)],
      },
    ],
  ] as const)("rejects excessive reviewer %s from direct output", async (_name, fields) => {
    const reviewer = { sha, verdict: "approved" as const, ...fields };
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(JSON.stringify(reviewer))),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test("rejects an excessive normalized reviewer result at the Coding Session boundary", async () => {
    const reviewer = {
      sha,
      verdict: "approved" as const,
      summary: "s".repeat(ROLE_RESULT_LIMITS.summaryMaxLength + 1),
      findings: [],
    };
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("prose-wrapped review")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => reviewer,
      },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failureCode: "role_output_schema_invalid",
    });
  });

  test("fails explicitly when normalization is needed but unconfigured", async () => {
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review could not be represented directly.")),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test("fails closed when the transform returns a schema-invalid result", async () => {
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => ({ verdict: "approved" }),
      },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session normalized output did not match role schema",
      failureCode: "role_output_schema_invalid",
    });
  });

  test("fails closed and bounds transform failures without exposing their details", async () => {
    const secretDetail = "coordinator-transform-detail";
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => {
          throw new Error(secretDetail);
        },
      },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization failed",
      failureCode: "role_output_transform_failed",
    });
    expect(JSON.stringify(observation)).not.toContain(secretDetail);
  });

  test("classifies a provider failure from the role-output transform", async () => {
    const secretDetail = "rate limit 429 raw-secret-marker";
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => {
          throw new Error(secretDetail);
        },
      },
    );

    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      phase: "output",
      failureClass: "rate_limit",
      failureCode: "role_output_transform_failed",
    });
    expect(JSON.stringify(observation)).not.toContain(secretDetail);
  });

  test("persists a bounded sensitive archive behind an opaque session reference", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-"));
    const runtimePath = resolve(stateDirectory, "runtime-evidence");
    const completedCommand = {
      type: "command_execution",
      id: "command-1",
      command: `cat ${runtimePath}`,
      aggregated_output: `command output ${runtimePath}`,
      exit_code: 0,
      status: "completed",
    } as unknown as ThreadItem;
    const completedFileChange = {
      type: "file_change",
      id: "file-1",
      changes: [{ path: runtimePath, diff: `diff ${runtimePath}` }],
      status: "completed",
    } as unknown as ThreadItem;
    const completedTool = {
      type: "mcp_tool_call",
      id: "tool-1",
      server: "github_read?token=host-secret",
      tool: "github_issue_get",
      arguments: { issue: 285, path: runtimePath },
      result: {
        content: [{ type: "text", text: `tool output ${runtimePath}` }],
        structured_content: undefined,
      },
      status: "completed",
    } satisfies ThreadItem;
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () =>
            sdkTurn(JSON.stringify({ status: "proposed", summary: "done" }), {
              input_tokens: 12,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 7,
              reasoning_output_tokens: 0,
            }),
          "opaque-thread",
          undefined,
          [completedCommand, completedFileChange, completedTool],
        ),
      {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
      },
    );

    const observation = await session.run({
      role: "implementer",
      workspace: runtimePath,
      contract,
      prompt: "sensitive prompt",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
    });

    expect(observation).toMatchObject({
      status: "completed",
      archiveStatus: "stored",
      archiveId: expect.stringMatching(/^archive_[0-9a-f-]+$/),
    });
    expect("sessionId" in observation).toBe(false);
    expect(JSON.stringify(observation)).not.toContain("sensitive prompt");
    const archive = completeArchive(
      await readSessionArchive(stateDirectory, observation.archiveId!),
    );
    expect(archive).toMatchObject({
      schemaVersion: 1,
      taskId: "session-test",
      role: "implementer",
      attempt: "1",
      prompt: "sensitive prompt",
      rawFinalResponse: JSON.stringify({ status: "proposed", summary: "done" }),
      normalizedOutput: { status: "proposed", summary: "done" },
      usage: { inputTokens: 12, outputTokens: 7 },
      sessionId: "opaque-thread",
      status: "completed",
      completeness: "complete",
      profile: {
        name: "implementer-profile",
        model: "implementer-model",
        modelReasoningEffort: "low",
        developerInstructions: "Implementer role instruction: implement the frozen task contract.",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(archive.items).toContainEqual(
      expect.objectContaining({
        type: "mcp_tool_call",
        id: "tool-1",
        arguments: { issue: 285, path: runtimePath },
        output: { content: [{ type: "text", text: `tool output ${runtimePath}` }] },
      }),
    );
    expect(JSON.stringify(archive)).not.toContain("host-secret");
    expect(JSON.stringify(archive)).toContain(runtimePath);

    await expect(
      readSessionArchiveManifest(stateDirectory, observation.archiveId!),
    ).resolves.toEqual(
      expect.objectContaining({
        archiveId: observation.archiveId,
        taskId: "session-test",
        role: "implementer",
        status: "completed",
      }),
    );
    await expect(listSessionArchives(stateDirectory, "session-test")).resolves.toHaveLength(1);
  });

  test("keeps the role result unchanged when archive persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-session-archive-write-failure-"));
    const stateDirectory = join(root, "not-a-directory");
    await writeFile(stateDirectory, "occupied");
    const session = new CodexCodingSession(
      async () =>
        testClient(
          async () => sdkTurn(JSON.stringify({ status: "proposed", summary: "ok" })),
          "thread-write-failure",
        ),
      {
        environment: { CI: "true" },
        profileResolver: syntheticProfileResolver,
        sessionArchive: { stateDirectory },
      },
    );

    await expect(
      session.run({
        role: "implementer",
        workspace: ".",
        contract,
        prompt: "work",
        profile: "implementer-profile",
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: implementerOutputSchema,
        execution: implementerExecution,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { status: "proposed", summary: "ok" },
      archiveStatus: "failed",
    });
  });

  test("keeps an undefined normalizer as a complete, decodable schema-invalid archive", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-undefined-output-"));
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("provider response"), "undefined-output-thread"),
      {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => undefined,
      },
    );
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "undefined normalizer",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });

    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "role_output_schema_invalid",
      archiveStatus: "stored",
    });
    const archive = completeArchive(
      await readSessionArchive(stateDirectory, observation.archiveId!),
    );
    expect(archive).toMatchObject({
      rawFinalResponse: "provider response",
      normalizedOutput: null,
      completeness: "complete",
      captureStatus: "stored",
    });
  });

  test("keeps non-JSON provider evidence and normalized output non-authoritative", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-non-json-"));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const nonJsonItem = {
      type: "command_execution",
      id: "non-json-command",
      aggregated_output: circular,
      status: "completed",
    } as unknown as ThreadItem;
    const session = new CodexCodingSession(
      async () =>
        testClient(async () => sdkTurn("provider response"), "non-json-thread", undefined, [
          nonJsonItem,
        ]),
      {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
        roleOutputTransform: async () => circular,
      },
    );
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "non-json capture",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });

    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "role_output_schema_invalid",
      archiveStatus: "stored",
    });
    const archive = completeArchive(
      await readSessionArchive(stateDirectory, observation.archiveId!),
    );
    expect(archive).toMatchObject({
      completeness: "complete",
      normalizedOutput: null,
      captureStatus: "stored",
    });
    expect(archive.items).toContainEqual(
      expect.objectContaining({ type: "command_execution", id: "non-json-command" }),
    );
  });

  test("substitutes bounded peer adapters while the facade archives neutral evidence", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-adapter-seam-"));
    const calls: Array<
      Pick<
        CodingSessionAdapterRequest,
        "profile" | "mcpServer" | "sandbox" | "outputSchema" | "signal" | "environment"
      >
    > = [];
    const observations: CodingSessionObservation[] = [];
    const makeAdapter = (name: CodingSessionAdapter["name"]): CodingSessionAdapter => ({
      name,
      run: async (context) => {
        calls.push({
          profile: context.profile,
          mcpServer: context.mcpServer,
          sandbox: context.sandbox,
          outputSchema: context.outputSchema,
          signal: context.signal,
          environment: context.environment,
        });
        await context.onObservation?.({ type: "thread_started" });
        await context.onObservation?.({ type: "turn_started", turn: 1 });
        context.onSessionId?.(`${name}-session`);
        context.onPhase?.("turn");
        await context.onItemCompleted?.({
          type: "mcp_tool_call",
          id: `${name}-tool`,
          server: "github_read",
          tool: "github_issue_get",
          arguments: { issue: 285 },
          output: { ok: true },
          status: "completed",
        });
        await context.onUsage?.({
          semantics: "delta",
          usage: { inputTokens: 3, outputTokens: 4 },
        });
        return {
          finalResponse:
            name === "sdk"
              ? JSON.stringify({ status: "proposed", summary: "adapter" })
              : JSON.stringify({ sha, verdict: "approved", summary: "adapter", findings: [] }),
          usage: { inputTokens: 1, outputTokens: 2 },
          sessionId: `${name}-session`,
        };
      },
    });
    const session = createCodexCodingSessionForTesting(
      undefined,
      {
        environment: {
          CI: "true",
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
          USINE_OPENCODE2_PROFILES: "opencode-profile",
        },
        adapterSelectionEnvironment: {
          USINE_CODEX_APP_SERVER_PROFILES: "reviewer-profile",
          USINE_OPENCODE2_PROFILES: "opencode-profile",
        },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
      },
      {
        sdk: makeAdapter("sdk"),
        "app-server": makeAdapter("app-server"),
        opencode2: makeAdapter("opencode2"),
      },
    );

    await expect(
      session.run({
        role: "implementer",
        workspace: ".",
        contract,
        prompt: "implement",
        profile: "implementer-profile",
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: implementerOutputSchema,
        mcpServer: {
          name: "github_read",
          url: "https://github.example.test/mcp",
          enabledTools: ["github_issue_get"],
          startupTimeoutMs: 5_000,
          toolTimeoutMs: 5_000,
          required: true,
        },
        execution: implementerExecution,
        onObservation: (observation) => {
          observations.push(observation);
        },
      }),
    ).resolves.toMatchObject({ status: "completed", output: { status: "proposed" } });
    await expect(
      session.run({
        role: "reviewer",
        workspace: ".",
        contract,
        prompt: "review",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
        onObservation: (observation) => {
          observations.push(observation);
        },
      }),
    ).resolves.toMatchObject({ status: "completed", output: { verdict: "approved" } });
    await expect(
      session.run({
        role: "reviewer",
        workspace: ".",
        contract,
        prompt: "review with OpenCode2",
        profile: "opencode-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: opencodeExecution,
        onObservation: (observation) => {
          observations.push(observation);
        },
      }),
    ).resolves.toMatchObject({ status: "completed", output: { verdict: "approved" } });

    expect(calls.map(({ profile, sandbox }) => ({ profile, sandbox }))).toEqual([
      {
        profile: {
          model: "implementer-model",
          reasoningEffort: "low",
          developerInstructions:
            "Implementer role instruction: implement the frozen task contract.",
        },
        sandbox: "workspace-write",
      },
      {
        profile: {
          model: "reviewer-model",
          reasoningEffort: "high",
          developerInstructions: "Reviewer role instruction: inspect the candidate independently.",
        },
        sandbox: "read-only",
      },
      {
        profile: {
          model: "implementer-model",
          reasoningEffort: "low",
          developerInstructions:
            "Implementer role instruction: implement the frozen task contract.",
        },
        sandbox: "read-only",
      },
    ]);
    expect(calls[0]?.mcpServer).toEqual({
      name: "github_read",
      url: "https://github.example.test/mcp",
      enabledTools: ["github_issue_get"],
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      required: true,
    });
    expect(calls[1]?.mcpServer).toBeUndefined();
    expect(calls[2]?.mcpServer).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain("approval_policy");
    expect(JSON.stringify(calls)).not.toContain("mcp_servers");
    expect(JSON.stringify(calls)).not.toContain("model_reasoning_effort");
    expect(JSON.stringify(calls)).not.toContain("developer_instructions");
    expect(calls.map(({ outputSchema }) => outputSchema)).toEqual([
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          summary: { type: "string", maxLength: ROLE_RESULT_LIMITS.summaryMaxLength },
        }),
      }),
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          summary: { type: "string", maxLength: ROLE_RESULT_LIMITS.summaryMaxLength },
          findings: {
            type: "array",
            maxItems: ROLE_RESULT_LIMITS.findingMaxCount,
            items: { type: "string", maxLength: ROLE_RESULT_LIMITS.findingMaxLength },
          },
        }),
      }),
      expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          summary: { type: "string", maxLength: ROLE_RESULT_LIMITS.summaryMaxLength },
          findings: {
            type: "array",
            maxItems: ROLE_RESULT_LIMITS.findingMaxCount,
            items: { type: "string", maxLength: ROLE_RESULT_LIMITS.findingMaxLength },
          },
        }),
      }),
    ]);
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(calls.every(({ environment }) => environment.CI === "true")).toBe(true);
    expect(
      calls.every(
        ({ environment }) =>
          environment.USINE_CODEX_APP_SERVER_PROFILES === undefined &&
          environment.USINE_OPENCODE2_PROFILES === undefined,
      ),
    ).toBe(true);
    expect(observations).toEqual([
      { type: "thread_started" },
      { type: "turn_started", turn: 1 },
      {
        type: "mcp_tool_completed",
        server: "github_read",
        tool: "github_issue_get",
        outcome: "succeeded",
      },
      {
        type: "usage_observed",
        source: "provider",
        semantics: "delta",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
      { type: "thread_started" },
      { type: "turn_started", turn: 1 },
      {
        type: "mcp_tool_completed",
        server: "github_read",
        tool: "github_issue_get",
        outcome: "succeeded",
      },
      {
        type: "usage_observed",
        source: "provider",
        semantics: "delta",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
      { type: "thread_started" },
      { type: "turn_started", turn: 1 },
      {
        type: "mcp_tool_completed",
        server: "github_read",
        tool: "github_issue_get",
        outcome: "succeeded",
      },
      {
        type: "usage_observed",
        source: "provider",
        semantics: "delta",
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ]);
    const archives = await listSessionArchives(stateDirectory, contract.id);
    expect(archives).toHaveLength(3);
    const archiveAdapters = new Set<string>();
    for (const manifest of archives) {
      const archive = completeArchive(await readSessionArchive(stateDirectory, manifest.archiveId));
      archiveAdapters.add(archive.adapter ?? "");
      expect(archive.items).toEqual([
        expect.objectContaining({ type: "mcp_tool_call", server: "github_read" }),
      ]);
      expect(archive.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
      expect(JSON.stringify(archive)).not.toContain("commandExecution");
      expect(JSON.stringify(archive)).not.toContain("mcpToolCall");
    }
    expect(archiveAdapters).toEqual(new Set(["sdk", "app-server", "opencode2"]));
  });

  test.each(["provider failure", "cancellation", "schema-invalid"] as const)(
    "leaves a retrievable archive after %s",
    async (mode) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-outcome-"));
      const session = new CodexCodingSession(
        mode === "provider failure"
          ? async () => {
              throw new Error("network connection refused");
            }
          : async () =>
              testClient(async () => sdkTurn(mode === "schema-invalid" ? "not an output" : "{}")),
        {
          environment: { CI: "true" },
          executionStateDirectory: stateDirectory,
          profileResolver: syntheticProfileResolver,
        },
      );
      const controller = new AbortController();
      if (mode === "cancellation") controller.abort();
      const observation = await session.run({
        role: "reviewer",
        workspace: ".",
        contract,
        prompt: "outcome prompt",
        profile: "reviewer-profile",
        sandbox: "read-only",
        deadlineEpochMs: Date.now() + 10_000,
        outputSchema: reviewerOutputSchema,
        execution: reviewerExecution,
        signal: controller.signal,
      });

      expect(observation.archiveId).toMatch(/^archive_[0-9a-f-]+$/);
      expect(observation.archiveStatus).toBe("stored");
      const archive = completeArchive(
        await readSessionArchive(stateDirectory, observation.archiveId!),
      );
      expect(archive.status).toBe(mode === "cancellation" ? "cancelled" : "failed");
      expect(archive.prompt).toBe("outcome prompt");
      expect(archive.completeness).toBe(mode === "schema-invalid" ? "complete" : "partial");
      if (mode === "schema-invalid") expect(archive.rawFinalResponse).toBe("not an output");
    },
  );
});
