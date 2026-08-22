import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import { registerRepository, submitTask, taskStatus } from "../apps/cli/src/server-client.js";
import type { RepositorySnapshot, TaskContract } from "@usine/task-authority";

const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");

type CliResult = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
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

async function runCli(serverUrl: string, ...args: readonly string[]): Promise<CliResult> {
  const result = await execa(process.execPath, ["--no-warnings", cliPath, ...args], {
    env: { ...process.env, USINE_SERVER_URL: serverUrl },
    reject: false,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function waitForCliState(
  serverUrl: string,
  taskId: string,
  state: "blocked" | "admitted",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runCli(serverUrl, "status", taskId);
    if (result.exitCode === 0 && JSON.parse(result.stdout).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${taskId} to become ${state}`);
}

async function prepareRepository(
  root: string,
  id: string,
): Promise<{
  repository: RepositorySnapshot;
  registrationPath: string;
  contractPath: string;
  taskId: string;
}> {
  const path = join(root, id);
  await mkdir(path);
  await execa("git", ["init", "--initial-branch=main"], { cwd: path });
  await execa("git", ["config", "user.name", "Test"], { cwd: path });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
  await writeFile(join(path, "README.md"), `${id}\n`);
  await execa("git", ["add", "."], { cwd: path });
  await execa("git", ["commit", "-m", "base"], { cwd: path });
  const baseSha = await git(path, "rev-parse", "HEAD");
  const taskId = `capacity-${id}`;
  const contractPath = join(path, "task.json");
  const registrationPath = join(path, "repository.json");
  const contract: TaskContract = {
    id: taskId,
    repositoryId: id,
    baseSha,
    instructions: "Exercise the public active-task capacity boundary.",
    acceptance: ["Only one active Task is admitted."],
    nonGoals: [],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: `https://github.com/example/${id}/issues/178`,
      delivery: true,
    },
    delivery: {
      branch: `agent/${taskId}`,
      issue: 178,
      title: "Active Task capacity",
      body: "Active Task capacity",
    },
  };
  await writeFile(contractPath, JSON.stringify(contract));
  await execa("git", ["add", "task.json"], { cwd: path });
  await execa("git", ["commit", "-m", "authorize task"], { cwd: path });
  const repository: RepositorySnapshot = {
    id,
    path: await realpath(path),
    owner: "example",
    name: id,
    baseBranch: "main",
    implementerProfile: "writer-profile",
    reviewerProfile: "reviewer-profile",
    forgeProfile: id,
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
  };
  await writeFile(registrationPath, JSON.stringify(repository));
  return { repository, registrationPath, contractPath, taskId };
}

async function waitForState(
  serverUrl: string,
  taskId: string,
  state: "blocked" | "admitted",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await taskStatus(serverUrl, taskId))?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${taskId} to become ${state}`);
}

function environmentFor(
  stateDirectory: string,
  repositoryIds: readonly string[],
  capacity: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_ACTIVE_TASK_CAPACITY: capacity,
  };
  for (const id of repositoryIds) {
    const profile = id.toUpperCase().replaceAll("-", "_");
    environment[`USINE_FORGE_PROFILE_${profile}_APP_SLUG`] = `test-app-${id}`;
    environment[`USINE_FORGE_PROFILE_${profile}_TEST_TOKEN`] = `test-token-${id}`;
    environment[`USINE_FORGE_PROFILE_${profile}_API_URL`] = "http://127.0.0.1:9";
    environment[`USINE_FORGE_PROFILE_${profile}_REPOSITORY`] = `example/${id}`;
  }
  return environment;
}

describe("public active-task capacity", () => {
  test("races two CLI submissions at capacity, then admits the loser after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-capacity-"));
    const stateDirectory = join(root, "state");
    const first = await prepareRepository(root, "repository-one");
    const second = await prepareRepository(root, "repository-two");
    const firstStarted = deferred<string>();
    const releaseFirst = deferred<void>();
    let activeTaskId: string | undefined;

    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_ACTIVE_TASK_CAPACITY: "1",
        USINE_FORGE_PROFILE_REPOSITORY_ONE_APP_SLUG: "test-app-one",
        USINE_FORGE_PROFILE_REPOSITORY_ONE_TEST_TOKEN: "test-token-one",
        USINE_FORGE_PROFILE_REPOSITORY_ONE_API_URL: "http://127.0.0.1:9",
        USINE_FORGE_PROFILE_REPOSITORY_ONE_REPOSITORY: "example/repository-one",
        USINE_FORGE_PROFILE_REPOSITORY_TWO_APP_SLUG: "test-app-two",
        USINE_FORGE_PROFILE_REPOSITORY_TWO_TEST_TOKEN: "test-token-two",
        USINE_FORGE_PROFILE_REPOSITORY_TWO_API_URL: "http://127.0.0.1:9",
        USINE_FORGE_PROFILE_REPOSITORY_TWO_REPOSITORY: "example/repository-two",
      },
      execute: async ({ authority, result, signal }) => {
        if (activeTaskId === undefined) {
          activeTaskId = result.taskId;
          firstStarted.resolve(result.taskId);
        }
        if (result.taskId === activeTaskId) {
          await Promise.race([
            releaseFirst.promise,
            new Promise<never>((_, reject) =>
              signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
          ]);
        }
        const current = await authority.lookup(result.taskId);
        if (!current) throw new Error("task disappeared during capacity test");
        return authority.block(
          { taskId: current.taskId, revision: current.revision },
          "capacity test complete",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      for (const repository of [first, second]) {
        const registered = await runCli(server.url, "register", repository.registrationPath);
        expect(registered.exitCode, registered.stderr).toBe(0);
      }

      const submissions = [
        runCli(server.url, "submit", first.contractPath),
        runCli(server.url, "submit", second.contractPath),
      ];
      const activeTask = await firstStarted.promise;
      const results = await Promise.all(submissions);
      const admitted = results.filter((result) => result.exitCode === 0);
      const rejected = results.filter((result) => result.exitCode !== 0);
      expect(admitted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const admittedResult = admitted[0];
      const rejectedResult = rejected[0];
      if (!admittedResult || !rejectedResult) throw new Error("capacity race lost a result");

      const admittedTask = JSON.parse(admittedResult.stdout) as {
        taskId: string;
        state: string;
      };
      expect(admittedTask).toMatchObject({ taskId: activeTask, state: "admitted" });
      expect(rejectedResult).toMatchObject({ exitCode: 6 });
      expect(JSON.parse(rejectedResult.stderr)).toMatchObject({
        error: "active_task_capacity",
        kind: "server",
        retryable: true,
      });

      const loser = activeTask === first.taskId ? second : first;
      const missing = await runCli(server.url, "status", loser.taskId);
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stderr)).toEqual({ error: "task_not_found", taskId: loser.taskId });

      const listed = await runCli(server.url, "task", "list", "--json");
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).tasks).toEqual([
        expect.objectContaining({ taskId: activeTask }),
      ]);

      releaseFirst.resolve();
      await waitForCliState(server.url, activeTask, "blocked");
      const retry = await runCli(server.url, "submit", loser.contractPath);
      expect(retry.exitCode, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({
        taskId: loser.taskId,
        state: "admitted",
      });
      await waitForCliState(server.url, loser.taskId, "blocked");
    } finally {
      await server.close();
    }
  }, 30_000);

  test("returns the existing Task for an idempotent resubmission at full capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-capacity-idempotency-"));
    const stateDirectory = join(root, "state");
    const repository = await prepareRepository(root, "repository-idempotent");
    const started = deferred<void>();
    const release = deferred<void>();
    const server = await startUsineServer({
      environment: environmentFor(stateDirectory, [repository.repository.id], "1"),
      execute: async ({ authority, result }) => {
        started.resolve();
        await release.promise;
        return authority.block(
          { taskId: result.taskId, revision: result.revision },
          "idempotency test complete",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await registerRepository(server.url, repository.repository);
      const admitted = await submitTask(server.url, { contractPath: repository.contractPath });
      await started.promise;
      await expect(
        submitTask(server.url, { contractPath: repository.contractPath }),
      ).resolves.toEqual(admitted);
      release.resolve();
      await waitForState(server.url, repository.taskId, "blocked");
    } finally {
      await server.close();
    }
  }, 30_000);

  test("refuses restart readiness when durable Tasks exceed the lowered capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-capacity-restart-"));
    const stateDirectory = join(root, "state");
    const first = await prepareRepository(root, "repository-restart-one");
    const second = await prepareRepository(root, "repository-restart-two");
    const environment = environmentFor(
      stateDirectory,
      [first.repository.id, second.repository.id],
      "2",
    );
    const server = await startUsineServer({
      environment,
      execute: async ({ result }) => result,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await registerRepository(server.url, first.repository);
      await registerRepository(server.url, second.repository);
      await expect(
        submitTask(server.url, { contractPath: first.contractPath }),
      ).resolves.toMatchObject({ taskId: first.taskId, state: "admitted" });
      await expect(
        submitTask(server.url, { contractPath: second.contractPath }),
      ).resolves.toMatchObject({ taskId: second.taskId, state: "admitted" });
    } finally {
      await server.close();
    }

    await expect(
      startUsineServer({
        environment: environmentFor(
          stateDirectory,
          [first.repository.id, second.repository.id],
          "1",
        ),
        execute: async ({ result }) => result,
        host: "127.0.0.1",
        port: 0,
      }),
    ).rejects.toMatchObject({
      code: "active_task_capacity_startup",
      capacity: 1,
      active: 2,
    });
  }, 30_000);

  test("rejects invalid active-task capacity before server startup", async () => {
    for (const capacity of ["0", "-1", "1.5", "Infinity", "not-a-number"]) {
      await expect(
        startUsineServer({
          environment: {
            USINE_STATE_DIR: join(tmpdir(), `usine-invalid-capacity-${capacity}`),
            USINE_ACTIVE_TASK_CAPACITY: capacity,
          },
          host: "127.0.0.1",
          port: 0,
        }),
      ).rejects.toThrow("USINE_ACTIVE_TASK_CAPACITY must be a positive finite integer");
    }
  });
});
