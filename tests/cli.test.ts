import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

describe("usine run", () => {
  test("rejects a contract before starting work when required authority is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-contract-"));
    const contractPath = join(directory, "task.json");
    await writeFile(contractPath, JSON.stringify({ id: "../task-without-authority" }));

    const result = await execa("node", ["dist/cli.mjs", "run", contractPath], {
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "invalid_task_contract",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "id" }),
        expect.objectContaining({ path: "authorization" }),
        expect.objectContaining({ path: "baseSha" }),
      ]),
    });
    await expect(readFile(join(directory, "result.json"), "utf8")).rejects.toThrow();
  });

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "admits one committed contract durably without duplicating its writer",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-admission-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `admission-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Add the requested fixture behavior.",
          acceptance: ["The fixture check passes."],
          nonGoals: [],
          projectCheck: { command: "node --check README.md", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture delivery",
            body: "Fixture delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

      const env = {
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_STATE_DIR: stateDirectory,
        USINE_STOP_AFTER: "admitted",
      };
      const first = await execa("node", [cliPath, "run", contractPath], {
        cwd: directory,
        env,
        reject: false,
      });
      const second = await execa("node", [cliPath, "run", contractPath], {
        cwd: directory,
        env,
        reject: false,
      });

      expect(first.exitCode).toBe(75);
      expect(second.exitCode).toBe(75);
      const firstResult = JSON.parse(first.stdout);
      const secondResult = JSON.parse(second.stdout);
      const canonicalRepository = await realpath(repository);
      expect(firstResult).toMatchObject({
        taskId,
        state: "admitted",
        writer: { generation: 1, repository: canonicalRepository },
      });
      expect(secondResult).toEqual(firstResult);
      expect(
        JSON.parse(await readFile(join(stateDirectory, "results", `${taskId}.json`), "utf8")),
      ).toEqual(firstResult);
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "freezes admitted input and leases one normalized repository identity across clone paths",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-frozen-"));
      const repository = join(directory, "repository");
      const secondRepository = join(directory, "second-clone");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `frozen-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      const contract = {
        id: taskId,
        repository: { path: repository, owner: "Example", name: "Fixture" },
        baseSha,
        instructions: "Original frozen instructions.",
        acceptance: ["The task remains frozen."],
        nonGoals: [],
        projectCheck: { command: "true", timeoutMs: 10_000 },
        budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 60_000 },
        authorization: { source: "test issue", delivery: true },
        delivery: {
          baseBranch: "main",
          branch: `agent/${taskId}`,
          issue: 3,
          title: "Frozen task",
          body: "Frozen task body",
        },
      };
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const env = {
        USINE_CRASH_AFTER: "admitted",
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_STATE_DIR: stateDirectory,
      };

      const interrupted = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env,
        reject: false,
      });
      expect(interrupted.signal).toBe("SIGKILL");

      contract.instructions = "Mutated instructions must not resume.";
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "mutate admitted task"], { cwd: repository });
      const mutated = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env,
        reject: false,
      });
      expect(mutated.exitCode).toBe(1);
      expect(mutated.stderr).toContain("admitted contract is immutable");

      await execa("git", ["clone", repository, secondRepository]);
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: secondRepository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], {
        cwd: secondRepository,
      });
      const secondId = `${taskId}-second`;
      const secondContractPath = join(secondRepository, "task.json");
      await writeFile(
        secondContractPath,
        JSON.stringify({
          ...contract,
          id: secondId,
          instructions: "A second clone must not receive a writer.",
          repository: { ...contract.repository, path: secondRepository },
          delivery: { ...contract.delivery, branch: `agent/${secondId}` },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: secondRepository });
      await execa("git", ["commit", "-m", "authorize competing task"], { cwd: secondRepository });
      const competing = await execa("node", ["dist/cli.mjs", "run", secondContractPath], {
        env: { ...env, USINE_CRASH_AFTER: undefined },
        reject: false,
      });
      expect(competing.exitCode).toBe(1);
      expect(competing.stderr).toContain("repository already has an active writer");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "recovers one early-stopping implementer and delivers its approved candidate",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-delivery-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; if (process.env.USINE_DATABASE_URL || process.env.USINE_TEST_SECRET) throw new Error("secret leaked to project check"); await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `delivery-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Stop once, then create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture delivery",
            body: "Fixture delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const authorizationSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository }))
        .stdout;
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));

      const run = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodex,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: stateDirectory,
          USINE_TEST_SECRET: "must-not-leak",
        },
        reject: false,
      });

      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        taskId,
        state: "reviewed_pr",
        check: { status: "passed" },
        review: { verdict: "approved" },
        delivery: { effect: "recorded" },
        evidence: { implementerActivations: 2 },
      });
      expect(result.candidateSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.check.sha).toBe(result.candidateSha);
      expect(result.review.sha).toBe(result.candidateSha);
      expect(result.delivery.sha).toBe(result.candidateSha);
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(
        authorizationSha,
      );
      expect(
        (await execa("git", ["show", `${result.candidateSha}:delivered.txt`], { cwd: repository }))
          .stdout,
      ).toBe("implemented");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "aggregates requested changes into one fix activation and invalidates stale evidence",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-fix-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `fix-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt and address review findings.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture fix delivery",
            body: "Fixture fix delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));

      const run = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodex,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        state: "reviewed_pr",
        evidence: {
          changesRequestedBatches: 1,
          implementerActivations: 2,
          reviewCycles: 2,
        },
      });
      expect(result.check.sha).toBe(result.candidateSha);
      expect(result.review).toMatchObject({ sha: result.candidateSha, verdict: "approved" });
      expect(result.delivery.sha).toBe(result.candidateSha);
      expect(
        (await execa("git", ["show", `${result.candidateSha}:delivered.txt`], { cwd: repository }))
          .stdout,
      ).toContain("review-fixed");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "recovers after a coordinator crash without duplicating writer or delivery",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-restart-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      const deliveryCounter = join(directory, "delivery.json");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `restart-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture restart delivery",
            body: "Fixture restart delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));
      const env = {
        USINE_CODEX_BIN: fakeCodex,
        USINE_CRASH_AFTER: "delivery",
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_DELIVERY_MODE: "record",
        USINE_RECORD_DELIVERY_COUNTER: deliveryCounter,
        USINE_STATE_DIR: stateDirectory,
      };

      const interrupted = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env,
        reject: false,
      });
      const recovered = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env,
        reject: false,
      });

      expect(interrupted.signal).toBe("SIGKILL");
      expect(recovered.exitCode).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        state: "reviewed_pr",
        writer: { generation: 1 },
        evidence: { restartRecoveries: 1 },
      });
      expect(JSON.parse(await readFile(deliveryCounter, "utf8"))).toMatchObject({
        count: 1,
      });
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "pushes with a lease and creates or probes one PR and approval attestation",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-github-"));
      const repository = join(directory, "repository");
      const bareRemote = join(directory, "remote.git");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--bare", bareRemote]);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `github-${Date.now()}`;
      const branch = `agent/${taskId}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch,
            issue: 3,
            title: "Fixture GitHub delivery",
            body: "Fixture GitHub delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

      let prCreates = 0;
      let attestationCreates = 0;
      let prExists = false;
      let remoteSha: string | null = null;
      let activeCliPid: number | undefined;
      let failureStage: "pr" | "attestation" | null = "pr";
      const comments: Array<{ id: number; body: string; html_url: string }> = [];
      const api = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (request.method === "GET" && url.pathname.includes("/git/ref/heads/")) {
          send(
            remoteSha ? 200 : 404,
            remoteSha ? { object: { sha: remoteSha } } : { message: "Not Found" },
          );
        } else if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
          send(
            200,
            prExists
              ? [{ number: 7, html_url: "http://fixture/pr/7", head: { sha: remoteSha } }]
              : [],
          );
        } else if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
          prCreates += 1;
          prExists = true;
          remoteSha = (
            await execa("git", ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`])
          ).stdout;
          if (failureStage === "pr" && activeCliPid) {
            process.kill(activeCliPid, "SIGKILL");
            response.destroy();
            return;
          }
          send(201, {
            number: 7,
            html_url: "http://fixture/pr/7",
            head: { sha: remoteSha },
          });
        } else if (request.method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
          send(200, comments);
        } else if (request.method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
          let body = "";
          request.on("data", (chunk) => (body += String(chunk)));
          request.on("end", () => {
            attestationCreates += 1;
            const parsed = JSON.parse(body) as { body: string };
            const comment = {
              id: 99,
              body: parsed.body,
              html_url: "http://fixture/pr/7#comment-99",
            };
            comments.push(comment);
            if (failureStage === "attestation" && activeCliPid) {
              process.kill(activeCliPid, "SIGKILL");
              response.destroy();
              return;
            }
            send(201, comment);
          });
        } else {
          send(404, { message: `Unhandled ${request.method} ${url.pathname}` });
        }
      });
      await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
      const address = api.address();
      if (!address || typeof address === "string")
        throw new Error("fake GitHub API did not listen");
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));
      const env = {
        USINE_CODEX_BIN: fakeCodex,
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_DELIVERY_MODE: "github",
        USINE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        USINE_GITHUB_GIT_URL: bareRemote,
        USINE_GITHUB_TEST_TOKEN: "test-token",
        USINE_STATE_DIR: stateDirectory,
      };
      try {
        const firstRun = execa("node", ["dist/cli.mjs", "run", contractPath], {
          env,
          reject: false,
        });
        activeCliPid = firstRun.pid;
        const interruptedPr = await firstRun;
        failureStage = "attestation";
        const secondRun = execa("node", ["dist/cli.mjs", "run", contractPath], {
          env,
          reject: false,
        });
        activeCliPid = secondRun.pid;
        const interruptedAttestation = await secondRun;
        failureStage = null;
        const thirdRun = execa("node", ["dist/cli.mjs", "run", contractPath], {
          env,
          reject: false,
        });
        activeCliPid = thirdRun.pid;
        const run = await thirdRun;

        expect(interruptedPr.signal).toBe("SIGKILL");
        expect(interruptedAttestation.signal).toBe("SIGKILL");
        expect(run.exitCode).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result).toMatchObject({
          state: "reviewed_pr",
          delivery: {
            effect: "github",
            prNumber: 7,
            url: "http://fixture/pr/7",
            attestationId: "99",
          },
        });
        expect(
          (await execa("git", ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`]))
            .stdout,
        ).toBe(result.candidateSha);
        expect(prCreates).toBe(1);
        expect(attestationCreates).toBe(1);
        expect(comments[0]?.body).toContain(result.candidateSha);
      } finally {
        await new Promise<void>((resolveClose, rejectClose) =>
          api.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      }
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "quarantines an open delivery PR whose head is not the candidate",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-pr-conflict-"));
      const repository = join(directory, "repository");
      const bareRemote = join(directory, "remote.git");
      await mkdir(repository);
      await execa("git", ["init", "--bare", bareRemote]);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `pr-conflict-${Date.now()}`;
      const branch = `agent/${taskId}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["The task is committed."],
          nonGoals: [],
          projectCheck: { command: "true", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch,
            issue: 3,
            title: "Conflicting PR",
            body: "Conflicting PR body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      let prCreates = 0;
      const api = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (request.method === "GET" && url.pathname.includes("/git/ref/heads/")) {
          send(404, { message: "Not Found" });
        } else if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
          send(200, [
            { number: 6, html_url: "http://fixture/pr/6", head: { sha: "f".repeat(40) } },
          ]);
        } else if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
          prCreates += 1;
          send(201, { number: 7, html_url: "http://fixture/pr/7" });
        } else {
          send(404, { message: `Unhandled ${request.method} ${url.pathname}` });
        }
      });
      await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
      const address = api.address();
      if (!address || typeof address === "string") throw new Error("fake API did not listen");
      try {
        const result = await execa("node", ["dist/cli.mjs", "run", contractPath], {
          env: {
            USINE_CODEX_BIN: fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url)),
            USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
            USINE_DELIVERY_MODE: "github",
            USINE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            USINE_GITHUB_GIT_URL: bareRemote,
            USINE_GITHUB_TEST_TOKEN: "test-token",
            USINE_STATE_DIR: join(directory, "state"),
          },
          reject: false,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("delivery quarantined");
        expect(prCreates).toBe(0);
      } finally {
        await new Promise<void>((resolveClose, rejectClose) =>
          api.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      }
    },
    30_000,
  );
});
