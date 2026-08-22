import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  lookupTaskStatus,
  lookupTaskEvents,
  recordRecoveryObservation,
  startUsineServer,
  registerRepository,
  type ServerExecutionContext,
} from "@usine/runtime";
import { executeDeliveryRun } from "@usine/delivery-run";
import {
  submitTask,
  taskEvents,
  taskStatus,
  type TaskSubmission,
} from "../apps/cli/src/server-client.js";
import {
  applyMigrations,
  hashTaskContract,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskResource,
  type TaskResult,
  type RepositorySnapshot,
  type ResolvedTaskContract,
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
  read: () => Promise<TaskResource | null>,
  predicate: (result: TaskResource) => boolean,
): Promise<TaskResource> {
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
  test("persists bounded provider interruption evidence through Delivery Run and the server", async () => {
    const { submission, stateDirectory, repositoryName } = await fixture();
    const server = await startUsineServer({
      environment: environment(stateDirectory, repositoryName),
      execute: async ({ authority, contract, result, signal }) => {
        const resolved: ResolvedTaskContract = {
          ...contract,
          repository: { path: ".", owner: "example", name: repositoryName },
          projectCheck: { command: "true", timeoutMs: 1_000 },
          budget: { ...contract.budget, maxImplementerActivations: 1 },
          delivery: { ...contract.delivery, baseBranch: "main" },
        };
        return executeDeliveryRun(
          {
            contract: resolved,
            contractHash: result.contractHash,
            repositoryIdentity: result.writer.repositoryIdentity,
            deadlineEpochMs: result.deadlineEpochMs,
            implementer: {
              role: "implementer",
              profile: "writer-profile",
              sandbox: "workspace-write",
            },
            signal,
          },
          {
            authority,
            workspace: {
              quarantinePriorWriters: async () => undefined,
              prepareWriter: async () => ({
                taskId: result.taskId,
                activation: 1,
                path: ".",
                baseSha: resolved.baseSha,
              }),
              freeze: async () => {
                throw new Error("freeze must not run after interruption");
              },
              quarantine: async () => undefined,
            },
            session: {
              run: async () => ({
                status: "failed" as const,
                output: null,
                summary: "temporary provider outage with raw-secret-marker",
                failure: "temporary provider outage with raw-secret-marker",
                phase: "turn" as const,
                failureClass: "network" as const,
              }),
            },
            quality: {
              check: async () => {
                throw new Error("check must not run after interruption");
              },
              reviewWithObservation: async () => {
                throw new Error("review must not run after interruption");
              },
            },
            forge: {
              deliver: async () => {
                throw new Error("delivery must not run after interruption");
              },
            },
          },
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const admitted = await submitTask(server.url, submission);
      const blocked = await waitFor(
        () => taskStatus(server.url, admitted.taskId),
        (result) => result.state === "blocked",
      );
      expect(blocked.state).toBe("blocked");
      const events = (await taskEvents(server.url, admitted.taskId, 0, 100)).events;
      expect(events.map((event) => event.data)).toContainEqual({
        type: "coding_session_interrupted",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
        phase: "turn",
        failureClass: "network",
      });
      expect(JSON.stringify(events)).not.toContain("raw-secret-marker");
    } finally {
      await server.close();
    }
  });

  test("persists sanitized restart observations in the durable event stream", async () => {
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

    await recordRecoveryObservation(stateDirectory, admitted.taskId, "server_restart");
    await recordRecoveryObservation(stateDirectory, admitted.taskId, "execution_owner_changed");
    await recordRecoveryObservation(stateDirectory, admitted.taskId, "server_restart");
    await recordRecoveryObservation(stateDirectory, admitted.taskId, "execution_owner_changed");

    const status = await lookupTaskStatus(stateDirectory, admitted.taskId);
    expect(status).toEqual(admitted);
    const events = (await lookupTaskEvents(stateDirectory, admitted.taskId, 1, 10))!;
    expect(events.events.map((event) => event.data)).toEqual([
      { type: "recovery_observed", kind: "server_restart" },
      { type: "recovery_observed", kind: "execution_owner_changed" },
      { type: "recovery_observed", kind: "server_restart" },
      { type: "recovery_observed", kind: "execution_owner_changed" },
    ]);
    expect(new Set(events.events.map((event) => event.eventId)).size).toBe(4);
    expect(events.events.map((event) => event.eventId)).toEqual(
      (await lookupTaskEvents(stateDirectory, admitted.taskId, 1, 10))!.events.map(
        (event) => event.eventId,
      ),
    );
    const replay = await lookupTaskEvents(stateDirectory, admitted.taskId, 2, 2);
    expect(replay?.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(replay?.nextSequence).toBe(4);
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
      expect(completed.blocker).toEqual({ classification: "unknown" });
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
    const cleanupCalls = { taskIds: [] as string[], owned: 0 };
    const codingSession = {
      cleanupTask: async (_stateDirectory: string, taskId: string) => {
        cleanupCalls.taskIds.push(taskId);
      },
      cleanupOwned: async (_stateDirectory: string) => {
        cleanupCalls.owned += 1;
      },
    };
    const first = await startUsineServer({
      environment: environment(stateDirectory, repositoryName),
      codingSession,
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
      codingSession,
      execute: blockedExecutor(restartedSeen),
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const completed = await waitFor(
        () => taskStatus(second.url, admitted.taskId),
        (result) => result.state === "blocked",
      );
      expect(completed.blocker).toEqual({ classification: "unknown" });
      expect(firstSeen).toEqual([admitted.taskId]);
      expect(restartedSeen).toEqual([admitted.taskId]);
      expect(completed.evidence.restartRecoveries).toBe(1);
      expect(cleanupCalls.taskIds).toEqual([admitted.taskId]);
    } finally {
      await second.close();
    }
    expect(cleanupCalls.owned).toBeGreaterThan(0);
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

    const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
    const persisted = database
      .prepare("SELECT result FROM task_runs WHERE task_id = ?")
      .get(admitted.taskId) as { result: string };
    const corruptTaskId = admitted.taskId + "-corrupt";
    const corruptResult = {
      ...(JSON.parse(persisted.result) as Record<string, unknown>),
      taskId: corruptTaskId,
      writer: { repositoryIdentity: "example/" + corruptTaskId },
    };
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

      const quarantinedListResponse = await fetch(new URL("/v1/tasks", second.url));
      expect(quarantinedListResponse.status).toBe(503);
      expect(await quarantinedListResponse.json()).toEqual({
        taskId: quarantinedTaskId,
        error: "task_state_quarantined",
      });

      const quarantinedEventsResponse = await fetch(
        new URL(`/v1/tasks/${encodeURIComponent(corruptTaskId)}/events`, second.url),
      );
      expect(quarantinedEventsResponse.status).toBe(200);
      expect(await quarantinedEventsResponse.json()).toMatchObject({ taskId: corruptTaskId });

      const corruptResponse = await fetch(
        new URL(`/v1/tasks/${encodeURIComponent(corruptTaskId)}`, second.url),
      );
      expect(corruptResponse.status).toBe(200);
      expect(await corruptResponse.json()).toMatchObject({
        taskId: corruptTaskId,
        state: "blocked",
      });
      await healthyStarted.promise;
      expect((await taskStatus(second.url, admitted.taskId))?.taskId).toBe(admitted.taskId);
      expect(reentered).toEqual([admitted.taskId]);
    } finally {
      await second.close();
    }
  });
});
