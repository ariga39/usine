import { createServer, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa, type ResultPromise } from "execa";
import { codexExecutionIdentityPath } from "@usine/coding-session";
import { describe, expect, test } from "vite-plus/test";

const fakeCodexExecutable = (hang: boolean): string => String.raw`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const args = process.argv;
const workspace = args[args.indexOf("--cd") + 1];
if (!workspace) throw new Error("Codex workspace is required");
const activation = Number(basename(workspace).split("-")[0]);
const stateDirectory = dirname(dirname(dirname(workspace)));
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const reviewer = prompt.includes("Role: fresh independent reviewer.");
if (!reviewer) {
  await writeFile(join(stateDirectory, "codex.pid"), String(process.pid));
  if (${String(hang)} && activation === 1) {
    const stalePath = join(workspace, "stale-after-loss");
    const releasePath = join(stateDirectory, "release-stale-child");
    const childSource = 'import { access, writeFile } from "node:fs/promises";\nconst [releasePath, stalePath] = process.argv.slice(1);\nfor (;;) { try { await access(releasePath); await writeFile(stalePath, "stale\\n"); } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); }';
    const descendant = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childSource, releasePath, stalePath],
      { stdio: "ignore" },
    );
    if (!descendant.pid) throw new Error("descendant PID is missing");
    await writeFile(join(stateDirectory, "descendant.pid"), String(descendant.pid));
    await writeFile(join(stateDirectory, "activation.marker"), "activation-started\n");
    await new Promise(() => {
      setInterval(() => undefined, 1_000);
    });
  }
  await writeFile(join(workspace, "target.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(workspace, "target.sh"), 0o755);
}
const sha = prompt.match(/Candidate SHA: ([0-9a-f]{40})/)?.[1];
const output = reviewer
  ? JSON.stringify({ sha, verdict: "approved", summary: "approved", findings: [] })
  : JSON.stringify({ status: "proposed", summary: "candidate" });
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "server-milestone-session" }) + "\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "message-1", text: output } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }) + "\n");
`;

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  contractPath: string;
  stateDirectory: string;
  taskId: string;
  branch: string;
  fakeCodexPath: string;
  baseSha: string;
}

interface ForgeServer {
  url: string;
  pullRequests: number;
  attestations: number;
  close(): Promise<void>;
}

interface UsineProcess {
  url: string;
  child: ResultPromise;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function jsonResponse(response: ServerResponse, body: unknown, status = 200): Promise<void> {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function fixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `usine-server-milestone-${name}-`));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const stateDirectory = join(root, "state");
  const fakeCodexPath = join(root, "bin", "codex");
  const taskId = `server-milestone-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const branch = `agent/${taskId}`;

  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "base\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const baseSha = await git(repository, "rev-parse", "HEAD");
  const contractPath = join(repository, "task.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      id: taskId,
      repository: { path: ".", owner: "example", name: taskId },
      baseSha,
      instructions: "Implement the executable target and deliver it.",
      acceptance: ["The executable target passes the project check and is delivered."],
      nonGoals: [],
      projectCheck: { command: "test -x target.sh", timeoutMs: 10_000 },
      budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/153`,
        delivery: true,
      },
      delivery: {
        baseBranch: "main",
        branch,
        issue: 153,
        title: "Server milestone",
        body: "Server milestone",
      },
    }),
  );
  await execa("git", ["add", "task.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
  await execa("git", ["init", "--bare", remote]);
  await mkdir(join(root, "bin"));
  await writeFile(fakeCodexPath, fakeCodexExecutable(name === "restart"), { mode: 0o755 });
  await chmod(fakeCodexPath, 0o755);
  return {
    root,
    repository,
    remote,
    contractPath,
    stateDirectory,
    taskId,
    branch,
    fakeCodexPath,
    baseSha,
  };
}

async function forgeServer(fixture: Fixture): Promise<ForgeServer> {
  let pullRequests = 0;
  let attestations = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (request.headers.authorization !== "token test-token") {
      await jsonResponse(response, { message: "bad credentials" }, 401);
      return;
    }
    if (method === "GET" && url.pathname.endsWith(`/git/ref/heads/${fixture.branch}`)) {
      await jsonResponse(response, { message: "Not Found" }, 404);
      return;
    }
    if (method === "GET" && url.pathname === `/repos/example/${fixture.taskId}/pulls`) {
      await jsonResponse(response, []);
      return;
    }
    if (method === "POST" && url.pathname === `/repos/example/${fixture.taskId}/pulls`) {
      pullRequests += 1;
      const headSha = await git(fixture.remote, "rev-parse", `refs/heads/${fixture.branch}`);
      await jsonResponse(
        response,
        {
          number: 1,
          state: "open",
          head: { sha: headSha },
          html_url: "http://example.invalid/pull/1",
        },
        201,
      );
      return;
    }
    if (url.pathname === `/repos/example/${fixture.taskId}/issues/1/comments`) {
      if (method === "GET") {
        await jsonResponse(response, []);
        return;
      }
      if (method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("body" in parsed) ||
          typeof parsed.body !== "string"
        ) {
          throw new Error("forge comment body is invalid");
        }
        attestations += 1;
        await jsonResponse(
          response,
          {
            id: 7,
            body: parsed.body,
            performed_via_github_app: { slug: "usine-app" },
            user: { type: "Bot" },
          },
          201,
        );
        return;
      }
    }
    await jsonResponse(response, { message: `unhandled ${method} ${url.pathname}` }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("forge server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get pullRequests() {
      return pullRequests;
    },
    get attestations() {
      return attestations;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function environment(
  fixture: Fixture,
  forge: ForgeServer,
  _mode: "complete" | "kill",
): NodeJS.ProcessEnv {
  return {
    USINE_STATE_DIR: fixture.stateDirectory,
    USINE_GIT_AUTHOR_NAME: "Release Bot",
    USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
    USINE_GITHUB_APP_SLUG: "usine-app",
    USINE_GITHUB_TEST_TOKEN: "test-token",
    USINE_GITHUB_API_URL: forge.url,
    USINE_GITHUB_GIT_URL: fixture.remote,
    PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
    USINE_SERVER_HOST: "127.0.0.1",
    USINE_SERVER_PORT: "0",
  };
}

async function startServer(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  mode: "complete" | "kill",
): Promise<UsineProcess> {
  const child = execa("node", ["--no-warnings", cliPath, "server"], {
    env: environment(fixture, forge, mode),
    reject: false,
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event: unknown = JSON.parse(line);
          if (
            typeof event === "object" &&
            event !== null &&
            "event" in event &&
            event.event === "server_ready" &&
            "url" in event &&
            typeof event.url === "string"
          ) {
            resolve(event.url);
            return;
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    void child.then(
      (result) =>
        reject(new Error(`server exited before ready: ${result.exitCode ?? result.signal}`)),
      reject,
    );
  });
  return { child, url };
}

async function stopServer(server: UsineProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  server.child.kill(signal);
  if (signal === "SIGKILL") {
    const pid = server.child.pid;
    const phase = "SIGKILL server exit";
    if (pid === undefined) throw new Error(`${phase} has no server PID`);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (!processAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${phase} timed out after 5000ms (pid ${pid})`);
  }
  await server.child;
}

async function runCli(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  serverUrl: string,
  command: "submit" | "status" | "follow",
  argument: string,
  mode: "complete" | "kill" = "complete",
) {
  return execa("node", ["--no-warnings", cliPath, command, argument], {
    cwd: fixture.repository,
    env: { ...environment(fixture, forge, mode), USINE_SERVER_URL: serverUrl },
    reject: false,
  });
}

async function waitForStatus(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  serverUrl: string,
  predicate: (result: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let lastEvidence: {
    status: Record<string, unknown> | null;
    exitCode: number | null;
    signal: string | null;
    stderr: string;
  } = { status: null, exitCode: null, signal: null, stderr: "" };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runCli(cliPath, fixture, forge, serverUrl, "status", fixture.taskId);
    lastEvidence = {
      status: null,
      exitCode: status.exitCode ?? null,
      signal: status.signal ?? null,
      stderr: status.stderr.slice(-2_000),
    };
    if (status.exitCode === 0) {
      const result = JSON.parse(status.stdout) as Record<string, unknown>;
      lastEvidence.status = result;
      if (predicate(result)) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for server task status: ${JSON.stringify(lastEvidence)}`);
}

async function waitForMarker(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")).includes("activation-started")) return;
    } catch {
      // The SDK adapter has not entered the turn yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the Codex turn marker");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function reapFixtureProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The recovered server may already have reaped the fixture process.
  }
}

describe("server-owned delivery milestone", () => {
  test("submit exits while the server delivers and follow observes the exact terminal result", async () => {
    const fixtureValue = await fixture("complete");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const server = await startServer(cliPath, fixtureValue, forge, "complete");
    try {
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "submit",
        fixtureValue.contractPath,
      );
      expect(submit.exitCode, submit.stderr).toBe(0);
      const admitted = JSON.parse(submit.stdout) as { taskId: string; state: string };
      expect(admitted).toMatchObject({ taskId: fixtureValue.taskId, state: "admitted" });

      const follow = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "follow",
        fixtureValue.taskId,
      );
      expect(follow.exitCode, follow.stderr).toBe(0);
      const terminal = JSON.parse(follow.stdout) as {
        taskId: string;
        state: string;
        candidateSha: string;
        delivery: { prNumber: number; attestationId: string };
      };
      expect(terminal).toMatchObject({
        taskId: fixtureValue.taskId,
        state: "reviewed_pr",
        delivery: { prNumber: 1, attestationId: "7" },
      });
      expect(terminal.candidateSha).toMatch(/^[0-9a-f]{40}$/);
      const progress = follow.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { revision: number; state: string });
      expect(progress.length).toBeGreaterThanOrEqual(2);
      const revisions = progress.map((entry) => entry.revision);
      expect(new Set(revisions).size).toBe(revisions.length);
      expect(
        revisions.every((revision, index) => {
          const previous = revisions[index - 1];
          return index === 0 || (previous !== undefined && revision > previous);
        }),
      ).toBe(true);
      expect(progress.at(-1)).toMatchObject({ state: "reviewed_pr" });
      expect(
        progress
          .slice(0, -1)
          .some((entry) => ["admitted", "candidate", "checked", "reviewed"].includes(entry.state)),
      ).toBe(true);
      expect(forge.pullRequests).toBe(1);
      expect(forge.attestations).toBe(1);
      expect(await git(fixtureValue.remote, "rev-parse", `refs/heads/${fixtureValue.branch}`)).toBe(
        terminal.candidateSha,
      );
    } finally {
      await stopServer(server);
      await forge.close();
    }
  }, 60_000);

  test("restarts after SIGKILL with one fresh activation and one external delivery", async () => {
    const fixtureValue = await fixture("restart");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "kill");
    let firstStopped = false;
    try {
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "submit",
        fixtureValue.contractPath,
        "kill",
      );
      expect(submit.exitCode, submit.stderr).toBe(0);
      await waitForStatus(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        (result) => result.activeActivation === 1,
      );
      await waitForMarker(join(fixtureValue.stateDirectory, "activation.marker"));
      const descendantPid = Number(
        await readFile(join(fixtureValue.stateDirectory, "descendant.pid"), "utf8"),
      );
      expect(processAlive(descendantPid)).toBe(true);
      await stopServer(first, "SIGKILL");
      firstStopped = true;

      const second = await startServer(cliPath, fixtureValue, forge, "complete");
      try {
        const follow = await runCli(
          cliPath,
          fixtureValue,
          forge,
          second.url,
          "follow",
          fixtureValue.taskId,
        );
        expect(follow.exitCode, follow.stderr).toBe(0);
        const terminal = JSON.parse(follow.stdout) as {
          state: string;
          candidateSha: string;
          evidence: { implementerActivations: number; restartRecoveries: number };
          delivery: { prNumber: number; attestationId: string };
        };
        expect(terminal).toMatchObject({
          state: "reviewed_pr",
          evidence: { implementerActivations: 2, restartRecoveries: 1 },
          delivery: { prNumber: 1, attestationId: "7" },
        });
        expect(terminal.candidateSha).toMatch(/^[0-9a-f]{40}$/);
        expect(forge.pullRequests).toBe(1);
        expect(forge.attestations).toBe(1);
        expect(
          await git(fixtureValue.remote, "rev-parse", `refs/heads/${fixtureValue.branch}`),
        ).toBe(terminal.candidateSha);
        expect(processAlive(descendantPid)).toBe(false);
        await writeFile(join(fixtureValue.stateDirectory, "release-stale-child"), "release\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(
          readFile(
            join(
              fixtureValue.stateDirectory,
              "workspaces",
              fixtureValue.taskId,
              "1-1",
              "stale-after-loss",
            ),
            "utf8",
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await stopServer(second);
      }
    } finally {
      if (!firstStopped) {
        await stopServer(first).catch(() => undefined);
      }
      await forge.close();
    }
  }, 60_000);

  test("blocks recovery rather than grant a writer when launch ownership is incomplete", async () => {
    const fixtureValue = await fixture("restart");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "kill");
    let codexPid: number | null = null;
    try {
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "submit",
        fixtureValue.contractPath,
        "kill",
      );
      expect(submit.exitCode, submit.stderr).toBe(0);
      await waitForMarker(join(fixtureValue.stateDirectory, "activation.marker"));
      codexPid = Number(await readFile(join(fixtureValue.stateDirectory, "codex.pid"), "utf8"));
      const oldWorkspace = join(
        fixtureValue.stateDirectory,
        "workspaces",
        fixtureValue.taskId,
        "1-1",
      );
      await writeFile(
        codexExecutionIdentityPath(fixtureValue.stateDirectory, oldWorkspace),
        JSON.stringify({ version: 1, state: "starting", workspace: oldWorkspace }),
      );
      await stopServer(first, "SIGKILL");
      const second = await startServer(cliPath, fixtureValue, forge, "complete");
      try {
        const follow = await runCli(
          cliPath,
          fixtureValue,
          forge,
          second.url,
          "follow",
          fixtureValue.taskId,
        );
        expect(follow.exitCode, follow.stderr).toBe(0);
        expect(JSON.parse(follow.stdout)).toMatchObject({
          state: "blocked",
          evidence: { implementerActivations: 1, restartRecoveries: 0 },
        });
      } finally {
        await stopServer(second);
      }
    } finally {
      if (codexPid) reapFixtureProcessGroup(codexPid);
      await stopServer(first).catch(() => undefined);
      await forge.close();
    }
  }, 60_000);
});
