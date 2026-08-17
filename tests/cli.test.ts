import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

describe("usine run", () => {
  test("rejects a contract before starting work when required authority is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-contract-"));
    const contractPath = join(directory, "task.json");
    await writeFile(contractPath, JSON.stringify({ id: "task-without-authority" }));

    const result = await execa("node", ["dist/cli.mjs", "run", contractPath], {
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "invalid_task_contract",
      issues: expect.arrayContaining([
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
          repository: { path: repository, owner: "example", name: "fixture" },
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
      const first = await execa("node", ["dist/cli.mjs", "run", contractPath], {
        env,
        reject: false,
      });
      const second = await execa("node", ["dist/cli.mjs", "run", contractPath], {
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
    "delivers one checked and independently approved immutable candidate",
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
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
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
          repository: { path: repository, owner: "example", name: "fixture" },
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
          repository: { path: repository, owner: "example", name: "fixture" },
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
          USINE_FAKE_REVIEW_SEQUENCE_FILE: join(stateDirectory, "review-sequence"),
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
});
