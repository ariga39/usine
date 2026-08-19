import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa, type ResultPromise } from "execa";
import { describe, expect, test } from "vite-plus/test";

const fakeCodexLoader = String.raw`
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Codex {
  startThread(options) {
    return {
      id: "server-milestone-session",
      async run(prompt) {
        if (prompt.startsWith("Role: fresh independent reviewer.")) {
          const sha = prompt.match(/Candidate SHA: ([0-9a-f]{40})/)?.[1];
          if (!sha) throw new Error("review candidate SHA is missing");
          return {
            finalResponse: JSON.stringify({
              sha,
              verdict: "approved",
              summary: "approved",
              findings: [],
            }),
          };
        }
        const marker = process.env.USINE_CODEX_MARKER;
        if (process.env.USINE_CODEX_MODE === "kill") {
          if (!marker) throw new Error("USINE_CODEX_MARKER is required");
          await writeFile(marker, "activation-started\\n");
          await new Promise(() => undefined);
        }
        if (process.env.USINE_CODEX_MODE === "complete") {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const target = join(options.workingDirectory, "target.sh");
        await writeFile(target, "#!/bin/sh\\nexit 0\\n");
        await chmod(target, 0o755);
        return {
          finalResponse: JSON.stringify({ status: "proposed", summary: "candidate" }),
        };
      },
    };
  }
}
`;

const fakeCodexRedirectLoader = String.raw`
import { pathToFileURL } from "node:url";

const fakeCodexModule = process.env.USINE_FAKE_CODEX_MODULE;
if (!fakeCodexModule) throw new Error("USINE_FAKE_CODEX_MODULE is required");
const fakeCodexUrl = pathToFileURL(fakeCodexModule);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@openai/codex-sdk") return { url: fakeCodexUrl.href, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  contractPath: string;
  stateDirectory: string;
  taskId: string;
  branch: string;
  loaderPath: string;
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
  const loaderPath = join(root, "codex-loader.mjs");
  const fakeCodexPath = join(root, "fake-codex.mjs");
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
  await writeFile(loaderPath, fakeCodexRedirectLoader);
  await writeFile(fakeCodexPath, fakeCodexLoader);
  return {
    root,
    repository,
    remote,
    contractPath,
    stateDirectory,
    taskId,
    branch,
    loaderPath,
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
  mode: "complete" | "kill",
): NodeJS.ProcessEnv {
  return {
    USINE_STATE_DIR: fixture.stateDirectory,
    USINE_GIT_AUTHOR_NAME: "Release Bot",
    USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
    USINE_GITHUB_APP_SLUG: "usine-app",
    USINE_GITHUB_TEST_TOKEN: "test-token",
    USINE_GITHUB_API_URL: forge.url,
    USINE_GITHUB_GIT_URL: fixture.remote,
    USINE_FAKE_CODEX_MODULE: fixture.fakeCodexPath,
    USINE_CODEX_MODE: mode,
    USINE_CODEX_MARKER: join(fixture.root, "activation.marker"),
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
  const child = execa(
    "node",
    ["--no-warnings", "--experimental-loader", fixture.loaderPath, cliPath, "server"],
    { env: environment(fixture, forge, mode), reject: false },
  );
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
  return execa(
    "node",
    ["--no-warnings", "--experimental-loader", fixture.loaderPath, cliPath, command, argument],
    {
      cwd: fixture.repository,
      env: { ...environment(fixture, forge, mode), USINE_SERVER_URL: serverUrl },
      reject: false,
    },
  );
}

async function waitForStatus(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  serverUrl: string,
  predicate: (result: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runCli(cliPath, fixture, forge, serverUrl, "status", fixture.taskId);
    if (status.exitCode === 0) {
      const result = JSON.parse(status.stdout) as Record<string, unknown>;
      if (predicate(result)) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for server task status");
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
      await waitForMarker(join(fixtureValue.root, "activation.marker"));
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
});
