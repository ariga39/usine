import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer, type ServerExecutionContext } from "@usine/runtime";
import { submitTask, taskStatus, type TaskSubmission } from "../apps/cli/src/server-client.js";
import type { TaskContract, TaskResult } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function fixture(): Promise<{
  contractPath: string;
  submission: TaskSubmission;
  stateDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "usine-server-execution-"));
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "server\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const baseSha = await git(repository, "rev-parse", "HEAD");
  const taskId = `server-execution-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contractPath = join(repository, "task.json");
  const contract: TaskContract = {
    id: taskId,
    repository: { path: ".", owner: "example", name: taskId },
    baseSha,
    instructions: "Exercise server-owned execution.",
    acceptance: ["The server owns execution."],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: `https://github.com/example/${taskId}/issues/153`,
      delivery: true,
    },
    delivery: {
      baseBranch: "main",
      branch: `agent/${taskId}`,
      issue: 153,
      title: "Server execution",
      body: "Server execution",
    },
  };
  const rawContract = JSON.stringify(contract);
  await writeFile(contractPath, rawContract);
  await execa("git", ["add", "task.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
  return {
    contractPath,
    stateDirectory,
    submission: {
      contractPath,
      repositoryPath: repository,
    },
  };
}

function environment(stateDirectory: string): NodeJS.ProcessEnv {
  return {
    USINE_STATE_DIR: stateDirectory,
    USINE_GIT_AUTHOR_NAME: "Release Bot",
    USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
    USINE_GITHUB_APP_SLUG: "test-app",
    USINE_GITHUB_TEST_TOKEN: "test-token",
    USINE_GITHUB_API_URL: "http://127.0.0.1:9",
  };
}

async function waitFor(
  read: () => Promise<TaskResult | null>,
  predicate: (result: TaskResult) => boolean,
): Promise<TaskResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await read();
    if (result && predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for task state");
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

function blockedExecutor(seen: string[]): (context: ServerExecutionContext) => Promise<TaskResult> {
  return async ({ authority, contract, result }) => {
    seen.push(result.taskId);
    const activation = await authority.reserveActivation(
      result.taskId,
      contract.budget.maxImplementerActivations,
    );
    return authority.block(
      { taskId: result.taskId, revision: activation.result.revision },
      "fake execution complete",
    );
  };
}

describe("server-owned execution", () => {
  test("continues an admitted task after the submitting client has returned", async () => {
    const { submission, stateDirectory } = await fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const seen: string[] = [];
    const server = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async (context) => {
        started.resolve();
        await release.promise;
        return blockedExecutor(seen)(context);
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const admitted = await submitTask(server.url, submission);
      expect(admitted.state).toBe("admitted");
      await started.promise;
      release.resolve();
      const completed = await waitFor(
        () => taskStatus(server.url, admitted.taskId),
        (result) => result.state === "blocked",
      );
      expect(completed.blocker).toBe("fake execution complete");
      expect(seen).toEqual([admitted.taskId]);
    } finally {
      await server.close();
    }
  });

  test("re-enters a durable admitted task once after server restart", async () => {
    const { submission, stateDirectory } = await fixture();
    const firstStarted = deferred<void>();
    const firstAborted = deferred<void>();
    const firstSeen: string[] = [];
    const first = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ authority, contract, result, signal }) => {
        firstSeen.push(result.taskId);
        await authority.reserveActivation(result.taskId, contract.budget.maxImplementerActivations);
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              firstAborted.resolve();
              resolve();
            },
            { once: true },
          );
        });
        return result;
      },
      host: "127.0.0.1",
      port: 0,
    });
    const admitted = await submitTask(first.url, submission);
    await firstStarted.promise;
    await first.close();
    await firstAborted.promise;

    const restartedSeen: string[] = [];
    const second = await startUsineServer({
      environment: environment(stateDirectory),
      execute: blockedExecutor(restartedSeen),
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const completed = await waitFor(
        () => taskStatus(second.url, admitted.taskId),
        (result) => result.state === "blocked",
      );
      expect(completed.blocker).toBe("fake execution complete");
      expect(firstSeen).toEqual([admitted.taskId]);
      expect(restartedSeen).toEqual([admitted.taskId]);
      expect(completed.evidence.restartRecoveries).toBe(1);
    } finally {
      await second.close();
    }
  });

  test("isolates corrupt restart rows and completes recovery before readiness", async () => {
    const { submission, contractPath, stateDirectory } = await fixture();
    const first = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ result }) => result,
      host: "127.0.0.1",
      port: 0,
    });
    const admitted = await submitTask(first.url, submission);
    await first.close();

    const corruptTaskId = admitted.taskId + "-corrupt";
    const corruptResult = {
      ...admitted,
      taskId: corruptTaskId,
      writer: { repositoryIdentity: "example/" + corruptTaskId },
    };
    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    database
      .prepare(
        "INSERT INTO task_runs (task_id, result, contract_path, repository_path, raw_contract) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        corruptTaskId,
        JSON.stringify(corruptResult),
        contractPath,
        submission.repositoryPath,
        "{ invalid contract",
      );
    database
      .prepare("INSERT INTO repository_leases (repository_identity, task_id) VALUES (?, ?)")
      .run(corruptResult.writer.repositoryIdentity, corruptTaskId);
    const quarantinedTaskId = admitted.taskId + "-quarantined";
    database
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(quarantinedTaskId, "{ unreadable TaskResult");
    database.close();

    const healthyStarted = deferred<void>();
    const reentered: string[] = [];
    const second = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ result }) => {
        reentered.push(result.taskId);
        if (result.taskId === admitted.taskId) healthyStarted.resolve();
        return result;
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const quarantinedResponse = await fetch(
        new URL(`/v1/tasks/${encodeURIComponent(quarantinedTaskId)}`, second.url),
      );
      const quarantinedBody = await quarantinedResponse.text();
      expect(quarantinedResponse.status).toBe(503);
      expect(JSON.parse(quarantinedBody)).toEqual({
        taskId: quarantinedTaskId,
        error: "task_state_quarantined",
      });

      const corrupt = await taskStatus(second.url, corruptTaskId);
      expect(corrupt?.state).toBe("blocked");
      await healthyStarted.promise;
      expect((await taskStatus(second.url, admitted.taskId))?.taskId).toBe(admitted.taskId);
      expect(reentered).toEqual([admitted.taskId]);
    } finally {
      await second.close();
    }
  });
});
