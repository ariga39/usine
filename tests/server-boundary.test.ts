import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { runtimePolicyFromEnvironment, startUsineServer } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

describe("CLI/server boundary", () => {
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
      repository: { path: ".", owner: "example", name: taskId },
      baseSha,
      instructions: "Exercise the local server boundary.",
      acceptance: ["The server owns admission."],
      nonGoals: [],
      projectCheck: { command: "true", timeoutMs: 1_000 },
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/153`,
        delivery: true,
      },
      delivery: {
        baseBranch: "main",
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

    const policy = runtimePolicyFromEnvironment(
      {
        USINE_STATE_DIR: stateDirectory,
        USINE_STOP_AFTER: "admitted",
        USINE_GIT_AUTHOR_NAME: "Release Bot",
        USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
      },
      contract.repository,
    );
    const server = await startUsineServer({ policy, host: "127.0.0.1", port: 0 });

    try {
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const submit = await execa("node", [cliPath, "submit", contractPath], {
        cwd: repository,
        env: { USINE_SERVER_URL: server.url },
      });
      const submitted = JSON.parse(submit.stdout);
      expect(submitted).toMatchObject({ taskId, state: "admitted" });

      const status = await execa("node", [cliPath, "status", taskId], {
        cwd: root,
        env: { USINE_SERVER_URL: server.url },
      });
      const observed = JSON.parse(status.stdout);
      expect(observed).toEqual(submitted);
    } finally {
      await server.close();
    }
  }, 30_000);
});
