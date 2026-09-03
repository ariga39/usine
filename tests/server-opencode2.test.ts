import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { startUsineServer } from "@usine/runtime";
import { describe, expect, test } from "vite-plus/test";
import {
  registerRepository,
  submitTask,
  taskEvents,
  taskStatus,
  type TaskSubmission,
} from "../apps/cli/src/server-client.js";
import type { TaskContract } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function waitForTerminalTask(serverUrl: string, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await taskStatus(serverUrl, taskId);
    if (
      result &&
      (result.state === "blocked" || result.state === "reviewed_pr" || result.state === "merged")
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for server-owned OpenCode2 task");
}

describe("server-owned OpenCode2 execution", () => {
  test("selects an opaque OpenCode2 role through the normal Task path", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-server-opencode2-path-"));
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state");
    const codexHome = join(root, "codex-home");
    const emptyBin = join(root, "empty-bin");
    const taskId = `server-opencode2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const profile = "writer-role";
    await Promise.all([mkdir(repository), mkdir(codexHome), mkdir(emptyBin)]);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execa("git", ["config", "user.name", "Test"], { cwd: repository });
    await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
    await writeFile(join(repository, "README.md"), "server OpenCode2\n");
    await execa("git", ["add", "."], { cwd: repository });
    await execa("git", ["commit", "-m", "base"], { cwd: repository });
    const baseSha = await git(repository, "rev-parse", "HEAD");
    const contractPath = join(repository, "task.json");
    const contract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Exercise the server-owned OpenCode2 path.",
      acceptance: ["The server records a bounded provider-neutral terminal outcome."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: `https://github.com/example/${taskId}/issues/295`,
        delivery: true,
      },
      delivery: {
        branch: `agent/${taskId}`,
        issue: 295,
        title: "Server-owned OpenCode2 path",
        body: "Server-owned OpenCode2 path",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract));
    await execa("git", ["add", "task.json"], { cwd: repository });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
    await writeFile(join(codexHome, `${profile}.config.toml`), 'model = "fixture-model"\n');
    const gitExecutable = (await execa("which", ["git"], { env: process.env })).stdout.trim();
    if (!gitExecutable) throw new Error("git executable is unavailable");
    await symlink(gitExecutable, join(emptyBin, "git"));

    const environment: NodeJS.ProcessEnv = {
      USINE_STATE_DIR: stateDirectory,
      USINE_OPENCODE2_PROFILES: profile,
      CODEX_HOME: codexHome,
      PATH: emptyBin,
      USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "server-opencode2-app",
      USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
      USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
      USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "server-opencode2-private-key.pem",
      USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
    };
    const server = await startUsineServer({
      environment,
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
        implementerProfile: profile,
        reviewerProfile: "reviewer-role",
        forgeProfile: "default",
        projectCheck: { command: "true", timeoutMs: 1_000 },
        gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      });
      const submission: TaskSubmission = { contractPath, repositoryId: taskId };
      const admitted = await submitTask(server.url, submission);
      const terminal = await waitForTerminalTask(server.url, admitted.taskId);
      expect(terminal.state).toBe("blocked");
      expect(terminal.blocker).toEqual({ classification: "provider_failure" });
      const events = (await taskEvents(server.url, taskId, 0, 100)).events;
      const completed = events.find((event) => event.data.type === "coding_session_completed");
      expect(completed?.data).toMatchObject({
        type: "coding_session_completed",
        role: "implementer",
        outcome: "failed",
        requestedProfile: profile,
        effectiveProfile: { profileName: profile, adapter: "opencode2" },
        archive: { status: "stored" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "coding_session_interrupted",
            phase: "startup",
            failureClass: "configuration",
          }),
        }),
      );

      await server.close();
    } finally {
      await server.close().catch(() => undefined);
    }
  }, 30_000);
});
