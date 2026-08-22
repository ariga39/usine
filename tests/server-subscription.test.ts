import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import type { ServerEventEnvelope, TaskContract } from "@usine/task-authority";
import {
  openServerEventListener,
  registerRepository,
  submitTask,
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

async function collectThrough(
  listener: Awaited<ReturnType<typeof openServerEventListener>>,
  targetCursor: number,
): Promise<ServerEventEnvelope[]> {
  const events: ServerEventEnvelope[] = [];
  for await (const event of listener) {
    events.push(event);
    if (event.cursor === targetCursor) return events;
  }
  throw new Error(`public event listener closed before cursor ${targetCursor}`);
}

describe("public server event listener", () => {
  test("observes ordered admission and terminal events before submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-subscription-"));
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state");
    const taskId = `subscription-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await mkdir(repository);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execa("git", ["config", "user.name", "Test"], { cwd: repository });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "subscription\n");
    await execa("git", ["add", "."], { cwd: repository });
    await execa("git", ["commit", "-m", "base"], { cwd: repository });
    const baseSha = await git(repository, "rev-parse", "HEAD");
    const contractPath = join(repository, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise the public event listener.",
      acceptance: ["Admission and terminal events are observable in order."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/219`,
        delivery: true,
      },
      delivery: {
        branch: `agent/${taskId}`,
        issue: 219,
        title: "Public event listener",
        body: "Public event listener",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract));
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "subscription-app",
        USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
        USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "subscription-private-key.pem",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
      },
      execute: async ({ authority, result }) =>
        authority.block(
          { taskId: result.taskId, revision: result.revision },
          "subscription test complete",
        ),
      host: "127.0.0.1",
      port: 0,
    });
    const listener = await openServerEventListener(server.url);

    try {
      await registerRepository(server.url, {
        id: taskId,
        path: await realpath(repository),
        owner: "example",
        name: taskId,
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });

      const observedPromise = (async () => {
        const events = [];
        for await (const envelope of listener) {
          events.push(envelope);
          if (envelope.event.data.type === "task_terminal") return events;
        }
        throw new Error("public event listener closed before terminal event");
      })();
      await submitTask(server.url, { contractPath, repositoryId: taskId });
      const events = await observedPromise;
      expect(events.map(({ cursor }) => cursor)).toEqual([1, 2, 3]);
      expect(events.map(({ event }) => event.data.type)).toEqual([
        "task_admitted",
        "task_blocked",
        "task_terminal",
      ]);
      expect(events.every((entry) => entry.taskId === taskId)).toBe(true);
    } finally {
      listener.close();
      await server.close();
    }
  });

  test("replays a disconnected multi-repository cursor and continues live after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-subscription-reconnect-"));
    const stateDirectory = join(root, "state");
    const requests: Array<{ method: string; url: URL }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push({ method: init?.method ?? "GET", url });
      return originalFetch(input, init);
    };

    const prepareRepository = async (id: string) => {
      const path = join(root, id);
      await mkdir(path);
      await execa("git", ["init", "--initial-branch=main"], { cwd: path });
      await execa("git", ["config", "user.name", "Test"], { cwd: path });
      await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
      await writeFile(join(path, "README.md"), `${id}\n`);
      await execa("git", ["add", "."], { cwd: path });
      await execa("git", ["commit", "-m", "base"], { cwd: path });
      return { id, name: id, path, baseSha: await git(path, "rev-parse", "HEAD") };
    };

    const repositoryA = await prepareRepository("repository-a");
    const repositoryB = await prepareRepository("repository-b");
    const prepareTask = async (
      repository: typeof repositoryA,
      taskId: string,
      issue: number,
    ): Promise<string> => {
      const contractPath = join(repository.path, `${taskId}.json`);
      const contract: TaskContract = {
        id: taskId,
        repositoryId: repository.id,
        baseSha: repository.baseSha,
        instructions: "Exercise the public event listener.",
        acceptance: ["Events remain ordered across reconnect and restart."],
        nonGoals: [],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
        authorization: {
          source: `https://github.com/example/${repository.name}/issues/${issue}`,
          delivery: true,
        },
        delivery: {
          branch: `agent/${taskId}`,
          issue,
          title: "Public event listener reconnect",
          body: "Public event listener reconnect",
        },
      };
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "."], { cwd: repository.path });
      await execa("git", ["commit", "-m", `authorize ${taskId}`], { cwd: repository.path });
      return contractPath;
    };

    const taskA = `subscription-reconnect-a-${Date.now()}`;
    const taskB = `subscription-reconnect-b-${Date.now()}`;
    const taskC = `subscription-reconnect-c-${Date.now()}`;
    const contractA = await prepareTask(repositoryA, taskA, 219);
    const contractB = await prepareTask(repositoryB, taskB, 219);
    const contractC = await prepareTask(repositoryA, taskC, 220);
    const completed = new Map([
      [taskA, deferred()],
      [taskB, deferred()],
      [taskC, deferred()],
    ]);
    const execute = async ({
      authority,
      result,
    }: Parameters<NonNullable<Parameters<typeof startUsineServer>[0]["execute"]>>[0]) => {
      const terminal = await authority.block(
        { taskId: result.taskId, revision: result.revision },
        "subscription reconnect test complete",
      );
      completed.get(result.taskId)?.resolve();
      return terminal;
    };
    const environment: NodeJS.ProcessEnv = {
      USINE_STATE_DIR: stateDirectory,
      USINE_ACTIVE_TASK_CAPACITY: "2",
      USINE_FORGE_PROFILE_REPOSITORY_A_APP_SLUG: "subscription-app-a",
      USINE_FORGE_PROFILE_REPOSITORY_A_TEST_TOKEN: "subscription-token-a",
      USINE_FORGE_PROFILE_REPOSITORY_A_API_URL: "http://127.0.0.1:9",
      USINE_FORGE_PROFILE_REPOSITORY_A_REPOSITORY: "example/repository-a",
      USINE_FORGE_PROFILE_REPOSITORY_B_APP_SLUG: "subscription-app-b",
      USINE_FORGE_PROFILE_REPOSITORY_B_TEST_TOKEN: "subscription-token-b",
      USINE_FORGE_PROFILE_REPOSITORY_B_API_URL: "http://127.0.0.1:9",
      USINE_FORGE_PROFILE_REPOSITORY_B_REPOSITORY: "example/repository-b",
    };
    const registration = async (serverUrl: string, repository: typeof repositoryA) =>
      registerRepository(serverUrl, {
        id: repository.id,
        path: await realpath(repository.path),
        owner: "example",
        name: repository.name,
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: repository.id,
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });

    let server: Awaited<ReturnType<typeof startUsineServer>> | undefined;
    let listener: Awaited<ReturnType<typeof openServerEventListener>> | undefined;
    try {
      server = await startUsineServer({
        environment,
        execute,
        host: "127.0.0.1",
        port: 0,
      });
      await registration(server.url, repositoryA);
      await registration(server.url, repositoryB);
      listener = await openServerEventListener(server.url);
      const firstEventPromise = collectThrough(listener, 1);
      await submitTask(server.url, { contractPath: contractA, repositoryId: repositoryA.id });
      const firstEvents = await firstEventPromise;
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]).toMatchObject({ cursor: 1, taskId: taskA });
      listener.close();
      listener = undefined;
      await completed.get(taskA)!.promise;

      await submitTask(server.url, { contractPath: contractB, repositoryId: repositoryB.id });
      await completed.get(taskB)!.promise;
      listener = await openServerEventListener(server.url, { afterCursor: 1 });
      const replayed = await collectThrough(listener, 6);
      listener.close();
      listener = undefined;
      expect(replayed.map(({ cursor }) => cursor)).toEqual([2, 3, 4, 5, 6]);
      expect(replayed.map(({ taskId }) => taskId)).toEqual([taskA, taskA, taskB, taskB, taskB]);
      expect(replayed.map(({ event }) => event.data.type)).toEqual([
        "task_blocked",
        "task_terminal",
        "task_admitted",
        "task_blocked",
        "task_terminal",
      ]);

      await server.close();
      server = await startUsineServer({
        environment,
        execute,
        host: "127.0.0.1",
        port: 0,
      });
      listener = await openServerEventListener(server.url, { afterCursor: 6 });
      const liveAfterRestart = collectThrough(listener, 9);
      await submitTask(server.url, { contractPath: contractC, repositoryId: repositoryA.id });
      await completed.get(taskC)!.promise;
      const restarted = await liveAfterRestart;
      expect(restarted.map(({ cursor }) => cursor)).toEqual([7, 8, 9]);
      expect(restarted.every(({ taskId }) => taskId === taskC)).toBe(true);
      expect(restarted.map(({ event }) => event.data.type)).toEqual([
        "task_admitted",
        "task_blocked",
        "task_terminal",
      ]);

      const observedCursors = [...firstEvents, ...replayed, ...restarted].map(
        ({ cursor }) => cursor,
      );
      expect(observedCursors).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(observedCursors).size).toBe(observedCursors.length);
      expect([...firstEvents, ...replayed, ...restarted].map(({ taskId }) => taskId)).toEqual([
        taskA,
        taskA,
        taskA,
        taskB,
        taskB,
        taskB,
        taskC,
        taskC,
        taskC,
      ]);
      expect(
        [...firstEvents, ...replayed, ...restarted].map(({ event }) => event.data.type),
      ).toEqual([
        "task_admitted",
        "task_blocked",
        "task_terminal",
        "task_admitted",
        "task_blocked",
        "task_terminal",
        "task_admitted",
        "task_blocked",
        "task_terminal",
      ]);
      const observedGets = requests
        .filter(({ method }) => method === "GET")
        .map(({ url }) => `${url.pathname}${url.search}`);
      expect(observedGets).toEqual([
        "/v1/events?after=0&limit=200",
        "/v1/events?after=1&limit=200",
        "/v1/events?after=6&limit=200",
      ]);
    } finally {
      listener?.close();
      if (server) await server.close();
      globalThis.fetch = originalFetch;
    }
  });
});
