import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { MAX_TASK_CONTRACT_BYTES, startUsineServer } from "@usine/runtime";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  type RepositorySnapshot,
  type TaskContract,
} from "@usine/task-authority";
import {
  inspectRepository,
  listRepositories,
  listTasks,
  registerRepository,
  serverSnapshot,
  submitTask,
} from "../apps/cli/src/server-client.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

describe("CLI/server boundary", () => {
  test("bounds Task Contract ingestion before admission and accepts the exact bound", async () => {
    const maxContractBytes = MAX_TASK_CONTRACT_BYTES;
    const root = await mkdtemp(join(tmpdir(), "usine-server-contract-boundary-"));
    const repositoryPath = join(root, "repository");
    const stateDirectory = join(root, "state");
    await mkdir(repositoryPath);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
    await execa("git", ["config", "user.name", "Test"], { cwd: repositoryPath });
    await execa("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repositoryPath,
    });
    await writeFile(join(repositoryPath, "README.md"), "contract boundary\n");
    await execa("git", ["add", "."], { cwd: repositoryPath });
    await execa("git", ["commit", "-m", "base"], { cwd: repositoryPath });
    const baseSha = await git(repositoryPath, "rev-parse", "HEAD");
    const taskId = "bounded-contract-boundary";
    const contractPath = join(repositoryPath, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise bounded Task Contract ingestion.",
      acceptance: ["The committed contract is admitted at the supported byte bound."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: "https://github.com/example/bounded-contract-boundary/issues/330",
        delivery: true,
      },
      delivery: {
        branch: "agent/bounded-contract-boundary",
        issue: 330,
        title: "Bounded contract ingestion",
        body: "Bounded contract ingestion",
      },
    };
    const contractJson = JSON.stringify(contract);
    const contractPadding = maxContractBytes - Buffer.byteLength(contractJson);
    if (contractPadding < 1) throw new Error("contract fixture unexpectedly exceeds its bound");
    await writeFile(contractPath, contractJson + " ".repeat(contractPadding));
    expect((await stat(contractPath)).size).toBe(maxContractBytes);
    await execa("git", ["add", "task.json"], { cwd: repositoryPath });
    await execa("git", ["commit", "-m", "authorize bounded contract"], { cwd: repositoryPath });

    const oversizedPath = join(repositoryPath, "oversized.json");
    const oversizedPadding = maxContractBytes + 1 - Buffer.byteLength(contractJson);
    await writeFile(oversizedPath, contractJson + " ".repeat(oversizedPadding));
    const nonRegularPath = join(repositoryPath, "contract-directory");
    await mkdir(nonRegularPath);
    await writeFile(join(nonRegularPath, "marker"), "directory source\n");
    expect((await stat(oversizedPath)).size).toBe(maxContractBytes + 1);
    await execa("git", ["add", "oversized.json", "contract-directory/marker"], {
      cwd: repositoryPath,
    });
    await execa("git", ["commit", "-m", "authorize oversized contract fixture"], {
      cwd: repositoryPath,
    });
    expect(await git(repositoryPath, "status", "--porcelain")).toBe("");
    let executionCalls = 0;
    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "bounded-contract-app",
        USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
        USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "bounded-contract-key.pem",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/bounded-contract-boundary",
      },
      execute: async ({ result }) => {
        executionCalls += 1;
        return result;
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      await registerRepository(server.url, {
        id: taskId,
        path: await realpath(repositoryPath),
        owner: "example",
        name: "bounded-contract-boundary",
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });

      for (const [rejectedPath, message] of [
        [oversizedPath, `task contract exceeds the ${maxContractBytes}-byte limit`],
        [nonRegularPath, "task contract must be a regular file"],
      ] as const) {
        const response = await fetch(new URL("/v1/tasks", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contractPath: rejectedPath }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: "validation", message });
      }
      expect(await listTasks(server.url)).toEqual({ tasks: [] });
      expect(executionCalls).toBe(0);

      await expect(submitTask(server.url, { contractPath })).resolves.toMatchObject({
        taskId,
        state: "admitted",
      });
    } finally {
      await server.close();
    }
  }, 30_000);

  test("rejects non-loopback hosts before binding", async () => {
    await expect(
      startUsineServer({
        environment: { USINE_STATE_DIR: join(tmpdir(), "usine-server-boundary-host") },
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow("loopback");
  });

  test("privatizes an existing state root and database before startup", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "usine-server-private-state-"));
    const stateDirectory = join(root, "state");
    const databasePath = join(stateDirectory, "usine.sqlite");
    const repository: RepositorySnapshot = {
      id: "private-state-repository",
      path: root,
      owner: "example",
      name: "private-state-repository",
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    };

    await mkdir(stateDirectory, { mode: 0o777 });
    await chmod(stateDirectory, 0o777);
    await applyMigrations(databasePath);
    const handle = openSqliteDatabase(databasePath);
    try {
      await new TaskAuthority(handle.database).registerRepository(repository);
    } finally {
      handle.close();
    }
    await chmod(databasePath, 0o666);

    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "private-state-app",
        USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
        USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "private-state-key.pem",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/private-state-repository",
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
      await expect(inspectRepository(server.url, repository.id)).resolves.toMatchObject({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        baseBranch: repository.baseBranch,
      });
    } finally {
      await server.close();
    }
  });

  test("cleans up the server scope when binding fails during startup", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    let cleanupCalls = 0;

    try {
      await expect(
        startUsineServer({
          environment: { USINE_STATE_DIR: join(tmpdir(), "usine-server-startup-failure") },
          codingSession: {
            cleanupTask: async () => undefined,
            cleanupOwned: async () => {
              cleanupCalls += 1;
            },
          },
          host: "127.0.0.1",
          port: address.port,
        }),
      ).rejects.toThrow("listen");
      expect(cleanupCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("projects an occupied port through the built CLI server failure contract", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    try {
      const result = await execa("node", [join(process.cwd(), "apps/cli/dist/cli.mjs"), "server"], {
        env: {
          USINE_STATE_DIR: join(tmpdir(), "usine-server-cli-startup-failure"),
          USINE_SERVER_HOST: "127.0.0.1",
          USINE_SERVER_PORT: String(address.port),
        },
        reject: false,
        stripFinalNewline: false,
      });

      expect(result.exitCode).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        '{"error":"server_failed","kind":"server","message":"operation failed"}\n',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("submits a task to the local server and reads the same durable Task ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-boundary-"));
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
    const taskId = `server-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contractPath = join(repository, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise the local server boundary.",
      acceptance: ["The server owns admission."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/153`,
        delivery: true,
      },
      delivery: {
        branch: `agent/${taskId}`,
        issue: 153,
        title: "Server boundary",
        body: "Server boundary",
      },
    };
    const rawContract = JSON.stringify(contract);
    await writeFile(contractPath, rawContract);
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

    const serverEnvironment: NodeJS.ProcessEnv = {
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "boundary-app",
      USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
      USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
      USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "boundary-private-key-181.pem",
      USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
    };
    const server = await startUsineServer({
      environment: serverEnvironment,
      execute: async ({ result }) => result,
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const trustedPath = await realpath(repository);
      await registerRepository(server.url, {
        id: taskId,
        path: trustedPath,
        owner: "example",
        name: taskId,
        baseBranch: "main",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const submit = await execa("node", [cliPath, "submit", contractPath], {
        cwd: repository,
        env: { USINE_SERVER_URL: server.url },
      });
      const submitted = JSON.parse(submit.stdout);
      expect(submitted).toMatchObject({
        taskId,
        state: "admitted",
        repository: {
          id: taskId,
          owner: "example",
          name: taskId,
          baseBranch: "main",
        },
      });
      expect(JSON.stringify(submitted)).not.toContain(trustedPath);

      await expect(inspectRepository(server.url, taskId)).resolves.toMatchObject({
        id: taskId,
        owner: "example",
        name: taskId,
      });
      const repositoryStatus = await inspectRepository(server.url, taskId);
      expect(JSON.stringify(repositoryStatus)).not.toContain("boundary-private-key-181");
      await registerRepository(server.url, {
        id: taskId,
        path: trustedPath,
        owner: "example",
        name: taskId,
        baseBranch: "release",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "false", timeoutMs: 2_000 },
        gitAuthor: { name: "Updated Bot", email: "updated@example.invalid" },
      });
      await expect(inspectRepository(server.url, taskId)).resolves.toMatchObject({
        baseBranch: "release",
        revision: 2,
      });
      const updatedRepositoryStatus = await inspectRepository(server.url, taskId);
      expect(updatedRepositoryStatus).not.toHaveProperty("implementerProfile");
      expect(updatedRepositoryStatus).not.toHaveProperty("reviewerProfile");
      expect(updatedRepositoryStatus).not.toHaveProperty("forgeProfile");
      const admittedAgain = await submitTask(server.url, { contractPath, repositoryId: taskId });
      expect(admittedAgain.repository).toMatchObject({
        baseBranch: "main",
      });

      const status = await execa("node", [cliPath, "status", taskId], {
        cwd: root,
        env: { USINE_SERVER_URL: server.url },
      });
      const observed = JSON.parse(status.stdout);
      expect(observed).toEqual(submitted);
      expect(JSON.stringify(observed)).not.toContain("boundary-private-key-181");

      delete serverEnvironment.USINE_FORGE_PROFILE_DEFAULT_APP_SLUG;
      const errorResponse = await fetch(new URL("/v1/tasks", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contractPath }),
      });
      const errorBody = await errorResponse.json();
      expect(errorResponse.status).toBe(500);
      expect(errorBody).toMatchObject({ code: "unauthorized" });
      expect(JSON.stringify(errorBody)).not.toContain("boundary-private-key-181");
    } finally {
      await server.close();
    }
  }, 30_000);

  test("looks up each Repository policy independently for the next execution run", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-profiles-"));
    const stateDirectory = join(root, "state");
    const seen = new Map<string, [string, string, string, string, number]>();
    const waiting = new Map<string, (value: void) => void>();
    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_PROFILES_ONE_APP_SLUG: "one-app",
        USINE_FORGE_PROFILE_PROFILES_ONE_APP_ID: "1",
        USINE_FORGE_PROFILE_PROFILES_ONE_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_PROFILES_ONE_PRIVATE_KEY_PATH: "one.pem",
        USINE_FORGE_PROFILE_PROFILES_ONE_REPOSITORY: "example/profiles-one",
        USINE_FORGE_PROFILE_PROFILES_TWO_APP_SLUG: "two-app",
        USINE_FORGE_PROFILE_PROFILES_TWO_APP_ID: "3",
        USINE_FORGE_PROFILE_PROFILES_TWO_INSTALLATION_ID: "4",
        USINE_FORGE_PROFILE_PROFILES_TWO_PRIVATE_KEY_PATH: "two.pem",
        USINE_FORGE_PROFILE_PROFILES_TWO_REPOSITORY: "example/profiles-two",
        USINE_FORGE_PROFILE_PROFILES_ONE_THIRD_APP_SLUG: "three-app",
        USINE_FORGE_PROFILE_PROFILES_ONE_THIRD_APP_ID: "5",
        USINE_FORGE_PROFILE_PROFILES_ONE_THIRD_INSTALLATION_ID: "6",
        USINE_FORGE_PROFILE_PROFILES_ONE_THIRD_PRIVATE_KEY_PATH: "three.pem",
        USINE_FORGE_PROFILE_PROFILES_ONE_THIRD_REPOSITORY: "example/profiles-one",
      },
      execute: async ({ result, policy, authority }) => {
        seen.set(result.taskId, [
          policy.roles.implementer.profile,
          policy.roles.reviewer.profile,
          policy.forge.mode,
          policy.forge.appSlug,
          policy.forge.mode === "app" ? policy.forge.installationId : 0,
        ]);
        waiting.get(result.taskId)?.();
        return authority.block(
          { taskId: result.taskId, revision: result.revision },
          "boundary test",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });

    const prepare = async (
      id: string,
      owner: string,
      name: string,
      profiles: [string, string],
    ): Promise<{ path: string; contractPath: string; baseSha: string }> => {
      const path = join(root, id);
      await mkdir(path);
      await execa("git", ["init", "--initial-branch=main"], { cwd: path });
      await execa("git", ["config", "user.name", "Test"], { cwd: path });
      await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
      await writeFile(join(path, "README.md"), `${id}\n`);
      await execa("git", ["add", "."], { cwd: path });
      await execa("git", ["commit", "-m", "base"], { cwd: path });
      const baseSha = await git(path, "rev-parse", "HEAD");
      const contractPath = join(path, "task.json");
      const contract: TaskContract = {
        id,
        repositoryId: id,
        baseSha,
        instructions: "Exercise live Repository policy lookup.",
        acceptance: ["The selected profiles remain repository-local."],
        nonGoals: [],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
        authorization: { source: `https://github.com/${owner}/${name}/issues/180`, delivery: true },
        delivery: {
          branch: `agent/${id}`,
          issue: 180,
          title: "Repository profiles",
          body: "Repository profiles",
        },
      };
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "task.json"], { cwd: path });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: path });
      await registerRepository(server.url, {
        id,
        path: await realpath(path),
        owner,
        name,
        baseBranch: "main",
        implementerProfile: profiles[0],
        reviewerProfile: profiles[1],
        forgeProfile: id,
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });
      return { path, contractPath, baseSha };
    };

    const first = await prepare("profiles-one", "example", "profiles-one", [
      "one-writer",
      "one-reviewer",
    ]);
    const second = await prepare("profiles-two", "example", "profiles-two", [
      "two-writer",
      "two-reviewer",
    ]);
    const waitFor = (id: string): Promise<void> => {
      if (seen.has(id)) return Promise.resolve();
      return new Promise((resolve) => waiting.set(id, resolve));
    };

    try {
      await submitTask(server.url, {
        contractPath: first.contractPath,
        repositoryId: "profiles-one",
      });
      await submitTask(server.url, {
        contractPath: second.contractPath,
        repositoryId: "profiles-two",
      });
      await Promise.all([waitFor("profiles-one"), waitFor("profiles-two")]);
      expect(seen.get("profiles-one")).toEqual(["one-writer", "one-reviewer", "app", "one-app", 2]);
      expect(seen.get("profiles-two")).toEqual(["two-writer", "two-reviewer", "app", "two-app", 4]);

      await expect(listRepositories(server.url, 1)).resolves.toMatchObject({
        repositories: [{ id: "profiles-one" }],
      });
      await expect(listTasks(server.url, 1)).resolves.toMatchObject({
        tasks: [{ taskId: "profiles-one" }],
      });
      await expect(serverSnapshot(server.url, 1)).resolves.toMatchObject({
        repositories: [{ id: "profiles-one" }],
        tasks: [{ taskId: "profiles-one" }],
      });

      await registerRepository(server.url, {
        id: "profiles-one",
        path: await realpath(first.path),
        owner: "example",
        name: "profiles-one",
        baseBranch: "main",
        implementerProfile: "one-writer-updated",
        reviewerProfile: "one-reviewer-updated",
        forgeProfile: "profiles-one-third",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });
      await expect(inspectRepository(server.url, "profiles-two")).resolves.toMatchObject({
        id: "profiles-two",
        revision: 1,
      });
      const unchangedRepository = await inspectRepository(server.url, "profiles-two");
      expect(unchangedRepository).not.toHaveProperty("implementerProfile");
      expect(unchangedRepository).not.toHaveProperty("reviewerProfile");
      expect(unchangedRepository).not.toHaveProperty("forgeProfile");

      const nextTaskId = "profiles-one-next";
      const nextContractPath = join(first.path, "task-next.json");
      const nextContract: TaskContract = {
        id: nextTaskId,
        repositoryId: "profiles-one",
        baseSha: first.baseSha,
        instructions: "Exercise the next execution run policy boundary.",
        acceptance: ["The next run reads the updated Repository policy."],
        nonGoals: [],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
        authorization: {
          source: "https://github.com/example/profiles-one/issues/180",
          delivery: true,
        },
        delivery: {
          branch: `agent/${nextTaskId}`,
          issue: 180,
          title: "Repository profiles next run",
          body: "Repository profiles next run",
        },
      };
      await writeFile(nextContractPath, JSON.stringify(nextContract));
      await execa("git", ["add", "task-next.json"], { cwd: first.path });
      await execa("git", ["commit", "-m", "authorize next task"], { cwd: first.path });
      await submitTask(server.url, {
        contractPath: nextContractPath,
        repositoryId: "profiles-one",
      });
      await waitFor(nextTaskId);
      expect(seen.get(nextTaskId)).toEqual([
        "one-writer-updated",
        "one-reviewer-updated",
        "app",
        "three-app",
        6,
      ]);
    } finally {
      await server.close();
    }
  }, 30_000);
});
