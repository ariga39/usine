import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import {
  listTasks,
  registerRepository,
  TaskCapacityError,
  submitTask,
  taskStatus,
} from "../apps/cli/src/server-client.js";
import type { RepositorySnapshot, TaskContract } from "@usine/task-authority";

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

async function prepareRepository(
  root: string,
  id: string,
): Promise<{
  repository: RepositorySnapshot;
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
  return {
    repository: {
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
    },
    contractPath,
    taskId,
  };
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

describe("public active-task capacity", () => {
  test("rejects a concurrent second repository without admission, then admits it after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-capacity-"));
    const stateDirectory = join(root, "state");
    const first = await prepareRepository(root, "repository-one");
    const second = await prepareRepository(root, "repository-two");
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();

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
        if (result.taskId === first.taskId) {
          firstStarted.resolve();
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
      await registerRepository(server.url, first.repository);
      await registerRepository(server.url, second.repository);

      const admittedFirst = await submitTask(server.url, { contractPath: first.contractPath });
      await firstStarted.promise;

      let capacityError: unknown;
      try {
        await submitTask(server.url, { contractPath: second.contractPath });
      } catch (error) {
        capacityError = error;
      }
      expect(capacityError).toBeInstanceOf(TaskCapacityError);
      expect(capacityError).toMatchObject({
        status: 429,
        kind: "server",
        code: "active_task_capacity",
        retryable: true,
        diagnostic: "active_task_capacity",
      });
      await expect(taskStatus(server.url, second.taskId)).resolves.toBeNull();
      await expect(listTasks(server.url)).resolves.toMatchObject({
        tasks: [expect.objectContaining({ taskId: admittedFirst.taskId })],
      });

      releaseFirst.resolve();
      await waitForState(server.url, first.taskId, "blocked");
      await expect(
        submitTask(server.url, { contractPath: second.contractPath }),
      ).resolves.toMatchObject({
        taskId: second.taskId,
        state: "admitted",
      });
      await waitForState(server.url, second.taskId, "blocked");
    } finally {
      await server.close();
    }
  }, 30_000);
});
