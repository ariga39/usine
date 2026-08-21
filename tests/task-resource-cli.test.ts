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
      const registered = await execa("node", [cliPath, "register", join(root, "repository.json")], {
        cwd: repository,
        env: environment,
      });
      expect(JSON.stringify(JSON.parse(registered.stdout))).not.toContain(trustedPath);

      const repositories = await execa("node", [cliPath, "repository", "list", "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(repositories.stdout)).toMatchObject({
        repositories: [{ id: taskId, owner: "example", name: taskId, revision: 1 }],
      });
      expect(repositories.stdout).not.toContain(trustedPath);
      expect(repositories.stdout).not.toContain("writer-profile");
      expect(repositories.stdout).not.toContain("reviewer-profile");
      expect(repositories.stdout).not.toContain("default");
      const limitedRepositories = await execa(
        "node",
        [cliPath, "repository", "list", "--limit", "1", "--json"],
        { cwd: root, env: environment },
      );
      expect(JSON.parse(limitedRepositories.stdout).repositories).toEqual([
        { id: taskId, revision: 1, owner: "example", name: taskId, baseBranch: "main" },
      ]);

      const repositoryGet = await execa("node", [cliPath, "repository", "get", taskId, "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(repositoryGet.stdout)).toMatchObject({
        id: taskId,
        owner: "example",
        name: taskId,
        revision: 1,
      });
      expect(repositoryGet.stdout).not.toContain(trustedPath);
      expect(repositoryGet.stdout).not.toContain("writer-profile");
      expect(repositoryGet.stdout).not.toContain("reviewer-profile");
      expect(repositoryGet.stdout).not.toContain("default");
      const health = await execa("node", [cliPath, "server", "health", "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(health.stdout)).toMatchObject({ status: "ok", revision: 1 });
      const initialSnapshot = await execa("node", [cliPath, "server", "snapshot", "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(initialSnapshot.stdout)).toMatchObject({
        schemaVersion: 1,
        repositories: [{ id: taskId, revision: 1 }],
        tasks: [],
        codingSessions: [],
      });
      expect(initialSnapshot.stdout).not.toContain(trustedPath);
      const limitedSnapshot = await execa(
        "node",
        [cliPath, "server", "snapshot", "--limit", "1", "--json"],
        { cwd: root, env: environment },
      );
      expect(JSON.parse(limitedSnapshot.stdout)).toMatchObject({
        repositories: [{ id: taskId }],
        tasks: [],
        codingSessions: [],
      });
      await execa("node", [cliPath, "register", join(root, "repository.json")], {
        cwd: repository,
        env: environment,
      });
      await execa("node", [cliPath, "register", join(root, "repository.json")], {
        cwd: repository,
        env: environment,
      });
      const highRevisionSnapshot = await execa("node", [cliPath, "server", "snapshot", "--json"], {
        cwd: root,
        env: environment,
      });
      const highRevision = JSON.parse(highRevisionSnapshot.stdout).revision as number;
      await execa("node", [cliPath, "submit", contractPath], {
        cwd: repository,
        env: environment,
      });
      await sessionStarted;
      const activeSnapshot = await execa("node", [cliPath, "server", "snapshot", "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(activeSnapshot.stdout)).toMatchObject({
        codingSessions: [{ taskId, sessionId: "session-1", role: "implementer", activation: 0 }],
      });
      expect(activeSnapshot.stdout).not.toContain(trustedPath);
      releaseSession();

      const list = await execa("node", [cliPath, "task", "list", "--json"], {
        cwd: root,
        env: environment,
      });
      const listed = JSON.parse(list.stdout) as {
        tasks: Array<{ taskId: string; state: string; revision: number }>;
      };
      const discovered = listed.tasks.find((task) => task.taskId === taskId);
      expect(discovered).toMatchObject({ taskId, state: "blocked" });
      const limitedTasks = await execa(
        "node",
        [cliPath, "task", "list", "--limit", "1", "--json"],
        { cwd: root, env: environment },
      );
      expect(JSON.parse(limitedTasks.stdout).tasks).toEqual([
        expect.objectContaining({ taskId, state: "blocked" }),
      ]);

      const get = await execa("node", [cliPath, "task", "get", taskId, "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(get.stdout)).toMatchObject({ taskId, state: "blocked" });
      expect(get.stdout).not.toContain(trustedPath);
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
      const missing = await execa("node", [cliPath, "task", "get", `${taskId}-missing`], {
        cwd: root,
        env: environment,
        reject: false,
      });
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.stderr)).toEqual({
        error: "task_not_found",
        taskId: `${taskId}-missing`,
      });

      const snapshot = await execa("node", [cliPath, "server", "snapshot", "--json"], {
        cwd: root,
        env: environment,
      });
      expect(JSON.parse(snapshot.stdout)).toMatchObject({
        schemaVersion: 1,
        tasks: [{ taskId, state: "blocked" }],
      });
      expect(JSON.parse(snapshot.stdout).revision).toBeGreaterThan(highRevision);
      expect(snapshot.stdout).not.toContain(trustedPath);

      const history = await execa(
        "node",
        ["apps/cli/dist/cli.mjs", "task", "history", "--after", "7", taskId, "--json"],
        { cwd: process.cwd(), env: environment },
      );
      expect(
        JSON.parse(history.stdout).events.map((event: { sequence: number }) => event.sequence),
      ).toEqual([8, 9]);

      const watch = await execa(
        "node",
        [cliPath, "task", "watch", "--after", "7", taskId, "--json"],
        { cwd: root, env: environment },
      );
      const watchedEvents = watch.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { sequence: number; data: { type: string } });
      expect(watchedEvents.map((event) => event.sequence)).toEqual([8, 9]);
      expect(watchedEvents[1]?.data).toEqual({ type: "task_terminal", state: "blocked" });
      expect(JSON.parse(watch.stdout)).toMatchObject({ taskId, state: "blocked" });
    } finally {
      await server.close();
    }
  }, 30_000);
});
