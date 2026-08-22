import { access, chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type CodingSessionMcpServer,
  type CodingSessionObservation,
  codexAppServerProfilesFromEnvironment,
  codexMcpConfig,
  createOpenAICompatibleRoleOutputTransform,
  createCodexLauncher,
  discoverOwnedExecutions,
  executionLifecycle,
  explicitWorkerEnvironment,
  implementerOutputSchema,
  codexExecutionIdentityPath,
  removeCodexExecutionIdentity,
  reviewerOutputSchema,
  type CodexProfileResolver,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";
import { z } from "zod";

const sha = "a".repeat(40);
const contract = { id: "session-test" } as TaskContract;
const implementerExecution = { taskId: contract.id, role: "implementer" as const, attempt: "1" };
const reviewerExecution = { taskId: contract.id, role: "reviewer" as const, attempt: "1-a" };
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

function observeExecutionPollSchedule(): {
  scheduled: Promise<void>;
  restore: () => void;
} {
  const scheduled = deferred<void>();
  const schedule = globalThis.setTimeout;
  const timerSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((handler, timeout, ...args) => {
      if (timeout === 10) scheduled.resolve();
      return schedule(handler, timeout, ...args);
    });
  return { scheduled: scheduled.promise, restore: () => timerSpy.mockRestore() };
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
): Promise<{ environment: NodeJS.ProcessEnv; stateDirectory: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "usine-app-server-"));
  const bin = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const stateDirectory = join(root, "state");
  await mkdir(join(stateDirectory, "reviewer"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "fixture-mode"), `${mode}\n`);
  await writeFile(
    join(codexHome, "reviewer-profile.config.toml"),
    'model = "fixture-model"\nmodel_reasoning_effort = "minimal"\ndeveloper_instructions = "Fixture reviewer instructions"\n',
  );
  const executable = join(bin, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const mode = readFileSync(process.env.CODEX_HOME + "/fixture-mode", "utf8").trim();
const expectedMcpConfig = ${JSON.stringify(expectedMcpConfig)};
const expectedModel = ${JSON.stringify(expectedModel)};
const expectedReasoning = ${JSON.stringify(expectedReasoning)};
const expectedDeveloperInstructions = ${JSON.stringify(expectedDeveloperInstructions)};
if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected Codex transport arguments\\n");
  process.exit(2);
}
if (mode === "stderr") {
  process.stderr.write("profile configuration failed secret=should-not-escape\\n");
  process.exit(1);
}
let buffer = "";
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
  send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "mcpToolCall", id: "mcp-fixture", server: "github_read?token=host-secret", tool: "github_issue_get?token=host-secret", status: "completed" } } });
  send({ method: "item/completed", params: { threadId: "thread-fixture", turnId: "turn-fixture", item: { type: "agentMessage", id: "message-fixture", text: output } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-fixture", turnId: "turn-fixture", tokenUsage: { last: { inputTokens: 7, outputTokens: 9 } } } });
  send({ method: "turn/completed", params: { threadId: mode === "mismatch" ? "wrong-thread" : "thread-fixture", turn: { id: "turn-fixture", status: "completed", error: null } } });
};
const handle = (message) => {
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
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: "turn-fixture", status: "interrupted", error: null } } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\\n").slice(0, -1)) handle(JSON.parse(line));
  buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
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
    close: async () => undefined,
  };
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

  test("keeps role sandboxes local while the launcher forwards transport argv", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-profile-"));
    const implementer = await createCodexLauncher(
      stateDirectory,
      "fixtures/writer",
      implementerExecution,
    );
    const reviewer = await createCodexLauncher(
      stateDirectory,
      "fixtures/reviewer",
      reviewerExecution,
    );
    for (const launcher of [implementer, reviewer]) {
      const source = await readFile(launcher.launcherPath, "utf8");
      expect(source).toContain('spawn("codex", [...process.argv.slice(2)]');
      expect(source).not.toContain("--profile");
    }

    const sandboxes: string[] = [];
    const session = new CodexCodingSession(
      async (request) =>
        testClient(
          async () => sdkTurn(JSON.stringify({ status: "proposed", summary: request.profile })),
          request.profile,
          (options) => sandboxes.push(String(options.sandboxMode)),
        ),
      { environment: { CI: "true" }, profileResolver: syntheticProfileResolver },
    );
    await session.run({
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
    await session.run({
      role: "reviewer",
      workspace: "fixtures/reviewer",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(sandboxes).toEqual(["workspace-write", "read-only"]);
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
        appServerProfiles: ["reviewer-profile"],
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
      sessionId: "sdk-thread",
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
      sessionId: "thread-fixture",
      output: { verdict: "approved", summary: "app-server" },
    });
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
        appServerProfiles: ["reviewer-profile"],
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

  test("normalizes the static app-server profile selection from host environment", () => {
    expect(
      codexAppServerProfilesFromEnvironment({
        USINE_CODEX_APP_SERVER_PROFILES: " reviewer-profile,writer-profile,reviewer-profile ",
      }),
    ).toEqual(["reviewer-profile", "writer-profile"]);
    expect(() =>
      codexAppServerProfilesFromEnvironment({
        USINE_CODEX_APP_SERVER_PROFILES: "reviewer profile",
      }),
    ).toThrow("Codex profile is unusable");
  });

  test("executes an app-server reviewer through the shared typed lifecycle and reaps its process", async () => {
    const mcpServer: CodingSessionMcpServer = {
      name: "github_read",
      url: "https://github.example.test/mcp?task=session-test",
      enabledTools: ["github_issue_get", "github_pull_request_reviews"],
      startupTimeoutMs: 4_000,
      toolTimeoutMs: 7_000,
      required: true,
    };
    const fixture = await fakeAppServerEnvironment("success", codexMcpConfig(mcpServer));
    const observations: CodingSessionObservation[] = [];
    const finalObservationEntered = deferred<void>();
    const releaseFinalObservation = deferred<void>();
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
    expect(observations).toHaveLength(5);
    releaseFinalObservation.resolve();
    const observation = await pending;
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "thread-fixture",
      output: { verdict: "approved", summary: "app-server" },
      usage: { inputTokens: 7, outputTokens: 9 },
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
      { type: "turn_completed", turn: 1, outcome: "succeeded" },
    ]);
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test("interrupts an app-server turn and truthfully reaps the exact owned process", async () => {
    const fixture = await fakeAppServerEnvironment("interrupt");
    const controller = new AbortController();
    const started = deferred<void>();
    const observations: CodingSessionObservation[] = [];
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
    const observationCount = observations.length;
    await Promise.resolve();
    expect(observations).toHaveLength(observationCount);
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test("applies the shared schema-invalid terminal output behavior to app-server", async () => {
    const fixture = await fakeAppServerEnvironment("schema-invalid");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test("cancels an app-server startup at its shared deadline", async () => {
    const fixture = await fakeAppServerEnvironment("wait");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
    await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test.each(["malformed", "transport", "capability"] as const)(
    "fails closed on app-server %s without starting a replacement",
    async (mode) => {
      const fixture = await fakeAppServerEnvironment(mode);
      const session = new CodexCodingSession(undefined, {
        environment: fixture.environment,
        executionStateDirectory: fixture.stateDirectory,
        appServerProfiles: ["reviewer-profile"],
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
      await expect(discoverOwnedExecutions(fixture.stateDirectory, contract.id)).resolves.toEqual(
        [],
      );
    },
  );

  test("classifies bounded app-server stderr without exposing its contents", async () => {
    const fixture = await fakeAppServerEnvironment("stderr");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
  });

  test("keeps an App Server thread-start failure out of the turn phase", async () => {
    const fixture = await fakeAppServerEnvironment("thread-failure");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
  });

  test("fails closed on an app-server identity mismatch and does not retry", async () => {
    const fixture = await fakeAppServerEnvironment("mismatch");
    const session = new CodexCodingSession(undefined, {
      environment: fixture.environment,
      executionStateDirectory: fixture.stateDirectory,
      appServerProfiles: ["reviewer-profile"],
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
      .parse(JSON.parse(JSON.stringify(codexMcpConfig(server))));
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
      expect(() => codexMcpConfig(invalidServer)).toThrow();
  });

  test("reads the admitted Issue through read-only MCP without giving the worker credentials", async () => {
    const host = await startFakeGithubHost();
    const observations: unknown[] = [];
    const session = new CodexCodingSession(
      async (request) => {
        if (!request.mcpServer) throw new Error("GitHub read MCP server is missing");
        const config = codexMcpConfig(request.mcpServer);
        expect(JSON.stringify(config)).not.toContain("worker-github-secret");
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
      sessionId: "opaque-thread",
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

  test("reaps the exact process when cancellation crosses launcher ownership recording", async () => {
    vi.useFakeTimers();
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-starting-cancellation-"));
    const launcher = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "writer"),
      implementerExecution,
    );
    const controller = new AbortController();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Codex child has no PID");
    const session = new CodexCodingSession(
      async () => {
        controller.abort();
        return testClient(async (_prompt, options) => {
          if (options?.signal?.aborted) throw new Error("SDK turn aborted");
          return new Promise<RunResult>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("SDK turn aborted")),
              { once: true },
            );
          });
        });
      },
      {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
      },
    );

    const executionPoll = observeExecutionPollSchedule();
    const pending = session.run({
      role: "implementer",
      workspace: join(stateDirectory, "writer"),
      contract,
      prompt: "work",
      profile: "writer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    try {
      await executionPoll.scheduled;
      const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
        encoding: "utf8",
      }).trim();
      await writeFile(
        launcher.identityPath,
        JSON.stringify({
          version: 2,
          state: "running",
          reference: implementerExecution,
          pid: child.pid,
          startedAt,
          workspace: join(stateDirectory, "writer"),
        }) + "\n",
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({
        status: "cancelled",
        output: null,
      });
      await expect(discoverOwnedExecutions(stateDirectory, contract.id)).resolves.toEqual([]);
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The shared termination transition may already have removed the group.
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      executionPoll.restore();
      vi.useRealTimers();
    }
  });

  test("fails closed after a bounded starting wait and retains ownership evidence", async () => {
    vi.useFakeTimers();
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-starting-timeout-"));
    const launcher = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "writer"),
      implementerExecution,
    );
    const controller = new AbortController();
    const providerStarted = deferred<void>();
    const session = new CodexCodingSession(
      async () => {
        providerStarted.resolve();
        controller.abort();
        return testClient(async (_prompt, options) => {
          if (options?.signal?.aborted) throw new Error("SDK turn aborted");
          return new Promise<RunResult>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("SDK turn aborted")),
              { once: true },
            );
          });
        });
      },
      {
        environment: { CI: "true" },
        executionStateDirectory: stateDirectory,
        profileResolver: syntheticProfileResolver,
      },
    );

    const executionPoll = observeExecutionPollSchedule();
    const pending = session.run({
      role: "implementer",
      workspace: join(stateDirectory, "writer"),
      contract,
      prompt: "work",
      profile: "writer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      execution: implementerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    try {
      await providerStarted.promise;
      await executionPoll.scheduled;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).rejects.toMatchObject({
        code: "codex_execution_ownership_error",
        reason: "incomplete",
      });
      await expect(readFile(launcher.identityPath, "utf8")).resolves.toContain(
        '"state":"starting"',
      );
      await expect(readFile(launcher.launcherPath, "utf8")).resolves.toContain(
        "const child = spawn",
      );
    } finally {
      executionPoll.restore();
      vi.useRealTimers();
    }
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
});
