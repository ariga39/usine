import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

describe("resource-oriented Task CLI", () => {
  test("discovers a Task, gets it exactly, and resumes its event watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-task-resource-cli-"));
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state");
    await mkdir(repository);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execa("git", ["config", "user.name", "Test"], { cwd: repository });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "resource cli\n");
    await execa("git", ["add", "."], { cwd: repository });
    await execa("git", ["commit", "-m", "base"], { cwd: repository });
    const baseSha = await git(repository, "rev-parse", "HEAD");
    const taskId = `resource-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contractPath = join(repository, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise the resource-oriented Task CLI.",
      acceptance: ["An operator can discover and follow this Task."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/188`,
        delivery: true,
      },
      delivery: {
        branch: `agent/${taskId}`,
        issue: 188,
        title: "Resource CLI",
        body: "Resource CLI",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract));
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "resource-cli-app",
        USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
        USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "resource-cli-key.pem",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
      },
      execute: ({ result, authority }) =>
        authority.block({ taskId: result.taskId, revision: result.revision }, "resource CLI test"),
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const trustedPath = await realpath(repository);
      const environment = { USINE_SERVER_URL: server.url };
      await writeFile(
        join(root, "repository.json"),
        JSON.stringify({
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
        }),
      );
      await execa("node", [cliPath, "register", join(root, "repository.json")], {
        cwd: repository,
        env: environment,
      });
      await execa("node", [cliPath, "submit", contractPath], {
        cwd: repository,
        env: environment,
      });

      const list = await execa("node", [cliPath, "task", "list", "--json"], {
        cwd: root,
        env: environment,
      });
      const listed = JSON.parse(list.stdout) as {
        tasks: Array<{ taskId: string; state: string; revision: number }>;
      };
      const discovered = listed.tasks.find((task) => task.taskId === taskId);
      expect(discovered).toMatchObject({ taskId, state: "blocked" });

      const get = await execa("node", [cliPath, "task", "get", taskId, "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(get.stdout)).toMatchObject({ taskId, state: "blocked" });

      const watch = await execa(
        "node",
        [cliPath, "task", "watch", taskId, "--after", "1", "--json"],
        { cwd: root, env: environment },
      );
      const watchedEvents = watch.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { sequence: number; data: { type: string } });
      expect(watchedEvents.map((event) => event.sequence)).toEqual([2, 3]);
      expect(watchedEvents[1]?.data).toEqual({ type: "task_terminal", state: "blocked" });
      expect(JSON.parse(watch.stdout)).toMatchObject({ taskId, state: "blocked" });
    } finally {
      await server.close();
    }
  }, 30_000);
});
