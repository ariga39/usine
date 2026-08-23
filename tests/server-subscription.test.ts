import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { decodeApiEventEnvelope, startUsineServer, type ApiEventEnvelope } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";
import {
  openServerEventListener,
  registerRepository,
  submitTask,
  waitForServerEvent,
} from "../apps/cli/src/server-client.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function collect(
  listener: Awaited<ReturnType<typeof openServerEventListener>>,
  count: number,
): Promise<ApiEventEnvelope[]> {
  const events: ApiEventEnvelope[] = [];
  while (events.length < count) {
    const next = await listener[Symbol.asyncIterator]().next();
    if (next.done) throw new Error("public event listener closed before expected events");
    events.push(next.value);
  }
  return events;
}

async function collectUntil(
  listener: Awaited<ReturnType<typeof openServerEventListener>>,
  predicate: (event: ApiEventEnvelope) => boolean,
): Promise<ApiEventEnvelope[]> {
  const events: ApiEventEnvelope[] = [];
  while (true) {
    const next = await listener[Symbol.asyncIterator]().next();
    if (next.done) throw new Error("public event listener closed before the expected event");
    events.push(next.value);
    if (predicate(next.value)) return events;
  }
}

async function openPausedListener(
  serverUrl: string,
  repositoryId: string,
): Promise<{
  closed: Promise<void>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const request = get(
      `${serverUrl}/v1/events/subscribe?repositoryId=${encodeURIComponent(repositoryId)}`,
      (response) => {
        response.pause();
        resolve({
          closed: new Promise<void>((done) => response.once("close", done)),
          close: () => request.destroy(),
        });
      },
    );
    request.once("error", reject);
  });
}

async function openWait(
  serverUrl: string,
  scope: { taskId?: string; repositoryId?: string },
): Promise<{ event: Promise<ApiEventEnvelope> }> {
  const query = new URLSearchParams({ ...scope, timeoutMs: "5000" });
  const response = await fetch(`${serverUrl}/v1/events/wait?${query}`);
  return { event: response.json().then(decodeApiEventEnvelope) };
}

async function repository(
  root: string,
  id: string,
): Promise<{ id: string; path: string; baseSha: string }> {
  const path = join(root, id);
  await mkdir(path);
  await execa("git", ["init", "--initial-branch=main"], { cwd: path });
  await execa("git", ["config", "user.name", "Test"], { cwd: path });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
  await writeFile(join(path, "README.md"), `${id}\n`);
  await execa("git", ["add", "."], { cwd: path });
  await execa("git", ["commit", "-m", "base"], { cwd: path });
  return { id, path, baseSha: await git(path, "rev-parse", "HEAD") };
}

async function contract(repository: { id: string; path: string; baseSha: string }, taskId: string) {
  const path = join(repository.path, `${taskId}.json`);
  const value: TaskContract = {
    id: taskId,
    repositoryId: repository.id,
    baseSha: repository.baseSha,
    instructions: "Exercise transient public progress observation.",
    acceptance: ["Only sanitized live events are observable."],
    nonGoals: [],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: `https://github.com/example/${repository.id}/issues/219`,
      delivery: true,
    },
    delivery: {
      branch: `agent/${taskId}`,
      issue: 219,
      title: "Transient progress",
      body: "Transient progress",
    },
  };
  await writeFile(path, JSON.stringify(value));
  await execa("git", ["add", "."], { cwd: repository.path });
  await execa("git", ["commit", "-m", `authorize ${taskId}`], { cwd: repository.path });
  return path;
}

async function register(serverUrl: string, value: { id: string; path: string }): Promise<void> {
  await registerRepository(serverUrl, {
    id: value.id,
    path: await realpath(value.path),
    owner: "example",
    name: value.id,
    baseBranch: "main",
    implementerProfile: "writer-profile",
    reviewerProfile: "reviewer-profile",
    forgeProfile: value.id,
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
  });
}

const environment = (stateDirectory: string): NodeJS.ProcessEnv => ({
  USINE_STATE_DIR: stateDirectory,
  USINE_ACTIVE_TASK_CAPACITY: "2",
  USINE_FORGE_PROFILE_REPOSITORY_A_APP_SLUG: "app-a",
  USINE_FORGE_PROFILE_REPOSITORY_A_TEST_TOKEN: "secret-a",
  USINE_FORGE_PROFILE_REPOSITORY_A_API_URL: "http://127.0.0.1:9",
  USINE_FORGE_PROFILE_REPOSITORY_A_REPOSITORY: "example/repository-a",
  USINE_FORGE_PROFILE_REPOSITORY_B_APP_SLUG: "app-b",
  USINE_FORGE_PROFILE_REPOSITORY_B_TEST_TOKEN: "secret-b",
  USINE_FORGE_PROFILE_REPOSITORY_B_API_URL: "http://127.0.0.1:9",
  USINE_FORGE_PROFILE_REPOSITORY_B_REPOSITORY: "example/repository-b",
});

describe("public transient server event listeners", () => {
  test("waits once by Task and Repository scope, then times out cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-event-wait-"));
    const stateDirectory = join(root, "state");
    const repo = await repository(root, "repository-a");
    const idleRepo = { id: "repository-b", path: repo.path };
    const taskId = `wait-${Date.now()}`;
    const contractPath = await contract(repo, taskId);
    const gate = deferred();
    const server = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ authority, result }) => {
        await gate.promise;
        return authority.block(
          { taskId: result.taskId, revision: result.revision },
          "private secret-a",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      await register(server.url, repo);
      await register(server.url, idleRepo);
      const admitted = await submitTask(server.url, { contractPath, repositoryId: repo.id });
      const taskWait = (await openWait(server.url, { taskId: admitted.taskId })).event;
      const repositoryWait = (await openWait(server.url, { repositoryId: repo.id })).event;
      gate.resolve();
      const [taskEvent, repositoryEvent] = await Promise.all([taskWait, repositoryWait]);
      expect(taskEvent.taskId).toBe(admitted.taskId);
      expect(repositoryEvent.repositoryId).toBe(repo.id);
      expect(taskEvent.event.data).toEqual({ type: "task_blocked", reason: "unknown" });
      await expect(
        waitForServerEvent(server.url, { repositoryId: idleRepo.id }, 0),
      ).resolves.toBeNull();
      expect(JSON.stringify(taskEvent)).not.toContain("secret-a");
    } finally {
      await server.close();
    }
  });

  test("subscribes live by Task, Repository, and whole-server scopes across repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-event-scopes-"));
    const stateDirectory = join(root, "state");
    const repoA = await repository(root, "repository-a");
    const repoB = await repository(root, "repository-b");
    const taskA = `scope-a-${Date.now()}`;
    const taskB = `scope-b-${Date.now()}`;
    const contractA = await contract(repoA, taskA);
    const contractB = await contract(repoB, taskB);
    const gate = deferred();
    const server = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ authority, result }) => {
        await gate.promise;
        return authority.block(
          { taskId: result.taskId, revision: result.revision },
          "private blocker",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    const listeners: Array<Awaited<ReturnType<typeof openServerEventListener>>> = [];
    try {
      await register(server.url, repoA);
      await register(server.url, repoB);
      const repoListener = await openServerEventListener(server.url, { repositoryId: repoA.id });
      const serverListener = await openServerEventListener(server.url);
      listeners.push(repoListener, serverListener);
      const admittedA = await submitTask(server.url, {
        contractPath: contractA,
        repositoryId: repoA.id,
      });
      const taskListener = await openServerEventListener(server.url, { taskId: admittedA.taskId });
      listeners.push(taskListener);
      const taskEvents = collectUntil(
        taskListener,
        (entry) => entry.event.data.type === "task_blocked",
      );
      const repoEvents = collectUntil(
        repoListener,
        (entry) => entry.event.data.type === "task_blocked",
      );
      const serverEvents = collect(serverListener, 4);
      await submitTask(server.url, { contractPath: contractB, repositoryId: repoB.id });
      gate.resolve();
      const [task, repo, whole] = await Promise.all([taskEvents, repoEvents, serverEvents]);
      expect(task.filter((entry) => entry.event.data.type === "task_blocked")).toHaveLength(1);
      expect(task.every((entry) => entry.taskId === admittedA.taskId)).toBe(true);
      expect(repo.every((entry) => entry.repositoryId === repoA.id)).toBe(true);
      expect(new Set(whole.map((entry) => entry.repositoryId))).toEqual(
        new Set([repoA.id, repoB.id]),
      );
      expect(whole.every((entry) => entry.event.data.type.length > 0)).toBe(true);
    } finally {
      for (const listener of listeners) listener.close();
      await server.close();
    }
  });

  test("isolates a slow listener and starts a fresh process without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-event-lifecycle-"));
    const stateDirectory = join(root, "state");
    const repo = await repository(root, "repository-a");
    const taskId = `lifecycle-${Date.now()}`;
    const contractPath = await contract(repo, taskId);
    const server = await startUsineServer({
      environment: environment(stateDirectory),
      execute: async ({ authority, result }) => {
        for (let index = 0; index < 96; index += 1) {
          await authority.appendObservation(result.taskId, {
            eventId: `lifecycle:${index}`,
            occurredAtEpochMs: index,
            data: {
              type: "coding_tool_completed",
              role: "implementer",
              activation: 1,
              tool: "read",
              outcome: "succeeded",
              sessionId: "lifecycle-session",
              outcomeId: `lifecycle-outcome:${index}`,
            },
          });
        }
        const current = await authority.lookup(result.taskId);
        return authority.block(
          { taskId: result.taskId, revision: current!.revision },
          "private secret-b",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    let slow: Awaited<ReturnType<typeof openPausedListener>> | undefined;
    let fast: Awaited<ReturnType<typeof openServerEventListener>> | undefined;
    try {
      await register(server.url, repo);
      slow = await openPausedListener(server.url, repo.id);
      fast = await openServerEventListener(server.url, { repositoryId: repo.id });
      const slowClosed = slow.closed;
      const fastEvents = collect(fast, 99);
      await submitTask(server.url, { contractPath, repositoryId: repo.id });
      const events = await fastEvents;
      expect(events).toHaveLength(99);
      expect(events.map((entry) => entry.event.sequence)).toEqual(
        Array.from({ length: 99 }, (_, index) => index + 1),
      );
      expect(events[0]?.event.data.type).toBe("task_admitted");
      expect(events.at(-2)?.event.data.type).toBe("task_blocked");
      expect(events.at(-1)?.event.data.type).toBe("task_terminal");
      expect(JSON.stringify(events)).not.toContain("secret-b");
      slow.close();
      await expect(slowClosed).resolves.toBeUndefined();
      fast.close();
      fast.close();
      await expect(fast[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
      const shutdownListener = await openServerEventListener(server.url, { repositoryId: repo.id });
      const shutdownNext = shutdownListener[Symbol.asyncIterator]()
        .next()
        .catch(() => ({
          done: true as const,
          value: undefined,
        }));
      await server.close();
      await expect(shutdownNext).resolves.toMatchObject({ done: true });

      const restarted = await startUsineServer({
        environment: environment(stateDirectory),
        execute: async ({ authority, result }) =>
          authority.block({ taskId: result.taskId, revision: result.revision }, "restart"),
        host: "127.0.0.1",
        port: 0,
      });
      const fresh = await openServerEventListener(restarted.url, { repositoryId: repo.id });
      try {
        const nextTask = `fresh-${Date.now()}`;
        const nextContract = await contract(repo, nextTask);
        const nextEvents = collect(fresh, 2);
        await submitTask(restarted.url, { contractPath: nextContract, repositoryId: repo.id });
        expect(await nextEvents).toHaveLength(2);
      } finally {
        fresh.close();
        await restarted.close();
      }
    } finally {
      slow?.close();
      fast?.close();
    }
  });
});
