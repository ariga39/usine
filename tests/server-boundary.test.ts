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
        projectCheck: { command: "false", timeoutMs: 2_000 },
        gitAuthor: { name: "Updated Bot", email: "updated@example.invalid" },
      });
      await expect(inspectRepository(server.url, taskId)).resolves.toMatchObject({
        baseBranch: "release",
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
});
