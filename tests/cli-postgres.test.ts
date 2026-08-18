import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

async function admissionFixture(maxElapsedMs = 30_000) {
  const root = await mkdtemp(join(tmpdir(), "usine-admission-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "admission\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const taskId = `admission-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(
    join(repository, "task.json"),
    JSON.stringify({
      id: taskId,
      repository: { path: ".", owner: "example", name: taskId },
      baseSha,
      instructions: "No activation",
      acceptance: ["Admission is durable"],
      nonGoals: [],
      projectCheck: { command: "true", timeoutMs: 1000 },
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs },
      authorization: { source: "test issue", delivery: true },
      delivery: {
        baseBranch: "main",
        branch: `agent/${taskId}`,
        issue: 1,
        title: "Admission",
        body: "Admission",
      },
    }),
  );
  await execa("git", ["add", "task.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize"], { cwd: repository });
  return { repository, root, taskId };
}

describe("CLI/PostgreSQL admission seam", () => {
  test.runIf(Boolean(process.env.USINE_TEST_DATABASE_URL))(
    "freezes a committed contract before activation",
    async () => {
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const { repository, root, taskId } = await admissionFixture();
      const run = await execa("node", [cliPath, "run", "task.json"], {
        cwd: repository,
        env: {
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_STATE_DIR: join(root, "state"),
          USINE_STOP_AFTER: "admitted",
        },
        reject: false,
      });
      expect(run.exitCode, run.stderr).toBe(75);
      expect(JSON.parse(run.stdout)).toMatchObject({
        taskId,
        state: "admitted",
        candidateSha: null,
      });
    },
    30_000,
  );

  test.runIf(Boolean(process.env.USINE_TEST_DATABASE_URL))(
    "reuses the first admission deadline before verifying a restarted contract",
    async () => {
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const maxElapsedMs = 4_000;
      const { repository, root } = await admissionFixture(maxElapsedMs);
      const env = {
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_STATE_DIR: join(root, "state"),
        USINE_STOP_AFTER: "admitted",
      };
      const first = await execa("node", [cliPath, "run", "task.json"], {
        cwd: repository,
        env,
        reject: false,
      });
      expect(first.exitCode, first.stderr).toBe(75);

      await new Promise((resolve) => setTimeout(resolve, maxElapsedMs + 100));
      const restarted = await execa("node", [cliPath, "run", "task.json"], {
        cwd: repository,
        env,
        reject: false,
      });

      expect(restarted.exitCode).toBe(1);
      expect(restarted.stderr).toContain("elapsed budget exhausted");
    },
    30_000,
  );
});
