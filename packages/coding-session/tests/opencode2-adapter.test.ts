import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { readSessionArchive, reviewerOutputSchema } from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";
import type { CodingSessionAdapterRequest } from "../src/coding-session-adapter.js";
import type { ProviderNeutralCompletedEvidence } from "../src/coding-session-adapter.js";
import { CodexCodingSession, createCodexCodingSessionForTesting } from "../src/coding-session.js";
import { executionIdentityPath, discoverOwnedExecutions } from "../src/codex-execution.js";
import { OpenCode2Adapter, opencodeConfig } from "../src/opencode2-adapter.js";
import {
  DarwinOpenCode2Sandbox,
  resolveExecutable,
  runProbe,
  sandboxProfile,
  type OpenCode2Sandbox,
} from "../src/opencode2-sandbox.js";
import { normalizeCodexProfileSelection } from "../src/codex-profile.js";

const execution = { taskId: "opencode2-test", role: "reviewer" as const, attempt: "1" };
const facadeContract = {
  id: execution.taskId,
  repositoryId: "fixture-repository",
  baseSha: "a".repeat(40),
  instructions: "review fixture",
  acceptance: ["return the fixture review"],
  nonGoals: [],
  budget: {
    maxImplementerActivations: 1,
    maxReviewCycles: 1,
    maxElapsedMs: 5_000,
  },
  authorization: {
    source: "https://github.com/usine/fixture/issues/292",
    delivery: true,
  },
  delivery: {
    branch: "fixture-review",
    issue: 292,
    title: "Fixture review",
    body: "Fixture review contract",
  },
} satisfies TaskContract;
const launchRecordSchema = z.object({ processId: z.number().int().positive() });

function fixtureAdapter(): OpenCode2Adapter {
  const sandbox: OpenCode2Sandbox = {
    prepare: async ({ role }) => ({
      launch: { command: "opencode", args: [] },
      evidence: {
        host: "darwin-seatbelt",
        role,
        workspaceRead: "verified",
        workspaceWrite: role === "implementer" ? "verified" : "denied",
        externalRead: "denied",
        externalWrite: "denied",
        subprocess: "inherited",
      },
    }),
  };
  return new OpenCode2Adapter(sandbox);
}

async function fixture(
  mode:
    | "success"
    | "malformed"
    | "wait"
    | "prompt-failure"
    | "startup-failure"
    | "startup-abort"
    | "no-response"
    | "out-of-order"
    | "step-failure"
    | "permission-ask",
  finalResponse = '{"verdict":"approved"}',
): Promise<{
  environment: Record<string, string>;
  stateDirectory: string;
  workspace: string;
  protocolLog: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "usine-opencode2-"));
  const bin = join(root, "bin");
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  const hostileHome = join(root, "hostile-home");
  const hostileConfigDirectory = join(hostileHome, ".config", "opencode");
  const protocolLog = join(root, "protocol.jsonl");
  await mkdir(bin, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(hostileConfigDirectory, { recursive: true });
  await writeFile(protocolLog, "");
  await writeFile(
    join(workspace, "opencode.json"),
    JSON.stringify({
      plugin: ["hostile-project-plugin"],
      agent: { usine: { prompt: "hostile-project" } },
    }),
  );
  await writeFile(
    join(hostileConfigDirectory, "opencode.json"),
    JSON.stringify({
      plugin: ["hostile-global-plugin"],
      agent: { usine: { prompt: "hostile-global" } },
    }),
  );
  await writeFile(
    join(bin, "opencode"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "serve" || !args.includes("--hostname=127.0.0.1")) process.exit(2);
const port = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
if (!Number.isSafeInteger(port)) process.exit(3);
appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({
  args,
  processId: process.pid,
  environment: {
    PATH: process.env.PATH,
    CI: process.env.CI,
    SECRET: process.env.SECRET,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE,
    OPENCODE_DISABLE_SHARE: process.env.OPENCODE_DISABLE_SHARE,
  },
  projectConfigPresent: true,
  hostileConfigPresent: process.env.OPENCODE_CONFIG_DIR?.includes("hostile") ?? false,
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null"),
}) + "\\n");
if (${JSON.stringify(mode)} === "startup-failure") process.exit(17);
let eventResponse;
let globalEventResponse;
let waitResponse;
let idle = false;
const pendingEvents = [];
const pendingGlobalEvents = [];
let prompted = false;
const readBody = (req) => new Promise((resolve) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => resolve(body));
});
const writeEvent = (event) => {
  if (!eventResponse) {
    pendingEvents.push(event);
    return;
  }
  eventResponse.write("data: " + JSON.stringify(JSON.stringify(event)) + "\\n\\n");
};
const writeGlobalEvent = (event) => {
  if (!globalEventResponse) {
    pendingGlobalEvents.push(event);
    return;
  }
  globalEventResponse.write("data: " + JSON.stringify(event) + "\\n\\n");
};
const response = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/health") {
    if (${JSON.stringify(mode)} === "startup-abort") return;
    return response(res, 200, { healthy: true });
  }
  if (req.method === "GET" && url.pathname === "/api/session/session-fixture/event") {
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ sessionEventsConnected: true }) + "\\n");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    eventResponse = res;
    for (const event of pendingEvents.splice(0)) writeEvent(event);
    if (${JSON.stringify(mode)} === "prompt-failure") return res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/event") {
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ globalEventsConnected: true }) + "\\n");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    globalEventResponse = res;
    for (const event of pendingGlobalEvents.splice(0)) writeGlobalEvent(event);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    return readBody(req).then((body) => {
      appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ sessionCreate: JSON.parse(body) }) + "\\n");
      return response(res, 200, { data: { id: "session-fixture", projectID: "project-fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() }, title: "fixture", location: { directory: ${JSON.stringify(workspace)} } } });
    });
  }
  if (req.method === "POST" && url.pathname === "/api/session/session-fixture/prompt") {
    prompted = true;
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ prompt: true }) + "\\n");
    if (${JSON.stringify(mode)} === "prompt-failure")
      return response(res, 500, { message: "prompt admission failed" });
    response(res, 200, { data: { admittedSeq: 1, id: "input-fixture", sessionID: "session-fixture", prompt: { text: "fixture" }, delivery: "queue", timeCreated: Date.now() } });
    if (${JSON.stringify(mode)} === "wait") return;
    setImmediate(() => {
      if (${JSON.stringify(mode)} === "out-of-order")
        writeEvent({ id: "early-text", type: "session.next.text.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture", textID: "text-fixture", text: ${JSON.stringify(finalResponse)} } });
      writeEvent({ id: "admitted", type: "session.next.prompt.admitted", data: { sessionID: "session-fixture", messageID: "message-fixture", prompt: { text: "fixture" }, delivery: "queue" } });
      if (${JSON.stringify(mode)} === "permission-ask") {
        writeGlobalEvent({ id: "permission-event-fixture", type: "permission.v2.asked", properties: { id: "permission-fixture", sessionID: "session-fixture", action: "external_directory", resources: ["/outside"] } });
        return;
      }
      if (${JSON.stringify(mode)} === "malformed")
        writeEvent({ id: "wrong", type: "session.next.text.ended", data: { sessionID: "wrong-session", assistantMessageID: "message-fixture", textID: "text-fixture", text: "{}" } });
      else if (${JSON.stringify(mode)} !== "success")
        writeEvent({ id: "shell", type: "session.next.shell.ended", data: { sessionID: "session-fixture", callID: "shell-fixture", output: "done" } });
      if (${JSON.stringify(mode)} === "success") {
        writeEvent({ id: "step-started-1", type: "session.next.step.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", agent: "usine", model: { providerID: "fixture-provider", id: "fixture-model" } } });
        writeEvent({ id: "shell-started", type: "session.next.shell.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "shell-fixture", command: "printf done" } });
        writeEvent({ id: "shell", type: "session.next.shell.ended", data: { sessionID: "session-fixture", callID: "shell-fixture", output: "done" } });
        writeEvent({ id: "tool-input-started", type: "session.next.tool.input.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "tool-fixture", name: "github_issue_get" } });
        writeEvent({ id: "tool-input-ended", type: "session.next.tool.input.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "tool-fixture", text: "{\\"issue\\":292}" } });
        writeEvent({ id: "tool-called", type: "session.next.tool.called", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "tool-fixture", tool: "github_issue_get", input: { issue: 292 }, provider: { executed: true } } });
        writeEvent({ id: "tool-progress", type: "session.next.tool.progress", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "tool-fixture", structured: { phase: "lookup" }, content: [] } });
        writeEvent({ id: "tool", type: "session.next.tool.success", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", callID: "tool-fixture", structured: {}, content: [], result: { ok: true }, provider: { executed: true } } });
        writeEvent({ id: "step-1", type: "session.next.step.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-1", finish: "tool-calls", cost: 0, tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } } });
        writeEvent({ id: "step-started-2", type: "session.next.step.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", agent: "usine", model: { providerID: "fixture-provider", id: "fixture-model" } } });
        writeEvent({ id: "reasoning-started", type: "session.next.reasoning.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", reasoningID: "reasoning-fixture" } });
        writeEvent({ id: "reasoning", type: "session.next.reasoning.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", reasoningID: "reasoning-fixture", text: "checking" } });
        writeEvent({ id: "text-started-2", type: "session.next.text.started", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", textID: "text-fixture-2" } });
        writeEvent({ id: "text-2", type: "session.next.text.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", textID: "text-fixture-2", text: ${JSON.stringify(finalResponse)} } });
        writeEvent({ id: "step-2", type: "session.next.step.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture-2", finish: "stop", cost: 0, tokens: { input: 11, output: 13, reasoning: 0, cache: { read: 0, write: 0 } } } });
      }
      if (${JSON.stringify(mode)} === "no-response")
        writeEvent({ id: "step-without-text", type: "session.next.step.ended", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture", finish: "stop", cost: 0, tokens: { input: 11, output: 13, reasoning: 0, cache: { read: 0, write: 0 } } } });
      if (${JSON.stringify(mode)} === "step-failure")
        writeEvent({ id: "step-failure", type: "session.next.step.failed", data: { sessionID: "session-fixture", assistantMessageID: "message-fixture", error: { name: "HostSecretProviderError", message: "private provider details" } } });
      if (${JSON.stringify(mode)} !== "wait" && ${JSON.stringify(mode)} !== "prompt-failure") {
        idle = true;
        if (waitResponse) { response(waitResponse, 204); waitResponse = undefined; }
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session/session-fixture/interrupt") {
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ interrupted: true }) + "\\n");
    response(res, 204);
    if (waitResponse) {
      response(waitResponse, 204);
      waitResponse = undefined;
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session/session-fixture/permission/permission-fixture/reply") {
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ permissionReply: true }) + "\\n");
    return response(res, 204);
  }
  if (req.method === "GET" && url.pathname === "/api/session/session-fixture/status") return response(res, 200, { data: prompted ? { type: "busy" } : { type: "idle" } });
  if (req.method === "POST" && url.pathname === "/api/session/session-fixture/wait") {
    appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ wait: true }) + "\\n");
    if (${JSON.stringify(mode)} === "wait" || !idle) {
      waitResponse = res;
      return;
    }
    return response(res, 204);
  }
  response(res, 404, { message: "not found" });
});
server.listen(port, "127.0.0.1");
if (${JSON.stringify(mode)} === "startup-abort") appendFileSync(${JSON.stringify(protocolLog)}, JSON.stringify({ startupBlocked: true }) + "\\n");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
  await chmod(join(bin, "opencode"), 0o755);
  return {
    workspace,
    environment: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CI: "true",
      SECRET: "not-a-public-observation",
      HOME: hostileHome,
      OPENCODE_CONFIG_DIR: hostileConfigDirectory,
      OPENCODE_CONFIG: join(hostileConfigDirectory, "opencode.json"),
    },
    stateDirectory,
    protocolLog,
    close: async () => undefined,
  };
}

function request(
  workspace: string,
  fixtureEnvironment: Record<string, string>,
  stateDirectory: string,
  signal: AbortSignal,
  sandbox: "workspace-write" | "read-only" = "read-only",
): CodingSessionAdapterRequest {
  return {
    workspace,
    prompt: "fixture prompt",
    sandbox,
    approvalPolicy: "never",
    profile: {
      model: "fixture-model",
      modelProvider: "fixture-provider",
      developerInstructions: "private instructions",
    },
    mcpServer: {
      name: "github_read",
      url: "https://mcp.example.test/read",
      enabledTools: ["github_issue_get"],
      startupTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      required: true,
    },
    outputSchema: { type: "object" },
    environment: fixtureEnvironment,
    executionStateDirectory: stateDirectory,
    execution,
    signal,
  };
}

function editPermission(requestValue: CodingSessionAdapterRequest): unknown {
  const permission = opencodeConfig(requestValue).permission;
  if (typeof permission !== "object" || permission === null)
    throw new Error("expected an OpenCode permission object");
  return Object.fromEntries(Object.entries(permission)).edit;
}

async function assertOwnedExecutionGone(testFixture: {
  stateDirectory: string;
  protocolLog: string;
}): Promise<void> {
  await expect(
    discoverOwnedExecutions(testFixture.stateDirectory, execution.taskId),
  ).resolves.toEqual([]);
  const identityPath = executionIdentityPath(testFixture.stateDirectory, execution);
  await expect(access(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(`${identityPath}.mjs`)).rejects.toMatchObject({ code: "ENOENT" });
  const launch = launchRecordSchema.parse(
    JSON.parse((await readFile(testFixture.protocolLog, "utf8")).split("\n")[0]),
  );
  expect(processGroupHasLiveProcess(launch.processId)).toBe(false);
}

function processGroupHasLiveProcess(pid: number): boolean {
  try {
    const output = execFileSync("ps", ["-o", "stat=", "-g", String(pid)], { encoding: "utf8" });
    return output
      .trim()
      .split("\n")
      .some((state) => state.trim() !== "" && !/^[ZX]/.test(state.trim()));
  } catch {
    return false;
  }
}

async function waitForProtocolFact(protocolLog: string, fact: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await readFile(protocolLog, "utf8")).includes(fact)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not record ${fact}`);
}

describe("OpenCode2 bounded adapter", () => {
  test("builds explicit role profiles with no reviewer workspace write rule", () => {
    const workspace = join("/tmp", "opencode2-workspace");
    const privateDirectory = join("/tmp", "opencode2-private");
    const base = {
      workspace,
      privateDirectory,
      opencodeExecutable: join("/tmp", "opencode"),
    };
    const implementer = sandboxProfile({ ...base, role: "implementer" });
    const reviewer = sandboxProfile({ ...base, role: "reviewer" });

    expect(implementer).toContain("(deny default)");
    expect(reviewer).toContain("(deny default)");
    expect(implementer).toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(reviewer).not.toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(implementer).toContain(`(allow file-write* (subpath "${privateDirectory}"))`);
    expect(reviewer).toContain(`(allow file-write* (subpath "${privateDirectory}"))`);
  });

  test("binds OpenCode edit permission to the execution role, not sandbox intent", () => {
    const testFixtureRequest = request(
      join("/tmp", "opencode2-workspace"),
      {},
      join("/tmp", "opencode2-state"),
      new AbortController().signal,
      "workspace-write",
    );

    expect(editPermission(testFixtureRequest)).toBe("deny");
    expect(
      editPermission({
        ...testFixtureRequest,
        execution: { ...testFixtureRequest.execution, role: "implementer" },
      }),
    ).toBe("allow");
  });

  test("canonicalizes and verifies the OpenCode executable before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-opencode2-executable-"));
    const target = join(root, "real-opencode");
    const linkDirectory = join(root, "path");
    const link = join(linkDirectory, "opencode");
    await mkdir(linkDirectory, { recursive: true });
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o755);
    await symlink(target, link);
    try {
      await expect(resolveExecutable(linkDirectory)).resolves.toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["cancellation", "timeout"] as const)(
    "waits for the probe child to close after %s",
    async (reason) => {
      const root = await mkdtemp(join(tmpdir(), "usine-opencode2-probe-"));
      const marker = join(root, "closed");
      const controller = new AbortController();
      let child: ReturnType<typeof spawn> | undefined;
      let closed = false;
      try {
        const probe = runProbe(
          {
            profile: "(version 1)",
            role: "reviewer",
            workspaceProbe: join(root, "workspace-probe"),
            outsidePath: join(root, "outside"),
            privateDirectory: root,
            signal: controller.signal,
          },
          (_command, _args) => {
            const spawned = spawn(
              process.execPath,
              [
                "-e",
                `process.on("SIGTERM", () => ${
                  reason === "cancellation"
                    ? `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "closed"); process.exit(0); }, 100)`
                    : "undefined"
                }); setInterval(() => {}, 1000);`,
              ],
              { stdio: "ignore" },
            );
            child = spawned;
            spawned.once("close", () => {
              closed = true;
            });
            if (reason === "cancellation")
              spawned.once("spawn", () => setTimeout(() => controller.abort(), 100));
            return spawned;
          },
        );
        const result = await probe;
        expect(result).toEqual({ ok: false, reason });
        if (reason === "cancellation") await expect(access(marker)).resolves.toBeUndefined();
        expect(closed).toBe(true);
      } finally {
        if (child?.exitCode === null) child.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("runs the real host preflight and never substitutes an unverified boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-opencode2-sandbox-real-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const privateDirectory = join(root, "private");
    await mkdir(bin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(join(bin, "opencode"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "opencode"), 0o755);
    try {
      for (const role of ["implementer", "reviewer"] as const) {
        try {
          const prepared = await new DarwinOpenCode2Sandbox().prepare({
            workspace,
            privateDirectory,
            role,
            environment: { PATH: bin },
            signal: AbortSignal.timeout(5_000),
          });
          expect(prepared.evidence).toEqual({
            host: "darwin-seatbelt",
            role,
            workspaceRead: "verified",
            workspaceWrite: role === "implementer" ? "verified" : "denied",
            externalRead: "denied",
            externalWrite: "denied",
            subprocess: "inherited",
          });
        } catch (error) {
          expect(error).toMatchObject({ code: "opencode2_sandbox_unavailable" });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs one V2 session and returns only provider-neutral evidence", async () => {
    const testFixture = await fixture("success");
    const observations: unknown[] = [];
    const evidence: ProviderNeutralCompletedEvidence[] = [];
    const result = await fixtureAdapter().run({
      ...request(
        testFixture.workspace,
        testFixture.environment,
        testFixture.stateDirectory,
        AbortSignal.timeout(5000),
      ),
      onObservation: (observation) => {
        observations.push(observation);
      },
      onItemCompleted: (item) => {
        evidence.push(item);
      },
    });

    expect(result).toEqual({
      finalResponse: '{"verdict":"approved"}',
      usage: { inputTokens: 11, outputTokens: 13 },
      sessionId: "session-fixture",
    });
    expect(observations).toEqual([
      {
        type: "sandbox_verified",
        host: "darwin-seatbelt",
        role: "reviewer",
        workspaceRead: "verified",
        workspaceWrite: "denied",
        externalRead: "denied",
        externalWrite: "denied",
        subprocess: "inherited",
      },
      { type: "thread_started" },
      { type: "turn_started", turn: 1 },
      { type: "turn_completed", turn: 1, outcome: "succeeded" },
    ]);
    expect(evidence).toEqual([
      { type: "command_execution", id: "shell-fixture", status: "completed", output: "done" },
      expect.objectContaining({
        type: "mcp_tool_call",
        id: "tool-fixture",
        server: "github_read",
        tool: "github_issue_get",
        arguments: { issue: 292 },
      }),
      {
        type: "reasoning",
        id: "reasoning-fixture",
        status: "completed",
        text: "checking",
      },
      {
        type: "agent_message",
        id: "text-fixture-2",
        status: "completed",
        text: '{"verdict":"approved"}',
      },
    ]);
    const launch = JSON.parse((await readFile(testFixture.protocolLog, "utf8")).split("\n")[0]);
    const sessionCreate = JSON.parse(
      (await readFile(testFixture.protocolLog, "utf8"))
        .split("\n")
        .find((line) => line.includes('"sessionCreate"'))!,
    );
    expect(sessionCreate.sessionCreate).toEqual({
      agent: "usine",
      model: { providerID: "fixture-provider", id: "fixture-model" },
      location: { directory: testFixture.workspace },
    });
    expect(launch.args).toEqual([
      "serve",
      "--hostname=127.0.0.1",
      expect.stringMatching(/^--port=\d+$/),
      "--pure",
    ]);
    expect(launch.config).toEqual({
      model: "fixture-provider/fixture-model",
      default_agent: "usine",
      permission: {
        "*": "deny",
        read: "allow",
        edit: "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "allow",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "deny",
        doom_loop: "deny",
        skill: "deny",
      },
      agent: {
        usine: {
          model: "fixture-provider/fixture-model",
          mode: "primary",
          prompt: "private instructions",
          tools: { github_issue_get: true },
        },
      },
      mcp: { github_read: { type: "remote", url: "https://mcp.example.test/read", enabled: true } },
    });
    expect(launch.environment.SECRET).toBe("not-a-public-observation");
    expect(launch.environment.HOME).not.toContain("hostile-home");
    expect(launch.environment.XDG_CONFIG_HOME).not.toContain("hostile-home");
    expect(launch.environment.XDG_DATA_HOME).not.toContain("hostile-home");
    expect(launch.environment.XDG_STATE_HOME).not.toContain("hostile-home");
    expect(launch.environment.XDG_CACHE_HOME).not.toContain("hostile-home");
    expect(launch.environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(launch.environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(launch.environment.OPENCODE_DISABLE_SHARE).toBe("1");
    expect(launch.environment.OPENCODE_CONFIG).toBeUndefined();
    expect(launch.environment.OPENCODE_CONFIG_DIR).not.toContain("hostile");
    expect(launch.projectConfigPresent).toBe(true);
    expect(launch.hostileConfigPresent).toBe(false);
    expect(JSON.stringify(launch.config)).not.toContain("hostile");
    const protocol = (await readFile(testFixture.protocolLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(protocol).toContainEqual({ sessionEventsConnected: true });
    expect(protocol).toContainEqual({ wait: true });
    await assertOwnedExecutionGone(testFixture);
    await expect(new Promise((resolve) => setTimeout(resolve, 10))).resolves.toBeUndefined();
    await testFixture.close();
  });

  test("fails closed on a V2 event identity mismatch and reaps the owned process", async () => {
    const testFixture = await fixture("malformed");
    await expect(
      fixtureAdapter().run(
        request(
          testFixture.workspace,
          testFixture.environment,
          testFixture.stateDirectory,
          AbortSignal.timeout(5000),
        ),
      ),
    ).rejects.toMatchObject({ phase: "turn", failureClass: "transport" });
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("requests graceful V2 interruption before cleanup on cancellation", async () => {
    const testFixture = await fixture("wait");
    const controller = new AbortController();
    const run = fixtureAdapter().run(
      request(
        testFixture.workspace,
        testFixture.environment,
        testFixture.stateDirectory,
        controller.signal,
      ),
    );
    await waitForProtocolFact(testFixture.protocolLog, '"sessionEventsConnected":true');
    await waitForProtocolFact(testFixture.protocolLog, '"prompt":true');
    await waitForProtocolFact(testFixture.protocolLog, '"wait":true');
    controller.abort();
    await expect(run).rejects.toMatchObject({ phase: "turn", failureClass: "cancellation" });
    await expect(readFile(testFixture.protocolLog, "utf8")).resolves.toContain(
      '"interrupted":true',
    );
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("fails as a typed startup transport error and removes an unowned identity", async () => {
    const testFixture = await fixture("startup-failure");
    await expect(
      fixtureAdapter().run(
        request(
          testFixture.workspace,
          testFixture.environment,
          testFixture.stateDirectory,
          AbortSignal.timeout(5_000),
        ),
      ),
    ).rejects.toMatchObject({ phase: "startup", failureClass: "transport" });
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("preserves typed startup cancellation and reaps the launcher-owned child", async () => {
    const testFixture = await fixture("startup-abort");
    const controller = new AbortController();
    const run = fixtureAdapter().run(
      request(
        testFixture.workspace,
        testFixture.environment,
        testFixture.stateDirectory,
        controller.signal,
      ),
    );
    await waitForProtocolFact(testFixture.protocolLog, '"startupBlocked":true');
    controller.abort();
    await expect(run).rejects.toMatchObject({ phase: "startup", failureClass: "cancellation" });
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("maps prompt admission failure without an unhandled completion rejection", async () => {
    const testFixture = await fixture("prompt-failure");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await expect(
        fixtureAdapter().run(
          request(
            testFixture.workspace,
            testFixture.environment,
            testFixture.stateDirectory,
            AbortSignal.timeout(5_000),
          ),
        ),
      ).rejects.toMatchObject({ phase: "turn", failureClass: "unknown" });
      await assertOwnedExecutionGone(testFixture);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await testFixture.close();
    }
  });

  test.each([
    ["no-response", "transport"],
    ["out-of-order", "transport"],
    ["step-failure", "unknown"],
  ] as const)(
    "maps %s as a typed failure and reaps its owned process",
    async (mode, failureClass) => {
      const testFixture = await fixture(mode);
      await expect(
        fixtureAdapter().run(
          request(
            testFixture.workspace,
            testFixture.environment,
            testFixture.stateDirectory,
            AbortSignal.timeout(5_000),
          ),
        ),
      ).rejects.toMatchObject({ phase: "turn", failureClass });
      await assertOwnedExecutionGone(testFixture);
      await testFixture.close();
    },
  );

  test("rejects an unexpected V2 permission ask with a bounded typed interruption", async () => {
    const testFixture = await fixture("permission-ask");
    await expect(
      fixtureAdapter().run(
        request(
          testFixture.workspace,
          testFixture.environment,
          testFixture.stateDirectory,
          AbortSignal.timeout(5_000),
        ),
      ),
    ).rejects.toMatchObject({ phase: "turn", failureClass: "authority" });
    await expect(readFile(testFixture.protocolLog, "utf8")).resolves.toContain(
      '"permissionReply":true',
    );
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("runs through the ordinary facade, selects OpenCode2, and archives the role result", async () => {
    const finalResponse = JSON.stringify({
      sha: "a".repeat(40),
      verdict: "approved",
      summary: "fixture review",
      findings: [],
    });
    const testFixture = await fixture("success", finalResponse);
    const observations: unknown[] = [];
    const session = createCodexCodingSessionForTesting(
      undefined,
      {
        environment: testFixture.environment,
        executionStateDirectory: testFixture.stateDirectory,
        sessionArchive: { stateDirectory: testFixture.stateDirectory },
        adapterSelectionEnvironment: {
          USINE_OPENCODE2_PROFILES: "reviewer-profile",
        },
        profileResolver: async () =>
          normalizeCodexProfileSelection("reviewer-profile", {
            model: "fixture-model",
            developerInstructions: "private instructions",
            config: { model_provider: "fixture-provider" },
          }),
      },
      { opencode2: fixtureAdapter() },
    );
    const observation = await session.run({
      role: "reviewer",
      workspace: testFixture.workspace,
      contract: facadeContract,
      prompt: "review fixture",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 5_000,
      outputSchema: reviewerOutputSchema,
      execution,
      onObservation: (sessionObservation) => {
        observations.push(sessionObservation);
      },
    });

    expect(observation).toMatchObject({
      status: "completed",
      output: {
        sha: "a".repeat(40),
        verdict: "approved",
        summary: "fixture review",
        findings: [],
      },
      effectiveProfile: { profileName: "reviewer-profile", adapter: "opencode2" },
    });
    expect(observation.archiveId).toMatch(/^archive_/);
    expect(observations[0]).toMatchObject({ type: "sandbox_verified", role: "reviewer" });
    const archive = await readSessionArchive(testFixture.stateDirectory, observation.archiveId!);
    expect(archive).toMatchObject({
      adapter: "opencode2",
      status: "completed",
      completeness: "complete",
    });
    expect(JSON.stringify(archive)).not.toContain("hostile");
    expect(JSON.stringify(archive)).not.toContain("session.next");
    await assertOwnedExecutionGone(testFixture);
    await testFixture.close();
  });

  test("ordinary facade reports missing OpenCode2 sandbox prerequisites before provider launch", async () => {
    const testFixture = await fixture("success");
    const session = new CodexCodingSession(undefined, {
      environment: { PATH: join(testFixture.stateDirectory, "no-opencode") },
      executionStateDirectory: testFixture.stateDirectory,
      sessionArchive: { stateDirectory: testFixture.stateDirectory },
      adapterSelectionEnvironment: {
        USINE_OPENCODE2_PROFILES: "reviewer-profile",
      },
      profileResolver: async () =>
        normalizeCodexProfileSelection("reviewer-profile", {
          model: "fixture-model",
          developerInstructions: "private instructions",
          config: { model_provider: "fixture-provider" },
        }),
    });
    const observation = await session.run({
      role: "reviewer",
      workspace: testFixture.workspace,
      contract: facadeContract,
      prompt: "review fixture",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 5_000,
      outputSchema: reviewerOutputSchema,
      execution,
    });

    expect(observation).toMatchObject({
      status: "failed",
      failureClass: "configuration",
      effectiveProfile: { adapter: "opencode2" },
    });
    await expect(readFile(testFixture.protocolLog, "utf8")).resolves.not.toContain('"args"');
    await expect(
      discoverOwnedExecutions(testFixture.stateDirectory, execution.taskId),
    ).resolves.toEqual([]);
    await testFixture.close();
  });
});
