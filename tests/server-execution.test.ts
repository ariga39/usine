import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  lookupTaskStatus,
  recordExecutionObservation,
  startUsineServer,
  registerRepository,
  type ServerExecutionContext,
} from "@usine/runtime";
import { submitTask, taskStatus, type TaskSubmission } from "../apps/cli/src/server-client.js";
import {
  applyMigrations,
  hashTaskContract,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskResult,
  type RepositorySnapshot,
} from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

const forgeSecretToken = "forge-secret-token-181";
const forgeSecretKeyPath = "forge-private-key-181.pem";

async function fixture(): Promise<{
  contractPath: string;
  submission: TaskSubmission;
  stateDirectory: string;
  repositoryName: string;
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
    repositoryId: taskId,
    baseSha,
    instructions: "Exercise server-owned execution.",
    acceptance: ["The server owns execution."],
    nonGoals: [],
    budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: `https://github.com/example/${taskId}/issues/153`,
      delivery: true,
    },
    delivery: {
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
  const repositorySnapshot: RepositorySnapshot = {
    id: taskId,
    path: repository,
    owner: "example",
    name: taskId,
    baseBranch: "main",
    implementerProfile: "writer-profile",
    reviewerProfile: "reviewer-profile",
    forgeProfile: "default",
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
  };
  await registerRepository(stateDirectory, repositorySnapshot);
  return {
    contractPath,
    stateDirectory,
    repositoryName: taskId,
    submission: {
      contractPath,
      repositoryId: taskId,
    },
  };
}

function environment(stateDirectory: string, repositoryName: string): NodeJS.ProcessEnv {
  return {
    USINE_STATE_DIR: stateDirectory,
    USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: forgeSecretToken,
    USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${repositoryName}`,
    USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: forgeSecretKeyPath,
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
  test("persists restart and owner-change facts in the bounded status history", async () => {
    const { contractPath, stateDirectory } = await fixture();
    const rawContract = await readFile(contractPath, "utf8");
    const contract = JSON.parse(rawContract) as TaskContract;
    const databasePath = join(stateDirectory, "usine.sqlite");
    await mkdir(stateDirectory, { recursive: true });
    await applyMigrations(databasePath);
    const handle = openSqliteDatabase(databasePath);
    const authority = new TaskAuthority(handle.database);
    const admitted = await authority.admit(
      {
        contract,
        contractHash: hashTaskContract(rawContract),
        repositoryIdentity: `example/${contract.id}`,
        repository: {
          id: contract.repositoryId,
          path: join(stateDirectory, "..", "repository"),
          owner: "example",
          name: contract.id,
          baseBranch: "main",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
          forgeProfile: "default",
          projectCheck: { command: "true", timeoutMs: 1_000 },
          gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
        },
        deadlineEpochMs: Date.now() + 60_000,
      },
      { contractPath, rawContract },
    );
    handle.close();

    await recordExecutionObservation(
      stateDirectory,
      admitted,
      "coordinator_restart",
      "persistent-server",
      "prior-coordinator",
    );
    await recordExecutionObservation(
      stateDirectory,
      admitted,
      "execution_owner_change",
      "persistent-server",
      "prior-coordinator",
    );

    const status = await lookupTaskStatus(stateDirectory, admitted.taskId);
    expect(status).toMatchObject({
      ...admitted,
      history: [
        {
          kind: "coordinator_restart",
          outcome: "observed",
          executionOwner: "persistent-server",
          previousExecutionOwner: "prior-coordinator",
        },
        {
          kind: "execution_owner_change",
          outcome: "observed",
          executionOwner: "persistent-server",
          previousExecutionOwner: "prior-coordinator",
        },
      ],
    });
    expect(status?.history).toHaveLength(2);
    expect(status?.revision).toBe(admitted.revision);
  });

  test("continues an admitted task after the submitting client has returned", async () => {
    const { submission, stateDirectory, repositoryName } = await fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const seen: string[] = [];
    const server = await startUsineServer({
      environment: environment(stateDirectory, repositoryName),
      execute: async (context) => {
        const workerSurfaces = [
          context.policy.workerEnvironment,
          context.policy.credentialFreeGitEnvironment,
        ];
        expect(JSON.stringify(workerSurfaces)).not.toContain(forgeSecretToken);
        expect(JSON.stringify(workerSurfaces)).not.toContain(forgeSecretKeyPath);
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
      expect(JSON.stringify(completed)).not.toContain(forgeSecretToken);
      expect(JSON.stringify(completed)).not.toContain(forgeSecretKeyPath);
      expect(seen).toEqual([admitted.taskId]);
    } finally {
      await server.close();
    }
  });

  test("re-enters a durable admitted task once after server restart", async () => {
    const { submission, stateDirectory, repositoryName } = await fixture();
    const firstStarted = deferred<void>();
    const firstAborted = deferred<void>();
    const firstSeen: string[] = [];
    const first = await startUsineServer({
      environment: environment(stateDirectory, repositoryName),
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
      environment: environment(stateDirectory, repositoryName),
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
    const { submission, contractPath, stateDirectory, repositoryName } = await fixture();
    const first = await startUsineServer({
      environment: environment(stateDirectory, repositoryName),
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
        "INSERT INTO task_runs (task_id, result, contract_path, raw_contract) VALUES (?, ?, ?, ?)",
      )
      .run(corruptTaskId, JSON.stringify(corruptResult), contractPath, "{ invalid contract");
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
      environment: environment(stateDirectory, repositoryName),
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
