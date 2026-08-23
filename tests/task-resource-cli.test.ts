import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import type { TaskContract } from "@usine/task-authority";
import { registerRepository, submitTask } from "../apps/cli/src/server-client.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCli(
  cliPath: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  reject = true,
) {
  try {
    return await execa("node", [cliPath, ...args], {
      cwd: root,
      env: environment,
      reject,
      timeout: 15_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CLI ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
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

    let resolveSessionStarted!: () => void;
    const sessionStarted = new Promise<void>((resolve) => {
      resolveSessionStarted = resolve;
    });
    let releaseSession!: () => void;
    const sessionRelease = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const server = await startUsineServer({
      environment: {
        USINE_STATE_DIR: stateDirectory,
        USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "resource-cli-app",
        USINE_FORGE_PROFILE_DEFAULT_APP_ID: "1",
        USINE_FORGE_PROFILE_DEFAULT_INSTALLATION_ID: "2",
        USINE_FORGE_PROFILE_DEFAULT_PRIVATE_KEY_PATH: "resource-cli-key.pem",
        USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: `example/${taskId}`,
      },
      execute: async ({ result, authority }) => {
        await authority.appendObservation(result.taskId, {
          eventId: "session-start",
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_started",
            role: "implementer",
            activation: 0,
            sessionId: "session-1",
          },
        });
        resolveSessionStarted();
        await sessionRelease;
        await authority.appendObservation(result.taskId, {
          eventId: "session-complete",
          occurredAtEpochMs: Date.now(),
          data: {
            type: "coding_session_completed",
            role: "implementer",
            activation: 0,
            outcome: "succeeded",
            sessionId: "session-1",
          },
        });
        const reserved = await authority.reserveActivation(result.taskId, 1);
        const candidate = await authority.recordCandidate(
          { taskId: result.taskId, revision: reserved.result.revision },
          {
            sha: "b".repeat(40),
            baseSha: contract.baseSha,
            fence: reserved.activation,
          },
        );
        const checked = await authority.recordCheck(
          { taskId: result.taskId, revision: candidate.revision },
          {
            sha: candidate.candidateSha!,
            status: "passed",
            command: "private check command",
            exitCode: 0,
            stdout: "private check stdout",
            stderr: "private check stderr",
          },
        );
        const reviewed = await authority.recordReview(
          { taskId: result.taskId, revision: checked.revision },
          {
            sha: checked.candidateSha!,
            verdict: "changes_requested",
            summary: "review sentinel private content REVIEW-PRIVATE-ALPHA",
            findings: ["finding sentinel private content FINDING-PRIVATE-BETA"],
          },
        );
        const current = await authority.lookup(result.taskId);
        if (!current) throw new Error("task disappeared during resource CLI test");
        return authority.block(
          { taskId: current.taskId, revision: reviewed.revision },
          "blocked sentinel BLOCKER-PRIVATE-GAMMA",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const cliPath = join(process.cwd(), "apps/cli/dist/cli.mjs");
      const environment = { USINE_SERVER_URL: server.url };
      await registerRepository(server.url, {
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
      });
      await submitTask(server.url, { contractPath });
      await within("coding session start", sessionStarted, 5_000);

      const list = await runCli(cliPath, root, environment, [
        "task",
        "list",
        "--limit",
        "1",
        "--json",
      ]);
      const listed = JSON.parse(list.stdout) as {
        tasks: Array<{ taskId: string; state: string }>;
      };
      expect(listed.tasks).toEqual([expect.objectContaining({ taskId, state: "admitted" })]);
      releaseSession();

      const watch = await runCli(cliPath, root, environment, [
        "task",
        "watch",
        "--after",
        "7",
        "--timeout",
        "10000",
        taskId,
        "--json",
      ]);
      const watchedEvents = watch.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { sequence: number; data: { type: string } });
      expect(watchedEvents.map((event) => event.sequence)).toEqual([8, 9]);
      expect(watchedEvents[1]?.data).toEqual({ type: "task_terminal", state: "blocked" });
      expect(JSON.parse(watch.stdout)).toMatchObject({ taskId, state: "blocked" });

      const get = await runCli(cliPath, root, environment, ["task", "get", taskId, "--json"]);
      expect(JSON.parse(get.stdout)).toMatchObject({ taskId, state: "blocked" });
      expect(get.stdout).not.toContain(repository);
      expect(get.stdout).not.toContain("writer-profile");
      expect(get.stdout).not.toContain("reviewer-profile");
      expect(get.stdout).not.toContain("default");
      expect(JSON.parse(get.stdout).review).toEqual({
        sha: "b".repeat(40),
        verdict: "changes_requested",
        classification: "changes_requested",
        findingCount: 1,
      });
      expect(JSON.parse(get.stdout).blocker).toEqual({ classification: "unknown" });
      expect(get.stdout).toContain("findingCount");
      expect(get.stdout).not.toContain("REVIEW-PRIVATE-ALPHA");
      expect(get.stdout).not.toContain("review sentinel private content");
      expect(get.stdout).not.toContain("FINDING-PRIVATE-BETA");
      expect(get.stdout).not.toContain("BLOCKER-PRIVATE-GAMMA");

      const missing = await runCli(
        cliPath,
        root,
        environment,
        ["task", "get", `${taskId}-missing`],
        false,
      );
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stderr)).toEqual({
        error: "task_not_found",
        taskId: `${taskId}-missing`,
      });
    } finally {
      releaseSession();
      await within("server shutdown", server.close(), 5_000);
    }
  }, 30_000);
});
