import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";
import {
  inspectRepository,
  registerRepository,
  submitTask,
} from "../apps/cli/src/server-client.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

describe("CLI/server boundary", () => {
  test("rejects non-loopback hosts before binding", async () => {
    await expect(
      startUsineServer({
        environment: { USINE_STATE_DIR: join(tmpdir(), "usine-server-boundary-host") },
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow("loopback");
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

    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
      },
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
          path: trustedPath,
          owner: "example",
          name: taskId,
          baseBranch: "main",
          projectCheck: { command: "true", timeoutMs: 1_000 },
          gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
        },
      });

      await expect(inspectRepository(server.url, taskId)).resolves.toMatchObject({
        id: taskId,
        path: trustedPath,
        owner: "example",
        name: taskId,
      });
      await registerRepository(server.url, {
        id: taskId,
        path: trustedPath,
        owner: "example",
        name: taskId,
        baseBranch: "release",
        implementerProfile: "updated-writer-profile",
        reviewerProfile: "updated-reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "false", timeoutMs: 2_000 },
        gitAuthor: { name: "Updated Bot", email: "updated@example.invalid" },
      });
      await expect(inspectRepository(server.url, taskId)).resolves.toMatchObject({
        baseBranch: "release",
        implementerProfile: "updated-writer-profile",
        reviewerProfile: "updated-reviewer-profile",
        forgeProfile: "default",
        projectCheck: { command: "false", timeoutMs: 2_000 },
      });
      const admittedAgain = await submitTask(server.url, { contractPath, repositoryId: taskId });
      expect(admittedAgain.repository).toMatchObject({
        baseBranch: "main",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });

      const status = await execa("node", [cliPath, "status", taskId], {
        cwd: root,
        env: { USINE_SERVER_URL: server.url },
      });
      const observed = JSON.parse(status.stdout);
      expect(observed).toMatchObject({ ...submitted, history: [] });
    } finally {
      await server.close();
    }
  }, 30_000);

  test("looks up each Repository policy independently for the next execution run", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-profiles-"));
    const stateDirectory = join(root, "state");
    const seen = new Map<string, [string, string]>();
    const waiting = new Map<string, (value: void) => void>();
    const server = await startUsineServer({
      environment: { USINE_STATE_DIR: stateDirectory },
      execute: async ({ result, policy, authority }) => {
        seen.set(result.taskId, [policy.roles.implementer.profile, policy.roles.reviewer.profile]);
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
        forgeProfile: "default",
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
      expect(seen.get("profiles-one")).toEqual(["one-writer", "one-reviewer"]);
      expect(seen.get("profiles-two")).toEqual(["two-writer", "two-reviewer"]);

      await registerRepository(server.url, {
        id: "profiles-one",
        path: await realpath(first.path),
        owner: "example",
        name: "profiles-one",
        baseBranch: "main",
        implementerProfile: "one-writer-updated",
        reviewerProfile: "one-reviewer-updated",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });
      await expect(inspectRepository(server.url, "profiles-two")).resolves.toMatchObject({
        implementerProfile: "two-writer",
        reviewerProfile: "two-reviewer",
      });

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
      expect(seen.get(nextTaskId)).toEqual(["one-writer-updated", "one-reviewer-updated"]);
    } finally {
      await server.close();
    }
  }, 30_000);
});
