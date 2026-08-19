import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";

const fakeCodexLoader = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Codex {
  startThread(options) {
    return {
      id: "public-cli-progress-test",
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
        await writeFile(join(options.workingDirectory, "candidate.txt"), "candidate\n");
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function jsonResponse(
  response: import("node:http").ServerResponse,
  body: unknown,
): Promise<void> {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

describe("CLI live progress seam", () => {
  test("streams bounded durable progress before the single terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-cli-progress-"));
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    const stateDirectory = join(root, "state");
    const loaderPath = join(root, "codex-loader.mjs");
    const fakeCodexPath = join(root, "fake-codex.mjs");
    const taskId = `cli-progress-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const branch = `agent/${taskId}`;

    await mkdir(repository);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execa("git", ["config", "user.name", "Test"], { cwd: repository });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "base\n");
    await execa("git", ["add", "."], { cwd: repository });
    await execa("git", ["commit", "-m", "base"], { cwd: repository });
    const baseSha = await git(repository, "rev-parse", "HEAD");
    await writeFile(
      join(repository, "task.json"),
      JSON.stringify({
        id: taskId,
        repository: { path: ".", owner: "example", name: taskId },
        baseSha,
        instructions: "Exercise the public progress boundary.",
        acceptance: ["The terminal result is delivered."],
        nonGoals: [],
        projectCheck: { command: "test -f candidate.txt", timeoutMs: 10_000 },
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
        authorization: {
          source: `https://github.com/example/${taskId}/issues/126`,
          delivery: true,
        },
        delivery: {
          baseBranch: "main",
          branch,
          issue: 126,
          title: "CLI progress",
          body: "CLI progress",
        },
      }),
    );
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize"], { cwd: repository });
    await execa("git", ["init", "--bare", remote]);
    await writeFile(fakeCodexPath, fakeCodexLoader);
    await writeFile(loaderPath, fakeCodexRedirectLoader);

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      if (request.headers.authorization !== "token test-token") {
        response.statusCode = 401;
        await jsonResponse(response, { message: "bad credentials" });
        return;
      }
      if (method === "GET" && url.pathname.endsWith(`/git/ref/heads/${branch}`)) {
        response.statusCode = 404;
        await jsonResponse(response, { message: "Not Found" });
        return;
      }
      if (method === "GET" && url.pathname === `/repos/example/${taskId}/pulls`) {
        await jsonResponse(response, []);
        return;
      }
      if (method === "POST" && url.pathname === `/repos/example/${taskId}/pulls`) {
        const headSha = await git(remote, "rev-parse", `refs/heads/${branch}`);
        response.statusCode = 201;
        await jsonResponse(response, {
          number: 1,
          state: "open",
          head: { sha: headSha },
          html_url: "http://example.invalid/pull/1",
        });
        return;
      }
      // ForgeDelivery lists comments on the created pull request, not on the
      // Issue number carried by the Task Contract.
      if (url.pathname === `/repos/example/${taskId}/issues/1/comments`) {
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
          )
            throw new Error("forge comment body is invalid");
          response.statusCode = 201;
          await jsonResponse(response, {
            id: 7,
            body: parsed.body,
            performed_via_github_app: { slug: "usine-app" },
            user: { type: "Bot" },
          });
          return;
        }
      }
      response.statusCode = 404;
      await jsonResponse(response, { message: `unhandled ${method} ${url.pathname}` });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("progress test server did not bind");

    try {
      const run = await execa(
        "node",
        [
          "--no-warnings",
          "--experimental-loader",
          loaderPath,
          join(process.cwd(), "apps/cli/dist/cli.mjs"),
          "run",
          "task.json",
        ],
        {
          cwd: repository,
          env: {
            USINE_STATE_DIR: stateDirectory,
            USINE_GIT_AUTHOR_NAME: "Release Bot",
            USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
            USINE_GITHUB_APP_SLUG: "usine-app",
            USINE_GITHUB_TEST_TOKEN: "test-token",
            USINE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            USINE_GITHUB_GIT_URL: remote,
            USINE_FAKE_CODEX_MODULE: fakeCodexPath,
          },
          reject: false,
        },
      );

      expect(run.exitCode, run.stderr).toBe(0);
      const stdoutRecords = run.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(stdoutRecords).toHaveLength(1);
      const terminal = stdoutRecords[0];
      expect(terminal).toMatchObject({ taskId, state: "reviewed_pr" });
      expect(terminal.writer).toEqual({ repositoryIdentity: `example/${taskId}` });
      expect(run.stdout).not.toContain('"repository":"."');

      const progress = run.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(progress.length).toBeGreaterThanOrEqual(5);
      const allowedKeys = [
        "event",
        "taskId",
        "revision",
        "state",
        "activeActivation",
        "candidateSha",
      ];
      for (const record of progress) {
        expect(Object.keys(record)).toEqual(allowedKeys);
        expect(record.event).toBe("progress");
        expect(record.taskId).toBe(taskId);
      }
      const revisions = progress.map((record) => record.revision);
      expect(revisions).toEqual([...new Set(revisions)].toSorted((left, right) => left - right));
      const reservationIndex = progress.findIndex(
        (record) => record.state === "admitted" && record.activeActivation === 1,
      );
      const candidateIndex = progress.findIndex(
        (record) => record.state === "candidate" && typeof record.candidateSha === "string",
      );
      expect(reservationIndex).toBeGreaterThanOrEqual(0);
      expect(candidateIndex).toBeGreaterThan(reservationIndex);
      expect(progress[reservationIndex]).toMatchObject({ candidateSha: null, revision: 1 });
      expect(progress[candidateIndex].candidateSha).toBe(terminal.candidateSha);
      expect(progress.at(-1)).toMatchObject({
        state: "reviewed_pr",
        candidateSha: terminal.candidateSha,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
