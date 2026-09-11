import { createServer, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa, type ResultPromise } from "execa";
import { lookupTaskEvents, lookupTaskStatus } from "@usine/runtime";
import { describe, expect, test } from "vite-plus/test";
import { captureCampaignEvidence } from "../packages/runtime/src/posthog.js";

const fakeCodexExecutable = (
  hang: boolean,
  hangReviewer: boolean,
  usageBeforeHang: boolean,
  cooperativeCleanup = false,
): string => String.raw`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const args = process.argv;
const workspace = args[args.indexOf("--cd") + 1];
if (!workspace) throw new Error("Codex workspace is required");
const activation = Number(basename(workspace).split("-")[0]);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "server-milestone-session" }) + "\n");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const reviewer = prompt.includes("Usine role: fresh independent reviewer.");
const assessor = prompt.includes("Usine role: fresh Campaign assessor.");
if (assessor) {
  let assessment = null;
  try {
    const section = (label) => JSON.parse(
      prompt.split("\n").find((line) => line.startsWith(label)).slice(label.length),
    );
    assessment = {
      outcome: section("Outcome requirements: "),
      evidence: section("Exact evidence facts: "),
    };
  } catch {
    // The fixture below remains inconclusive until the server supplies evidence.
  }
  const delivery = assessment?.evidence?.find((item) => item.fact === "delivery");
  const output = JSON.stringify(
    delivery
      ? {
          verdict: "satisfied",
          summary: "Campaign delivery evidence satisfies the Outcome.",
          gaps: [],
          evidence: assessment.outcome.acceptance.map((_, criterionIndex) => ({
            ...delivery,
            criterionIndex,
          })),
        }
      : {
          verdict: "inconclusive",
          summary: "Campaign assessor fixture is inconclusive.",
          gaps: [],
          evidence: [],
        },
  );
  await new Promise((resolve) =>
    process.stdout.write(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", id: "message-assessor", text: output },
      }) + "\n",
      resolve,
    ),
  );
  process.exit(0);
}
const stateDirectory = reviewer
  ? dirname(dirname(workspace))
  : dirname(dirname(dirname(workspace)));
if (reviewer && ${String(hangReviewer)}) {
  await writeFile(join(stateDirectory, "reviewer.pid"), String(process.pid));
  await new Promise(() => {
    setInterval(() => undefined, 1_000);
  });
}
if (!reviewer) {
  await writeFile(join(stateDirectory, "codex.pid"), String(process.pid));
  await appendFile(join(stateDirectory, "codex.invocations"), "implementer\n");
  if (${String(hang)} && activation === 1) {
    const stalePath = join(workspace, "stale-after-loss");
    const releasePath = join(stateDirectory, "release-stale-child");
    const readyPath = join(stateDirectory, "descendant.ready");
    const childSource = ${JSON.stringify(
      cooperativeCleanup
        ? 'import { access, writeFile } from "node:fs/promises";\nprocess.on("SIGTERM", () => process.exit(0));\nconst [releasePath, stalePath, readyPath] = process.argv.slice(1);\nawait writeFile(readyPath, "ready\\n");\nfor (;;) { try { await access(releasePath); await writeFile(stalePath, "stale\\n"); } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); }'
        : 'import { access, writeFile } from "node:fs/promises";\nprocess.on("SIGTERM", () => undefined);\nconst [releasePath, stalePath, readyPath] = process.argv.slice(1);\nawait writeFile(readyPath, "ready\\n");\nfor (;;) { try { await access(releasePath); await writeFile(stalePath, "stale\\n"); } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); }',
    )};
    const descendant = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childSource, releasePath, stalePath, readyPath],
      { stdio: "ignore" },
    );
    if (!descendant.pid) throw new Error("descendant PID is missing");
    await writeFile(join(stateDirectory, "descendant.pid"), String(descendant.pid));
    for (;;) {
      try {
        await access(readyPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await writeFile(join(stateDirectory, "activation.marker"), "activation-started\n");
    if (${String(usageBeforeHang)}) {
      process.stdout.write(JSON.stringify({ type: "turn.started", turn_id: "turn-1" }) + "\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }) + "\n");
    }
    if (${String(cooperativeCleanup)}) {
      process.once("SIGTERM", async () => {
        descendant.kill("SIGTERM");
        await new Promise((resolve) => descendant.once("exit", () => resolve()));
        process.exit(0);
      });
    } else process.once("SIGTERM", () => process.exit(0));
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
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "message-1", text: output } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }) + "\n");
`;

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  contractPath: string;
  campaignContractPath: string;
  campaignProposalPath: string;
  registrationPath: string;
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
  mergeCalls: number;
  pipelineConfigured: boolean;
  pipelineObservations: number;
  captureRequests: Array<{
    batch?: Array<{
      event?: string;
      uuid?: string;
      properties?: Record<string, unknown>;
    }>;
  }>;
  setCaptureStatus(status: number): void;
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

async function fixture(name: string, mergeAuthorized = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `usine-server-milestone-${name}-`));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const stateDirectory = join(root, "state");
  const codexHome = join(root, "codex-home");
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
  const campaignContractPath = join(repository, "goal.json");
  const campaignProposalPath = join(root, "campaign-proposal.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Implement the executable target and deliver it.",
      acceptance: ["The executable target passes the project check and is delivered."],
      nonGoals: [],
      budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/153`,
        delivery: true,
        ...(mergeAuthorized ? { merge: true } : {}),
      },
      delivery: {
        branch,
        issue: 153,
        title: "Server milestone",
        body: "Server milestone",
      },
    }),
  );
  await execa("git", ["add", "task.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
  await writeFile(
    campaignContractPath,
    JSON.stringify({
      schemaVersion: 1,
      id: `${taskId}-goal`,
      version: 1,
      objective: "Deliver the interrupted campaign outcome.",
      outcomes: [
        {
          id: "campaign-outcome",
          title: "Deliver the campaign outcome",
          acceptance: ["The campaign outcome is delivered."],
          dependsOn: [],
          parentId: null,
        },
      ],
      authority: {
        source: `https://github.com/example/${taskId}/issues/154`,
        publish: true,
        delivery: true,
        merge: false,
        repositories: [taskId],
        effects: ["github"],
      },
    }),
  );
  await execa("git", ["add", "goal.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize campaign"], { cwd: repository });
  await writeFile(
    campaignProposalPath,
    JSON.stringify({
      proposalId: "campaign-interruption",
      outcomeId: "campaign-outcome",
      dependsOn: [],
      repositoryId: taskId,
      instructions: "Implement the campaign outcome.",
      acceptance: ["The campaign outcome is delivered."],
      nonGoals: [],
      effects: ["github"],
      merge: false,
    }),
  );
  const registrationPath = join(root, "repository-registration.json");
  await writeFile(
    registrationPath,
    JSON.stringify({
      id: taskId,
      path: repository,
      owner: "example",
      name: taskId,
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "test -x target.sh", timeoutMs: 10_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    }),
  );
  await execa("git", ["init", "--bare", remote]);
  await mkdir(join(root, "bin"));
  await mkdir(codexHome);
  await writeFile(
    join(codexHome, "writer-profile.config.toml"),
    'model = "writer-fixture-model"\nmodel_reasoning_effort = "low"\n',
  );
  await writeFile(
    join(codexHome, "reviewer-profile.config.toml"),
    'model = "reviewer-fixture-model"\nmodel_reasoning_effort = "high"\n',
  );
  await writeFile(
    fakeCodexPath,
    fakeCodexExecutable(
      name === "restart" ||
        name === "graceful" ||
        name === "campaign-restart" ||
        name === "campaign-abandon",
      name === "reviewer-shutdown",
      name === "campaign-restart" || name === "campaign-abandon",
      name === "campaign-abandon",
    ),
    {
      mode: 0o755,
    },
  );
  await chmod(fakeCodexPath, 0o755);
  return {
    root,
    repository,
    remote,
    contractPath,
    campaignContractPath,
    campaignProposalPath,
    registrationPath,
    stateDirectory,
    taskId,
    branch,
    fakeCodexPath,
    baseSha,
  };
}

async function forgeServer(
  fixture: Fixture,
  mergeAuthorized = false,
  pipelineConfigured = false,
): Promise<ForgeServer> {
  let pullRequests = 0;
  let attestations = 0;
  let mergeCalls = 0;
  let pipelineObservations = 0;
  let merged = false;
  let mergeCommitSha: string | null = null;
  let attestationBody: string | null = null;
  let captureStatus = 200;
  let deliveryBranch = fixture.branch;
  const captureRequests: ForgeServer["captureRequests"] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    try {
      if (method === "POST" && url.pathname === "/batch/") {
        let body = "";
        for await (const chunk of request) body += chunk;
        captureRequests.push(JSON.parse(body) as (typeof captureRequests)[number]);
        response.statusCode = captureStatus;
        response.end("ok");
        return;
      }
      if (request.headers.authorization !== "token test-token") {
        await jsonResponse(response, { message: "bad credentials" }, 401);
        return;
      }
      const decodedPath = decodeURIComponent(url.pathname);
      const refPrefix = `/repos/example/${fixture.taskId}/git/ref/heads/`;
      if (method === "GET" && decodedPath.startsWith(refPrefix)) {
        deliveryBranch = decodedPath.slice(refPrefix.length);
        await jsonResponse(response, { message: "Not Found" }, 404);
        return;
      }
      if (method === "GET" && url.pathname === `/repos/example/${fixture.taskId}/pulls`) {
        const requestedHead = url.searchParams.get("head");
        if (requestedHead) deliveryBranch = requestedHead.split(":").at(-1) ?? deliveryBranch;
        await jsonResponse(
          response,
          pullRequests === 0
            ? []
            : [
                {
                  number: 1,
                  state: merged ? "closed" : "open",
                  head: {
                    sha:
                      mergeCommitSha ??
                      (await git(fixture.remote, "rev-parse", `refs/heads/${deliveryBranch}`)),
                  },
                  html_url: "http://example.invalid/pull/1",
                  merged,
                  merged_at: merged ? "2026-08-22T00:00:00Z" : null,
                  merge_commit_sha: mergeCommitSha,
                },
              ],
        );
        return;
      }
      if (method === "POST" && url.pathname === `/repos/example/${fixture.taskId}/pulls`) {
        let body = "";
        for await (const chunk of request) body += chunk;
        const pullRequest = JSON.parse(body) as { head?: string };
        if (pullRequest.head) deliveryBranch = pullRequest.head;
        pullRequests += 1;
        const headSha = await git(fixture.remote, "rev-parse", `refs/heads/${deliveryBranch}`);
        mergeCommitSha = headSha;
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
      if (method === "GET" && url.pathname === `/repos/example/${fixture.taskId}/pulls/1`) {
        const headSha =
          mergeCommitSha ??
          (await git(fixture.remote, "rev-parse", `refs/heads/${deliveryBranch}`));
        await jsonResponse(response, {
          number: 1,
          state: merged ? "closed" : "open",
          head: { sha: headSha },
          html_url: "http://example.invalid/pull/1",
          merged,
          merged_at: merged ? "2026-08-22T00:00:00Z" : null,
          merge_commit_sha: merged ? mergeCommitSha : null,
          mergeable: null,
          mergeable_state: null,
        });
        return;
      }
      if (pipelineConfigured && method === "GET" && url.pathname.endsWith("/check-runs")) {
        const observation = pipelineObservations;
        pipelineObservations += 1;
        await jsonResponse(response, {
          total_count: 1,
          check_runs: [
            {
              id: observation + 1,
              name: "build",
              status: observation === 0 ? "queued" : "completed",
              conclusion: observation === 0 ? null : "success",
              app: { slug: "usine-app" },
            },
          ],
        });
        return;
      }
      if (
        mergeAuthorized &&
        method === "PUT" &&
        url.pathname === `/repos/example/${fixture.taskId}/pulls/1/merge`
      ) {
        mergeCalls += 1;
        const headSha = mergeCommitSha;
        if (!headSha) throw new Error("merge endpoint has no candidate head");
        merged = true;
        await execa("git", ["update-ref", "refs/heads/main", headSha], { cwd: fixture.remote });
        await jsonResponse(response, {
          merged: true,
          sha: headSha,
          message: "Pull Request successfully merged",
        });
        return;
      }
      if (url.pathname === `/repos/example/${fixture.taskId}/issues/1/comments`) {
        if (method === "GET") {
          await jsonResponse(
            response,
            attestationBody
              ? [
                  {
                    id: 7,
                    body: attestationBody,
                    performed_via_github_app: { slug: "usine-app" },
                    user: { type: "Bot" },
                  },
                ]
              : [],
          );
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
          attestationBody = parsed.body;
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
    } catch {
      if (!response.writableEnded)
        await jsonResponse(response, { message: "fixture handler failed" }, 500);
    }
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
    get mergeCalls() {
      return mergeCalls;
    },
    pipelineConfigured,
    get pipelineObservations() {
      return pipelineObservations;
    },
    captureRequests,
    setCaptureStatus(status: number) {
      captureStatus = status;
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
  mode: "complete" | "kill" | "campaign-abandon",
): NodeJS.ProcessEnv {
  return {
    USINE_STATE_DIR: fixture.stateDirectory,
    USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "usine-app",
    USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_DEFAULT_API_URL: forge.url,
    USINE_FORGE_PROFILE_DEFAULT_GIT_URL: fixture.remote,
    USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${fixture.taskId}`,
    ...(forge.pipelineConfigured
      ? { USINE_FORGE_PROFILE_DEFAULT_PIPELINE_CHECK_RUNS: JSON.stringify(["build"]) }
      : {}),
    USINE_GOAL_PUBLICATION_SOURCE: `https://github.com/example/${fixture.taskId}/issues/154`,
    ...(mode === "campaign-abandon"
      ? {
          USINE_CAMPAIGN_ABANDONMENT_SOURCE: `https://github.com/example/${fixture.taskId}/issues/154`,
        }
      : {}),
    CODEX_HOME: join(fixture.root, "codex-home"),
    USINE_CODEX_PATH_OVERRIDE: fixture.fakeCodexPath,
    PATH: process.env.PATH ?? "",
    USINE_SERVER_HOST: "127.0.0.1",
    USINE_SERVER_PORT: "0",
  };
}

async function startServer(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  mode: "complete" | "kill" | "campaign-abandon",
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
  command: "register" | "submit" | "status" | "follow",
  argument: string,
  mode: "complete" | "kill" | "campaign-abandon" = "complete",
) {
  return runCliArgs(cliPath, fixture, forge, serverUrl, [command, argument], mode);
}

async function runCliArgs(
  cliPath: string,
  fixture: Fixture,
  forge: ForgeServer,
  serverUrl: string,
  args: string[],
  mode: "complete" | "kill" | "campaign-abandon" = "complete",
) {
  return execa("node", ["--no-warnings", cliPath, ...args], {
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
  taskId = fixture.taskId,
): Promise<Record<string, unknown>> {
  let lastEvidence: {
    status: Record<string, unknown> | null;
    exitCode: number | null;
    signal: string | null;
    stderr: string;
  } = { status: null, exitCode: null, signal: null, stderr: "" };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runCli(cliPath, fixture, forge, serverUrl, "status", taskId);
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

async function waitForCodingThread(stateDirectory: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await lookupTaskEvents(stateDirectory, taskId);
    if (events?.events.some((event) => event.data.type === "coding_thread_started")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for persisted coding thread activity");
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

function reapFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The fixture process may already have exited.
  }
}

describe("server-owned delivery milestone", () => {
  test("submit exits while the server delivers and follow observes the exact terminal result", async () => {
    const fixtureValue = await fixture("complete");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const server = await startServer(cliPath, fixtureValue, forge, "complete");
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
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
      const events = follow.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { sequence: number; data: { type: string } });
      expect(events.length).toBeGreaterThanOrEqual(2);
      const sequences = events.map((entry) => entry.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(
        sequences.every((sequence, index) => {
          const previous = sequences[index - 1];
          return index === 0 || (previous !== undefined && sequence > previous);
        }),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({ data: { type: "task_terminal" } });
      expect(
        events
          .slice(0, -1)
          .some((entry) =>
            [
              "task_admitted",
              "candidate_frozen",
              "project_check_completed",
              "review_completed",
            ].includes(entry.data.type),
          ),
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

  test("explicit merge authority reaches merged and advances the remote base", async () => {
    const fixtureValue = await fixture("authorized-merge", true);
    const forge = await forgeServer(fixtureValue, true);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const server = await startServer(cliPath, fixtureValue, forge, "complete");
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "submit",
        fixtureValue.contractPath,
      );
      expect(submit.exitCode, submit.stderr).toBe(0);

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
        delivery: {
          prNumber: number;
          attestationId: string;
          merge: {
            approvedHeadSha: string;
            mergeCommitSha: string;
            observedState: string;
          };
        };
      };
      expect(terminal).toMatchObject({
        taskId: fixtureValue.taskId,
        state: "merged",
        delivery: {
          prNumber: 1,
          attestationId: "7",
          merge: { approvedHeadSha: terminal.candidateSha, observedState: "merged" },
        },
      });
      expect(terminal.delivery.merge.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(terminal.delivery.merge.mergeCommitSha).toBe(terminal.candidateSha);
      expect(await git(fixtureValue.remote, "rev-parse", "refs/heads/main")).toBe(
        terminal.delivery.merge.mergeCommitSha,
      );
      expect(forge.pullRequests).toBe(1);
      expect(forge.attestations).toBe(1);
      expect(forge.mergeCalls).toBe(1);
    } finally {
      await stopServer(server);
      await forge.close();
    }
  }, 60_000);

  test("automatically resumes a pending pipeline gate and merges the same approved candidate", async () => {
    const fixtureValue = await fixture("pipeline-auto-merge", true);
    const forge = await forgeServer(fixtureValue, true, true);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const server = await startServer(cliPath, fixtureValue, forge, "complete");
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "submit",
        fixtureValue.contractPath,
      );
      expect(submit.exitCode, submit.stderr).toBe(0);

      const waiting = await waitForStatus(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        (result) =>
          result.state === "waiting" &&
          (result.waiting as { reason?: string } | null)?.reason === "pipeline_checks",
      );
      expect(waiting).toMatchObject({
        state: "waiting",
        waiting: { reason: "pipeline_checks" },
        check: { status: "passed" },
        review: { verdict: "approved" },
      });
      expect(forge.mergeCalls).toBe(0);
      expect(forge.pullRequests).toBe(1);
      expect(forge.attestations).toBe(1);

      let terminal: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const status = await runCli(
          cliPath,
          fixtureValue,
          forge,
          server.url,
          "status",
          fixtureValue.taskId,
        );
        if (status.exitCode === 0) {
          const result = JSON.parse(status.stdout) as Record<string, unknown>;
          if (result.state === "merged") {
            terminal = result;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(terminal).not.toBeNull();
      if (!terminal) throw new Error("timed out waiting for automatic pipeline merge");
      expect(terminal).toMatchObject({
        state: "merged",
        candidateSha: waiting.candidateSha,
        evidence: { implementerActivations: 1, reviewCycles: 1 },
        delivery: {
          prNumber: 1,
          attestationId: "7",
          merge: { observedState: "merged" },
        },
      });

      const historyResult = await runCliArgs(cliPath, fixtureValue, forge, server.url, [
        "task",
        "history",
        fixtureValue.taskId,
        "--json",
      ]);
      expect(historyResult.exitCode, historyResult.stderr).toBe(0);
      const history = JSON.parse(historyResult.stdout) as {
        events: Array<{ data: { type: string } }>;
      };
      expect(history.events.filter((event) => event.data.type === "candidate_frozen")).toHaveLength(
        1,
      );
      expect(
        history.events.filter((event) => event.data.type === "project_check_completed"),
      ).toHaveLength(1);
      expect(history.events.filter((event) => event.data.type === "review_completed")).toHaveLength(
        1,
      );
      expect(forge.pipelineObservations).toBe(2);
      expect(forge.pullRequests).toBe(1);
      expect(forge.attestations).toBe(1);
      expect(forge.mergeCalls).toBe(1);
    } finally {
      await stopServer(server);
      await forge.close();
    }
  }, 60_000);

  test("cancels the SDK turn before restart can create a fresh writer", async () => {
    const fixtureValue = await fixture("graceful");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "complete");
    let firstStopped = false;
    let codexPid: number | null = null;
    let descendantPid: number | null = null;
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "submit",
        fixtureValue.contractPath,
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
      await waitForCodingThread(fixtureValue.stateDirectory, fixtureValue.taskId);
      codexPid = Number(await readFile(join(fixtureValue.stateDirectory, "codex.pid"), "utf8"));
      descendantPid = Number(
        await readFile(join(fixtureValue.stateDirectory, "descendant.pid"), "utf8"),
      );
      expect(processAlive(descendantPid)).toBe(true);

      await stopServer(first, "SIGINT");
      firstStopped = true;
      const firstResult = await first.child;
      expect(firstResult.exitCode).toBe(130);
      expect(firstResult.signal).toBeUndefined();
      expect(processAlive(codexPid)).toBe(false);
      const interrupted = await lookupTaskStatus(fixtureValue.stateDirectory, fixtureValue.taskId);
      const interruptedEvents = await lookupTaskEvents(
        fixtureValue.stateDirectory,
        fixtureValue.taskId,
      );
      expect(interrupted).not.toBeNull();
      expect(
        interruptedEvents?.events.some((event) => event.data.type === "coding_session_started"),
      ).toBe(true);
      expect(
        interruptedEvents?.events.some((event) => event.data.type === "coding_thread_started"),
      ).toBe(true);
      expect(
        interruptedEvents?.events.some((event) => event.data.type === "coding_session_interrupted"),
      ).toBe(true);

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
          delivery: { prNumber: number; attestationId: string };
        };
        expect(terminal).toMatchObject({
          state: "reviewed_pr",
          evidence: { implementerActivations: 2, restartRecoveries: 1 },
          delivery: { prNumber: 1, attestationId: "7" },
        });
        expect(terminal.candidateSha).toMatch(/^[0-9a-f]{40}$/);
        const evidenceResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "task",
          "evidence",
          fixtureValue.taskId,
          "--json",
        ]);
        expect(evidenceResult.exitCode, evidenceResult.stderr).toBe(0);
        const evidence = JSON.parse(evidenceResult.stdout) as {
          roleRuns: {
            implementer: Array<{
              activation: number | null;
              outcome: { status: string };
              archive: { status: string };
            }>;
          };
        };
        expect(evidence.roleRuns.implementer).toHaveLength(2);
        expect(evidence.roleRuns.implementer[0]).toMatchObject({
          outcome: { status: "cancelled" },
          archive: { status: "partial" },
        });
        expect(evidence.roleRuns.implementer[1]?.outcome.status).toBe("succeeded");
        const usageResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "usage",
          "--task-id",
          fixtureValue.taskId,
          "--json",
        ]);
        expect(usageResult.exitCode, usageResult.stderr).toBe(0);
        const usage = JSON.parse(usageResult.stdout) as {
          invocations: Array<{
            role: string;
            activation: number | null;
            outcome: string;
            usage: { coverage: string };
          }>;
        };
        expect(usage.invocations).toHaveLength(3);
        expect(
          usage.invocations.filter((invocation) => invocation.role === "implementer"),
        ).toHaveLength(2);
        expect(usage.invocations.find((invocation) => invocation.activation === 1)).toMatchObject({
          outcome: "cancelled",
          usage: { coverage: "unavailable" },
        });
        expect(usage.invocations.find((invocation) => invocation.activation === 2)?.outcome).toBe(
          "succeeded",
        );
        await expect(
          readFile(
            join(
              fixtureValue.stateDirectory,
              "workspaces",
              fixtureValue.taskId,
              "2-1",
              "stale-after-loss",
            ),
            "utf8",
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await git(fixtureValue.remote, "rev-parse", `refs/heads/${fixtureValue.branch}`),
        ).toBe(terminal.candidateSha);
        expect(forge.pullRequests).toBe(1);
        expect(forge.attestations).toBe(1);
      } finally {
        await stopServer(second);
      }
    } finally {
      if (!firstStopped) await stopServer(first).catch(() => undefined);
      if (descendantPid) reapFixtureProcess(descendantPid);
      if (codexPid) reapFixtureProcess(codexPid);
      await forge.close();
    }
  }, 60_000);

  test("restarts after SIGKILL with one fresh activation and one external delivery", async () => {
    const fixtureValue = await fixture("restart");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "kill");
    let firstStopped = false;
    let codexPid: number | null = null;
    let descendantPid: number | null = null;
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
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
      await waitForCodingThread(fixtureValue.stateDirectory, fixtureValue.taskId);
      codexPid = Number(await readFile(join(fixtureValue.stateDirectory, "codex.pid"), "utf8"));
      descendantPid = Number(
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
        const evidenceResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "task",
          "evidence",
          fixtureValue.taskId,
          "--json",
        ]);
        expect(evidenceResult.exitCode, evidenceResult.stderr).toBe(0);
        const archiveListResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "archive",
          "list",
          fixtureValue.taskId,
          "--json",
        ]);
        expect(archiveListResult.exitCode, archiveListResult.stderr).toBe(0);
        const archiveList = (
          JSON.parse(archiveListResult.stdout) as {
            archives: Array<{
              archiveId: string;
              taskId: string;
              role: string;
              attempt: string;
              status: string;
              captureStatus: string;
              completeness: string;
            }>;
          }
        ).archives;
        const originalArchive = archiveList.find(
          (manifest) => manifest.role === "implementer" && manifest.attempt === "1",
        );
        if (originalArchive === undefined) throw new Error("original archive manifest is missing");
        expect(originalArchive).toMatchObject({
          taskId: fixtureValue.taskId,
          status: "failed",
          captureStatus: "stored",
          completeness: "partial",
        });
        const archiveManifestResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "archive",
          "manifest",
          originalArchive.archiveId,
          "--json",
        ]);
        expect(archiveManifestResult.exitCode, archiveManifestResult.stderr).toBe(0);
        expect(JSON.parse(archiveManifestResult.stdout)).toMatchObject(originalArchive);
        const evidence = JSON.parse(evidenceResult.stdout) as {
          roleRuns: {
            implementer: Array<{
              activation: number | null;
              outcome: { status: string };
              archive: { status: string };
            }>;
          };
        };
        expect(evidence.roleRuns.implementer).toHaveLength(2);
        expect(evidence.roleRuns.implementer[0]).toMatchObject({
          outcome: { status: "failed" },
          archive: { archiveId: originalArchive.archiveId, status: "partial" },
        });
        expect(evidence.roleRuns.implementer[1]?.outcome.status).toBe("succeeded");
        const usageResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "usage",
          "--task-id",
          fixtureValue.taskId,
          "--json",
        ]);
        expect(usageResult.exitCode, usageResult.stderr).toBe(0);
        const usage = JSON.parse(usageResult.stdout) as {
          invocations: Array<{
            role: string;
            activation: number | null;
            outcome: string;
            usage: { coverage: string };
          }>;
        };
        expect(usage.invocations).toHaveLength(3);
        expect(
          usage.invocations.filter((invocation) => invocation.role === "implementer"),
        ).toHaveLength(2);
        expect(usage.invocations.find((invocation) => invocation.activation === 1)).toMatchObject({
          outcome: "failed",
          usage: { coverage: "unavailable" },
        });
        expect(usage.invocations.find((invocation) => invocation.activation === 2)?.outcome).toBe(
          "succeeded",
        );
        expect(forge.pullRequests).toBe(1);
        expect(forge.attestations).toBe(1);
        expect(
          await git(fixtureValue.remote, "rev-parse", `refs/heads/${fixtureValue.branch}`),
        ).toBe(terminal.candidateSha);
        await writeFile(join(fixtureValue.stateDirectory, "release-stale-child"), "release\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(
          readFile(
            join(
              fixtureValue.stateDirectory,
              "workspaces",
              fixtureValue.taskId,
              "2-1",
              "stale-after-loss",
            ),
            "utf8",
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
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
      if (descendantPid) reapFixtureProcess(descendantPid);
      if (codexPid) reapFixtureProcess(codexPid);
      await forge.close();
    }
  }, 60_000);

  test("recovers an interrupted quota-free Campaign invocation after SIGKILL", async () => {
    const fixtureValue = await fixture("campaign-restart");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "kill");
    let firstStopped = false;
    let codexPid: number | null = null;
    let descendantPid: number | null = null;
    const campaignTaskId = `campaign-${fixtureValue.taskId}-goal-v1-campaign-interruption`;
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
      const publishedResult = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "publish",
        fixtureValue.campaignContractPath,
        "--json",
      ]);
      expect(publishedResult.exitCode, publishedResult.stderr).toBe(0);
      const published = JSON.parse(publishedResult.stdout) as { campaignId: string };
      const proposedResult = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "propose",
        published.campaignId,
        fixtureValue.campaignProposalPath,
        "--json",
      ]);
      expect(proposedResult.exitCode, proposedResult.stderr).toBe(0);
      const handedOff = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "handoff",
        published.campaignId,
        "--json",
      ]);
      expect(handedOff.exitCode, handedOff.stderr).toBe(0);

      let publicHistory: { events: Array<{ data: { type: string } }> } | null = null;
      type PublicHistory = { events: Array<{ data: { type: string } }> };
      let lastHistoryResult: { exitCode: number | null; signal: string | null; stderr: string } = {
        exitCode: null,
        signal: null,
        stderr: "",
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const historyResult = await runCliArgs(
          cliPath,
          fixtureValue,
          forge,
          first.url,
          ["task", "history", campaignTaskId, "--json"],
          "kill",
        );
        lastHistoryResult = {
          exitCode: historyResult.exitCode ?? null,
          signal: historyResult.signal ?? null,
          stderr: historyResult.stderr.slice(-2_000),
        };
        if (historyResult.exitCode === 0) {
          const history = JSON.parse(historyResult.stdout) as PublicHistory;
          if (
            history.events.some((event) => event.data.type === "coding_thread_started") &&
            history.events.some((event) => event.data.type === "coding_usage_observed")
          ) {
            publicHistory = history;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(publicHistory, JSON.stringify(lastHistoryResult)).not.toBeNull();
      const startedResult = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "task",
        "get",
        campaignTaskId,
        "--json",
      ]);
      expect(startedResult.exitCode, startedResult.stderr).toBe(0);
      const started = JSON.parse(startedResult.stdout) as { deadlineEpochMs?: number };
      expect(started.deadlineEpochMs).toBeUndefined();
      codexPid = Number(await readFile(join(fixtureValue.stateDirectory, "codex.pid"), "utf8"));
      descendantPid = Number(
        await readFile(join(fixtureValue.stateDirectory, "descendant.pid"), "utf8"),
      );
      expect(processAlive(descendantPid)).toBe(true);

      await stopServer(first, "SIGKILL");
      firstStopped = true;

      const second = await startServer(cliPath, fixtureValue, forge, "complete");
      try {
        const recoveredTask = await waitForStatus(
          cliPath,
          fixtureValue,
          forge,
          second.url,
          (result) => result.taskId === campaignTaskId && result.state === "reviewed_pr",
          campaignTaskId,
        );
        expect(recoveredTask).toMatchObject({ state: "reviewed_pr" });
        let recoveredCampaign: { status?: string } | null = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const campaignResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
            "campaign",
            "get",
            published.campaignId,
            "--json",
          ]);
          if (campaignResult.exitCode === 0) {
            const campaign = JSON.parse(campaignResult.stdout) as { status?: string };
            if (campaign.status === "accepted") {
              recoveredCampaign = campaign;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(recoveredCampaign).toMatchObject({ status: "accepted" });
        const recoveredHistoryResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "task",
          "history",
          campaignTaskId,
          "--json",
        ]);
        expect(recoveredHistoryResult.exitCode, recoveredHistoryResult.stderr).toBe(0);
        const recoveredHistory = JSON.parse(recoveredHistoryResult.stdout) as PublicHistory;
        expect(
          recoveredHistory.events.filter((event) => event.data.type === "coding_session_started"),
        ).toHaveLength(3);
        expect(
          recoveredHistory.events.filter(
            (event) => event.data.type === "coding_session_interrupted",
          ),
        ).toHaveLength(1);

        const campaignEvidenceResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "campaign",
          "evidence",
          published.campaignId,
          "--json",
        ]);
        expect(campaignEvidenceResult.exitCode, campaignEvidenceResult.stderr).toBe(0);
        const campaignEvidence = JSON.parse(campaignEvidenceResult.stdout) as {
          coverage: string;
          totals: {
            invocations: number;
            usage: { inputTokens: number | null; outputTokens: number | null };
          };
          runs: Array<{
            invocationId: string;
            taskId: string;
            role: string;
            activation: number;
            outcome: string;
            usage: { inputTokens: number; outputTokens: number; coverage: string };
          }>;
        };
        expect(campaignEvidence.coverage).toBe("partial");
        expect(campaignEvidence.totals.invocations).toBe(campaignEvidence.runs.length);
        const recoveredRun = campaignEvidence.runs.find((run) => run.taskId === campaignTaskId);
        if (!recoveredRun) throw new Error("Campaign evidence has no recovered Task invocation");
        expect(recoveredRun).toMatchObject({
          taskId: campaignTaskId,
          role: "implementer",
          activation: 1,
          outcome: "failed",
          usage: { inputTokens: 12, outputTokens: 3, coverage: "partial" },
        });

        const taskUsageResult = await runCliArgs(cliPath, fixtureValue, forge, second.url, [
          "usage",
          "--task-id",
          campaignTaskId,
          "--json",
        ]);
        expect(taskUsageResult.exitCode, taskUsageResult.stderr).toBe(0);
        const taskUsage = JSON.parse(taskUsageResult.stdout) as {
          coverage: string;
          invocations: Array<{
            invocationId: string;
            outcome: string;
            usage: { inputTokens: number; outputTokens: number; coverage: string };
          }>;
        };
        expect(taskUsage).toMatchObject({ coverage: "partial" });
        expect(taskUsage.invocations).toHaveLength(3);
        expect(taskUsage.invocations[0]).toMatchObject({
          invocationId: recoveredRun.invocationId,
          outcome: recoveredRun.outcome,
          usage: recoveredRun.usage,
        });

        const captureEnvironment = {
          ...environment(fixtureValue, forge, "complete"),
          USINE_POSTHOG_API_KEY: "test-posthog-key",
          USINE_POSTHOG_DEPLOYMENT: "milestone-deployment",
          USINE_POSTHOG_API_URL: `${forge.url}/batch/`,
        };
        forge.setCaptureStatus(503);
        await expect(
          captureCampaignEvidence(
            fixtureValue.stateDirectory,
            published.campaignId,
            captureEnvironment,
          ),
        ).rejects.toThrow();
        const failedCapture = forge.captureRequests.at(-1);
        const failedGeneration = failedCapture?.batch?.find(
          (event) =>
            event.event === "$ai_generation" && event.properties?.task_id === campaignTaskId,
        );
        expect(failedGeneration).toMatchObject({
          properties: {
            invocation_id: recoveredRun.invocationId,
            task_id: campaignTaskId,
            $ai_input_tokens: 12,
            $ai_output_tokens: 3,
            token_coverage: "partial",
          },
        });
        forge.setCaptureStatus(200);
        await captureCampaignEvidence(
          fixtureValue.stateDirectory,
          published.campaignId,
          captureEnvironment,
        );
        const successfulCapture = forge.captureRequests.at(-1);
        expect(successfulCapture?.batch?.map((event) => event.uuid)).toEqual(
          failedCapture?.batch?.map((event) => event.uuid),
        );
        const requestCount = forge.captureRequests.length;
        await captureCampaignEvidence(
          fixtureValue.stateDirectory,
          published.campaignId,
          captureEnvironment,
        );
        expect(forge.captureRequests).toHaveLength(requestCount);
      } finally {
        await stopServer(second);
      }
    } finally {
      if (!firstStopped) await stopServer(first, "SIGKILL").catch(() => undefined);
      if (descendantPid) reapFixtureProcess(descendantPid);
      if (codexPid) reapFixtureProcess(codexPid);
      await forge.close();
    }
  }, 60_000);

  test("abandons a live Campaign through the CLI before delivery and stays abandoned after restart", async () => {
    const fixtureValue = await fixture("campaign-abandon");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const first = await startServer(cliPath, fixtureValue, forge, "campaign-abandon");
    let firstStopped = false;
    let codexPid: number | null = null;
    let descendantPid: number | null = null;
    const campaignTaskId = `campaign-${fixtureValue.taskId}-goal-v1-campaign-interruption`;
    try {
      for (const [command, argument] of [["register", fixtureValue.registrationPath]] as const) {
        const result = await runCli(cliPath, fixtureValue, forge, first.url, command, argument);
        expect(result.exitCode, result.stderr).toBe(0);
      }
      const publishedResult = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "publish",
        fixtureValue.campaignContractPath,
        "--json",
      ]);
      expect(publishedResult.exitCode, publishedResult.stderr).toBe(0);
      const published = JSON.parse(publishedResult.stdout) as { campaignId: string };
      const proposedResult = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "propose",
        published.campaignId,
        fixtureValue.campaignProposalPath,
        "--json",
      ]);
      expect(proposedResult.exitCode, proposedResult.stderr).toBe(0);
      const handedOff = await runCliArgs(cliPath, fixtureValue, forge, first.url, [
        "campaign",
        "handoff",
        published.campaignId,
        "--json",
      ]);
      expect(handedOff.exitCode, handedOff.stderr).toBe(0);

      await waitForStatus(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        (result) => result.activeActivation === 1,
        campaignTaskId,
      );
      await waitForMarker(join(fixtureValue.stateDirectory, "activation.marker"));
      await waitForCodingThread(fixtureValue.stateDirectory, campaignTaskId);
      codexPid = Number(await readFile(join(fixtureValue.stateDirectory, "codex.pid"), "utf8"));
      descendantPid = Number(
        await readFile(join(fixtureValue.stateDirectory, "descendant.pid"), "utf8"),
      );
      expect(processAlive(descendantPid)).toBe(true);

      expect(processAlive(codexPid)).toBe(true);
      await expect
        .poll(async () => {
          const events = await lookupTaskEvents(fixtureValue.stateDirectory, campaignTaskId);
          return events?.events.some((event) => event.data.type === "coding_usage_observed");
        })
        .toBe(true);

      const abandonedResult = await runCliArgs(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        ["campaign", "abandon", published.campaignId, "--json"],
        "campaign-abandon",
      );
      expect(abandonedResult.exitCode, abandonedResult.stderr).toBe(0);
      expect(JSON.parse(abandonedResult.stdout)).toMatchObject({ status: "abandoned" });
      // The public abandon response is the cleanup barrier for the cooperative fixture.
      expect(processAlive(codexPid)).toBe(false);
      expect(processAlive(descendantPid)).toBe(false);
      expect(forge.pullRequests).toBe(0);
      expect(forge.attestations).toBe(0);
      expect(forge.mergeCalls).toBe(0);
      expect(await readFile(join(fixtureValue.stateDirectory, "codex.invocations"), "utf8")).toBe(
        "implementer\n",
      );
      const usageResult = await runCliArgs(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        ["usage", "--task-id", campaignTaskId, "--json"],
        "campaign-abandon",
      );
      expect(usageResult.exitCode, usageResult.stderr).toBe(0);
      const usage = JSON.parse(usageResult.stdout) as {
        invocations: Array<{
          role: string;
          activation: number | null;
          outcome: string;
          usage: { inputTokens: number | null; outputTokens: number | null; coverage: string };
        }>;
      };
      expect(usage.invocations).toHaveLength(1);
      expect(usage.invocations).toMatchObject([
        {
          role: "implementer",
          activation: 1,
          outcome: "cancelled",
          usage: { inputTokens: 12, outputTokens: 3, coverage: "partial" },
        },
      ]);

      const taskAfterAbandon = await runCli(
        cliPath,
        fixtureValue,
        forge,
        first.url,
        "status",
        campaignTaskId,
        "campaign-abandon",
      );
      expect(taskAfterAbandon.exitCode, taskAfterAbandon.stderr).toBe(0);
      expect(JSON.parse(taskAfterAbandon.stdout)).toMatchObject({ state: "blocked" });
      await stopServer(first);
      firstStopped = true;

      const restarted = await startServer(cliPath, fixtureValue, forge, "campaign-abandon");
      try {
        const campaignAfterRestart = await runCliArgs(
          cliPath,
          fixtureValue,
          forge,
          restarted.url,
          ["campaign", "get", published.campaignId, "--json"],
          "campaign-abandon",
        );
        expect(campaignAfterRestart.exitCode, campaignAfterRestart.stderr).toBe(0);
        expect(JSON.parse(campaignAfterRestart.stdout)).toMatchObject({ status: "abandoned" });
        const taskAfterRestart = await runCli(
          cliPath,
          fixtureValue,
          forge,
          restarted.url,
          "status",
          campaignTaskId,
          "campaign-abandon",
        );
        expect(taskAfterRestart.exitCode, taskAfterRestart.stderr).toBe(0);
        expect(await readFile(join(fixtureValue.stateDirectory, "codex.invocations"), "utf8")).toBe(
          "implementer\n",
        );
        expect(JSON.parse(taskAfterRestart.stdout)).toEqual(JSON.parse(taskAfterAbandon.stdout));
        expect(forge.pullRequests).toBe(0);
        expect(forge.attestations).toBe(0);
        expect(forge.mergeCalls).toBe(0);
      } finally {
        await stopServer(restarted);
      }
    } finally {
      if (!firstStopped) await stopServer(first).catch(() => undefined);
      if (descendantPid) reapFixtureProcess(descendantPid);
      if (codexPid) reapFixtureProcess(codexPid);
      await forge.close();
    }
  }, 60_000);

  test("stops a long-running reviewer before server shutdown completes", async () => {
    const fixtureValue = await fixture("reviewer-shutdown");
    const forge = await forgeServer(fixtureValue);
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const server = await startServer(cliPath, fixtureValue, forge, "complete");
    let reviewerPid: number | null = null;
    try {
      const registered = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "register",
        fixtureValue.registrationPath,
      );
      expect(registered.exitCode, registered.stderr).toBe(0);
      const submit = await runCli(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        "submit",
        fixtureValue.contractPath,
      );
      expect(submit.exitCode, submit.stderr).toBe(0);
      await waitForStatus(
        cliPath,
        fixtureValue,
        forge,
        server.url,
        (result) => result.state === "checked",
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          reviewerPid = Number(
            await readFile(join(fixtureValue.stateDirectory, "reviewer.pid"), "utf8"),
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!reviewerPid) throw new Error("timed out waiting for the reviewer process");
      expect(processAlive(reviewerPid)).toBe(true);

      await stopServer(server);

      expect(processAlive(reviewerPid)).toBe(false);
    } finally {
      if (reviewerPid) reapFixtureProcessGroup(reviewerPid);
      await stopServer(server).catch(() => undefined);
      await forge.close();
    }
  }, 60_000);
});
