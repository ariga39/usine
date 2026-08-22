import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";
import {
  openServerEventListener,
  registerRepository,
  submitTask,
} from "../apps/cli/src/server-client.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
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
});
