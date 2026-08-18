import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";

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

describe("CLI/SQLite admission seam", () => {
  test("keeps default coordinator state outside the target repository", async () => {
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const { repository, root, taskId } = await admissionFixture();
    const userStateRoot = join(root, "user-state");
    const run = await execa("node", [cliPath, "run", "task.json"], {
      cwd: repository,
      env: {
        USINE_STATE_DIR: undefined,
        USINE_STOP_AFTER: "admitted",
        USINE_GIT_AUTHOR_NAME: "Release Bot",
        USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
        XDG_STATE_HOME: userStateRoot,
      },
      reject: false,
    });

    expect(run.exitCode, run.stderr).toBe(75);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ taskId, state: "admitted" });
    expect(result.writer).toEqual({ repositoryIdentity: `example/${taskId}` });
    expect(run.stdout).not.toContain('"repository":"."');
    await expect(access(join(userStateRoot, "usine", "usine.sqlite"))).resolves.toBeUndefined();
    await expect(access(join(repository, ".usine", "usine.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  test("freezes a committed contract before activation", async () => {
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const { repository, root, taskId } = await admissionFixture();
    const run = await execa("node", [cliPath, "run", "task.json"], {
      cwd: repository,
      env: {
        USINE_STATE_DIR: join(root, "state"),
        USINE_STOP_AFTER: "admitted",
        USINE_GIT_AUTHOR_NAME: "Release Bot",
        USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
      },
      reject: false,
    });
    expect(run.exitCode, run.stderr).toBe(75);
    expect(JSON.parse(run.stdout)).toMatchObject({
      taskId,
      state: "admitted",
      candidateSha: null,
    });
  }, 30_000);

  test("reuses the first admission deadline before verifying a restarted contract", async () => {
    const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
    const maxElapsedMs = 4_000;
    const { repository, root, taskId } = await admissionFixture(maxElapsedMs);
    const env = {
      USINE_STATE_DIR: join(root, "state"),
      USINE_STOP_AFTER: "admitted",
      USINE_GIT_AUTHOR_NAME: "Release Bot",
      USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
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

    expect(restarted.exitCode, restarted.stderr).toBe(75);
    const blocked = JSON.parse(restarted.stdout);
    expect(blocked).toMatchObject({
      taskId,
      state: "blocked",
      blocker: "elapsed budget exhausted",
    });

    const terminalRestart = await execa("node", [cliPath, "run", "task.json"], {
      cwd: repository,
      env,
      reject: false,
    });
    expect(terminalRestart.exitCode, terminalRestart.stderr).toBe(75);
    expect(JSON.parse(terminalRestart.stdout)).toEqual(blocked);

    const successorId = `${taskId}-successor`;
    const original = JSON.parse(await readFile(join(repository, "task.json"), "utf8"));
    const successor = {
      ...original,
      id: successorId,
      delivery: {
        ...original.delivery,
        branch: `agent/${successorId}`,
      },
    };
    await writeFile(join(repository, "successor.json"), JSON.stringify(successor));
    await execa("git", ["add", "successor.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize successor"], { cwd: repository });
    const successorRun = await execa("node", [cliPath, "run", "successor.json"], {
      cwd: repository,
      env,
      reject: false,
    });
    expect(successorRun.exitCode, successorRun.stderr).toBe(75);
    expect(JSON.parse(successorRun.stdout)).toMatchObject({
      taskId: successorId,
      state: "admitted",
    });
  }, 30_000);
});
