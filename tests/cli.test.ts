import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../apps/cli/dist/cli.mjs", import.meta.url));
const fakeCodexPath = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));
const fakeHerdrPath = fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url));

interface FakeHerdrEvent {
  command: string[];
  context?: Record<string, unknown>;
  pane?: string;
  type: string;
}

function herdrOption(event: FakeHerdrEvent, option: string): string | undefined {
  const index = event.command?.indexOf(option) ?? -1;
  return index >= 0 ? event.command?.[index + 1] : undefined;
}

function currentTaskHerdrEvents(events: FakeHerdrEvent[], taskId: string): FakeHerdrEvent[] {
  const splits = events.filter(
    (event) => event.type === "split" && event.command?.some((arg) => arg.includes(taskId)),
  );
  const panes = new Set(
    splits.map((event) => event.pane).filter((pane): pane is string => typeof pane === "string"),
  );
  const startAttempts = events.filter((event) => {
    const pane = herdrOption(event, "--pane");
    return ["start", "busy"].includes(event.type) && pane !== undefined && panes.has(pane);
  });
  const agents = new Set(
    startAttempts
      .map((event) => event.command[2])
      .filter((agent): agent is string => typeof agent === "string"),
  );
  return events.filter((event) => {
    if (event.type === "split") return splits.includes(event);
    if (["start", "busy"].includes(event.type)) return startAttempts.includes(event);
    if (event.type === "close") {
      const pane = event.command[2];
      return pane !== undefined && panes.has(pane);
    }
    if (["get", "prompt", "read"].includes(event.type ?? "")) {
      const agent = event.command[2];
      return agent !== undefined && agents.has(agent);
    }
    return false;
  });
}

async function createFallbackFixture(directory: string, taskId: string, maxElapsedMs = 60_000) {
  const repository = join(directory, "repository");
  const stateDirectory = join(directory, "state");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "fixture\n");
  await execa("git", ["add", "README.md"], { cwd: repository });
  await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
  const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
  const contractPath = join(repository, "task.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      id: taskId,
      repository: { path: repository, owner: "example", name: taskId },
      baseSha,
      instructions: "Create delivered.txt.",
      acceptance: ["The fixture check passes."],
      nonGoals: [],
      projectCheck: { command: "test -f delivered.txt", timeoutMs: 10_000 },
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs },
      authorization: { source: "test issue", delivery: true },
      delivery: {
        baseBranch: "main",
        branch: `agent/${taskId}`,
        issue: 3,
        title: "Fixture",
        body: "Fixture",
      },
    }),
  );
  await execa("git", ["add", "task.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
  return { repository, stateDirectory, contractPath, baseSha };
}

describe("usine run", () => {
  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "does not fall back to direct Codex when the reviewer Herdr launcher is unavailable",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-unavailable-"));
      const taskId = `herdr-unavailable-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: join(directory, "missing-herdr"),
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });
      expect(run.exitCode).toBe(1);
      expect(`${run.stdout}\n${run.stderr}`).toContain("herdr pane split failed");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "does not fall back when a launched Herdr process fails",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-failure-"));
      const taskId = `herdr-failure-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_HERDR_MODE: "fail",
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });
      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({ state: "blocked", candidateSha: null });
      expect(result.blocker).toContain("herdr pane split failed");
      await expect(
        readFile(join(fixture.stateDirectory, "workspaces", taskId, "delivered.txt"), "utf8"),
      ).rejects.toThrow();
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "retries a busy Herdr pane start within the same delivery cycle",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-pane-busy-"));
      const taskId = `herdr-pane-busy-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const herdrLog = join(directory, "herdr.jsonl");
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_HERDR_MODE: "busy-once",
          USINE_HERDR_LOG: herdrLog,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        state: "reviewed_pr",
        review: { verdict: "approved" },
        evidence: { implementerActivations: 1, reviewCycles: 1 },
      });
      expect(result.check.sha).toBe(result.candidateSha);
      expect(result.review.sha).toBe(result.candidateSha);
      expect(result.delivery.sha).toBe(result.candidateSha);

      const events = (await readFile(herdrLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const taskEvents = currentTaskHerdrEvents(events, taskId);
      expect(taskEvents.filter((event) => event.type === "busy")).toHaveLength(1);
      expect(taskEvents.filter((event) => event.type === "start")).toHaveLength(2);
      expect(taskEvents.filter((event) => event.type === "close")).toHaveLength(2);
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "does not retry a non-busy Herdr agent start error",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-start-failure-"));
      const taskId = `herdr-start-failure-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const herdrLog = join(directory, "herdr.jsonl");
      const startedAt = Date.now();
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_HERDR_MODE: "start-fail",
          USINE_HERDR_LOG: herdrLog,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({ state: "blocked", candidateSha: null });
      expect(result.blocker).toContain("herdr agent start failed");
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      const events = (await readFile(herdrLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "close")).toHaveLength(1);
    },
    10_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "finalizes an uncommitted Herdr proposal in the candidate worktree",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-candidate-finalization-"));
      const taskId = `candidate-finalization-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const sourceHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.repository }))
        .stdout;

      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_HERDR_MODE: "propose-without-commit",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        state: "reviewed_pr",
        review: { verdict: "approved" },
      });
      expect(result.candidateSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.candidateSha).not.toBe(sourceHead);
      expect(
        (
          await execa(
            "git",
            ["merge-base", "--is-ancestor", fixture.baseSha, result.candidateSha],
            {
              cwd: fixture.repository,
              reject: false,
            },
          )
        ).exitCode,
      ).toBe(0);
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })).stdout).toBe(
        sourceHead,
      );

      const workspace = join(fixture.stateDirectory, "workspaces", taskId);
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout).toBe(
        result.candidateSha,
      );
      expect((await execa("git", ["status", "--porcelain"], { cwd: workspace })).stdout).toBe("");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "waits for a structured Herdr observation after an early settled prompt",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-observation-"));
      const taskId = `herdr-observation-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const herdrLog = join(directory, "herdr.jsonl");
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_HERDR_MODE: "early-settle",
          USINE_HERDR_LOG: herdrLog,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        state: "reviewed_pr",
        review: { verdict: "approved" },
      });
      const events = (await readFile(herdrLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const taskEvents = currentTaskHerdrEvents(events, taskId);
      expect(taskEvents.filter((event) => event.type === "read")).toHaveLength(4);
      expect(
        taskEvents.filter(
          (event) => event.type === "read" && event.command[2]?.startsWith("usine-impl-"),
        ),
      ).toHaveLength(2);
      expect(
        taskEvents.filter(
          (event) => event.type === "read" && event.command[2]?.startsWith("usine-review-"),
        ),
      ).toHaveLength(2);
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "fails immediately when Herdr reports a blocked agent without an observation",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-herdr-blocked-"));
      const taskId = `herdr-blocked-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId, 5_000);
      const herdrLog = join(directory, "herdr.jsonl");
      const startedAt = Date.now();
      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_HERDR_MODE: "blocked",
          USINE_HERDR_LOG: herdrLog,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        state: "blocked",
        blocker: expect.stringContaining("herdr agent blocked"),
      });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      const events = (await readFile(herdrLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "get")).toHaveLength(1);
      expect(events.filter((event) => event.type === "close")).toHaveLength(1);
    },
    10_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "finalizes a proposal without running repository hooks with coordinator credentials",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-candidate-hooks-"));
      const taskId = `candidate-hooks-${Date.now()}`;
      const fixture = await createFallbackFixture(directory, taskId);
      const hookDirectory = join(fixture.repository, ".hooks");
      const hookMarker = join(directory, "pre-commit-invoked");
      await mkdir(hookDirectory);
      await writeFile(
        join(hookDirectory, "pre-commit"),
        `#!/bin/sh\nprintf '%s:%s\\n' "${process.env.USINE_TEST_DATABASE_URL ?? ""}" "${process.env.USINE_GITHUB_TEST_TOKEN ?? ""}" > "${hookMarker}"\nexit 97\n`,
      );
      await chmod(join(hookDirectory, "pre-commit"), 0o755);
      await execa("git", ["config", "core.hooksPath", hookDirectory], {
        cwd: fixture.repository,
      });

      const run = await execa("node", [cliPath, "run", fixture.contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodexPath,
          USINE_HERDR_BIN: fakeHerdrPath,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_HERDR_MODE: "propose-without-commit",
          USINE_STATE_DIR: fixture.stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        state: "reviewed_pr",
        review: { verdict: "approved" },
      });
      await expect(readFile(hookMarker, "utf8")).rejects.toThrow();
    },
    30_000,
  );

  test("rejects a contract before starting work when required authority is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-contract-"));
    const contractPath = join(directory, "task.json");
    await writeFile(contractPath, JSON.stringify({ id: "../task-without-authority" }));

    const result = await execa("node", [cliPath, "run", contractPath], {
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "invalid_task_contract",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "id" }),
        expect.objectContaining({ path: "authorization" }),
        expect.objectContaining({ path: "baseSha" }),
      ]),
    });
    await expect(readFile(join(directory, "result.json"), "utf8")).rejects.toThrow();
  });

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "admits one committed contract durably without duplicating its writer",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-admission-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `admission-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Add the requested fixture behavior.",
          acceptance: ["The fixture check passes."],
          nonGoals: [],
          projectCheck: { command: "node --check README.md", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture delivery",
            body: "Fixture delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

      const env = {
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_STATE_DIR: stateDirectory,
        USINE_STOP_AFTER: "admitted",
      };
      const first = await execa("node", [cliPath, "run", contractPath], {
        cwd: directory,
        env,
        reject: false,
      });
      const second = await execa("node", [cliPath, "run", contractPath], {
        cwd: directory,
        env,
        reject: false,
      });

      expect(first.exitCode).toBe(75);
      expect(second.exitCode).toBe(75);
      const firstResult = JSON.parse(first.stdout);
      const secondResult = JSON.parse(second.stdout);
      const canonicalRepository = await realpath(repository);
      expect(firstResult).toMatchObject({
        taskId,
        state: "admitted",
        writer: { generation: 1, repository: canonicalRepository },
      });
      expect(secondResult).toEqual(firstResult);
      expect(
        JSON.parse(await readFile(join(stateDirectory, "results", `${taskId}.json`), "utf8")),
      ).toEqual(firstResult);
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "freezes admitted input and leases one normalized repository identity across clone paths",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-frozen-"));
      const repository = join(directory, "repository");
      const secondRepository = join(directory, "second-clone");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `frozen-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      const contract = {
        id: taskId,
        repository: { path: repository, owner: "Example", name: taskId },
        baseSha,
        instructions: "Original frozen instructions.",
        acceptance: ["The task remains frozen."],
        nonGoals: [],
        projectCheck: { command: "true", timeoutMs: 10_000 },
        budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 60_000 },
        authorization: { source: "test issue", delivery: true },
        delivery: {
          baseBranch: "main",
          branch: `agent/${taskId}`,
          issue: 3,
          title: "Frozen task",
          body: "Frozen task body",
        },
      };
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const env = {
        USINE_CRASH_AFTER: "admitted",
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_STATE_DIR: stateDirectory,
      };

      const interrupted = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });
      expect(interrupted.signal).toBe("SIGKILL");

      contract.instructions = "Mutated instructions must not resume.";
      await writeFile(contractPath, JSON.stringify(contract));
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "mutate admitted task"], { cwd: repository });
      const mutated = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });
      expect(mutated.exitCode).toBe(1);
      expect(mutated.stderr).toContain("admitted contract is immutable");

      await execa("git", ["clone", repository, secondRepository]);
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: secondRepository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], {
        cwd: secondRepository,
      });
      const secondId = `${taskId}-second`;
      const secondContractPath = join(secondRepository, "task.json");
      await writeFile(
        secondContractPath,
        JSON.stringify({
          ...contract,
          id: secondId,
          instructions: "A second clone must not receive a writer.",
          repository: { ...contract.repository, path: secondRepository },
          delivery: { ...contract.delivery, branch: `agent/${secondId}` },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: secondRepository });
      await execa("git", ["commit", "-m", "authorize competing task"], { cwd: secondRepository });
      const competing = await execa("node", [cliPath, "run", secondContractPath], {
        env: { ...env, USINE_CRASH_AFTER: undefined },
        reject: false,
      });
      expect(competing.exitCode).toBe(1);
      expect(competing.stderr).toContain("repository already has an active writer");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "recovers one early-stopping implementer and delivers its approved candidate",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-delivery-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      const herdrLog = join(directory, "herdr.jsonl");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; if (process.env.USINE_DATABASE_URL || process.env.USINE_TEST_SECRET) throw new Error("secret leaked to project check"); await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `delivery-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Stop once, then create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture delivery",
            body: "Fixture delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const authorizationSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository }))
        .stdout;
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));

      const run = await execa("node", [cliPath, "run", contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodex,
          USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
          USINE_HERDR_LOG: herdrLog,
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: "/tmp/herdr.sock",
          HERDR_WORKSPACE_ID: "w-test",
          HERDR_TAB_ID: "w-test:t1",
          HERDR_PANE_ID: "w-test:p1",
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: stateDirectory,
          USINE_TEST_SECRET: "must-not-leak",
        },
        reject: false,
      });

      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        taskId,
        state: "reviewed_pr",
        check: { status: "passed" },
        review: { verdict: "approved" },
        delivery: { effect: "recorded" },
        evidence: { implementerActivations: 2 },
      });
      expect(result.candidateSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.check.sha).toBe(result.candidateSha);
      expect(result.review.sha).toBe(result.candidateSha);
      expect(result.delivery.sha).toBe(result.candidateSha);
      expect((await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).toBe(
        authorizationSha,
      );
      expect(
        (await execa("git", ["show", `${result.candidateSha}:delivered.txt`], { cwd: repository }))
          .stdout,
      ).toBe("implemented");
      const herdrEvents = currentTaskHerdrEvents(
        (await readFile(herdrLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        taskId,
      );
      expect(herdrEvents.filter((event) => event.type === "split")).toHaveLength(3);
      expect(herdrEvents.filter((event) => event.type === "close")).toHaveLength(3);
      const starts = herdrEvents.filter((event) => event.type === "start");
      expect(starts).toHaveLength(3);
      expect(starts[0]?.command).toEqual(expect.arrayContaining(["-p", "usine-implementer"]));
      expect(starts[0]?.command[2]).not.toBe(starts[1]?.command[2]);
      const reviewerStart = starts.find((event) => event.command.includes("gpt-5.6-sol"));
      expect(reviewerStart?.command).toEqual(
        expect.arrayContaining([
          "--model",
          "gpt-5.6-sol",
          "--sandbox",
          "read-only",
          "--config",
          "model_reasoning_effort=low",
          "service_tier=default",
        ]),
      );
      expect(herdrEvents.filter((event) => event.type === "prompt")).toHaveLength(3);
      expect(herdrEvents.some((event) => event.type === "wait")).toBe(false);
      const splits = herdrEvents.filter((event) => event.type === "split");
      const closes = herdrEvents.filter((event) => event.type === "close");
      expect(splits[0]?.command).toContain("--current");
      expect(splits[0]?.context).toMatchObject({
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_WORKSPACE_ID: "w-test",
        HERDR_TAB_ID: "w-test:t1",
        HERDR_PANE_ID: "w-test:p1",
        USINE_CODEX_BIN: fakeCodex,
        USINE_HERDR_LOG: herdrLog,
      });
      expect(new Set(splits.map((event) => event.pane)).size).toBe(3);
      expect(closes.map((event) => event.command[2]).toSorted()).toEqual(
        splits.map((event) => event.pane).toSorted(),
      );
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "bounds a hung implementer by one durable end-to-end deadline",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-budget-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      const herdrLog = join(directory, "herdr.jsonl");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `budget-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Hang forever.",
          acceptance: ["The coordinator stops within budget."],
          nonGoals: [],
          projectCheck: { command: "true", timeoutMs: 10_000 },
          budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_500 },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Budget task",
            body: "Budget task body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const startedAt = Date.now();
      const run = await execa("node", [cliPath, "run", contractPath], {
        env: {
          USINE_CODEX_BIN: fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url)),
          USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
          USINE_HERDR_LOG: herdrLog,
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: stateDirectory,
        },
        reject: false,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({ state: "blocked" });
      expect(result.blocker).toContain("elapsed budget exhausted");
      expect(elapsedMs).toBeLessThan(5_000);
      const herdrEvents = (await readFile(herdrLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const taskSplits = herdrEvents.filter(
        (event) =>
          event.type === "split" &&
          event.command.some((argument: string) => argument.includes(taskId)),
      );
      expect(taskSplits).toHaveLength(1);
      const taskPane = taskSplits[0].pane;
      expect(
        herdrEvents.filter((event) => event.type === "close" && event.command.includes(taskPane)),
      ).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(stateDirectory, "results", `${taskId}.json`), "utf8")),
      ).toEqual(result);
    },
    10_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "replays the activation checkpoint in order and persists an expired-budget blocker",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-budget-replay-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `budget-replay-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["Expired recovery is durably blocked."],
          nonGoals: [],
          projectCheck: { command: "true", timeoutMs: 10_000 },
          budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Replay budget task",
            body: "Replay budget task body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const env = {
        USINE_CODEX_BIN: fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url)),
        USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
        USINE_CRASH_AFTER: "activation",
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_DELIVERY_MODE: "record",
        USINE_STATE_DIR: stateDirectory,
      };
      const interrupted = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });
      expect(interrupted.signal).toBe("SIGKILL");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));

      const recovered = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });
      expect(recovered.exitCode).toBe(0);
      const result = JSON.parse(recovered.stdout);
      expect(result).toMatchObject({
        state: "blocked",
        evidence: { implementerActivations: 1 },
      });
      expect(result.blocker).toContain("elapsed budget exhausted");
      expect(
        JSON.parse(await readFile(join(stateDirectory, "results", `${taskId}.json`), "utf8")),
      ).toEqual(result);
    },
    10_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "aggregates requested changes into one fix activation and invalidates stale evidence",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-fix-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await writeFile(
        join(repository, "AGENTS.md"),
        "Fixture target rule: preserve review evidence.\n",
      );
      await execa("git", ["add", "check.mjs", "AGENTS.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `fix-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt, address review findings, and respect target rules.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture fix delivery",
            body: "Fixture fix delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));

      const run = await execa("node", [cliPath, "run", contractPath], {
        env: {
          USINE_CODEX_BIN: fakeCodex,
          USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
          USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
          USINE_DELIVERY_MODE: "record",
          USINE_STATE_DIR: stateDirectory,
        },
        reject: false,
      });

      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result).toMatchObject({
        state: "reviewed_pr",
        evidence: {
          changesRequestedBatches: 1,
          implementerActivations: 2,
          reviewCycles: 2,
        },
      });
      expect(result.check.sha).toBe(result.candidateSha);
      expect(result.review).toMatchObject({ sha: result.candidateSha, verdict: "approved" });
      expect(result.delivery.sha).toBe(result.candidateSha);
      expect(
        (await execa("git", ["show", `${result.candidateSha}:delivered.txt`], { cwd: repository }))
          .stdout,
      ).toContain("review-fixed");
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "recovers after a coordinator crash without duplicating writer or delivery",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-restart-"));
      const repository = join(directory, "repository");
      const stateDirectory = join(directory, "state");
      const deliveryCounter = join(directory, "delivery.json");
      await mkdir(repository);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `restart-${Date.now()}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch: `agent/${taskId}`,
            issue: 3,
            title: "Fixture restart delivery",
            body: "Fixture restart delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));
      const env = {
        USINE_CODEX_BIN: fakeCodex,
        USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
        USINE_CRASH_AFTER: "delivery",
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_DELIVERY_MODE: "record",
        USINE_RECORD_DELIVERY_COUNTER: deliveryCounter,
        USINE_STATE_DIR: stateDirectory,
      };

      const interrupted = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });
      const recovered = await execa("node", [cliPath, "run", contractPath], {
        env,
        reject: false,
      });

      expect(interrupted.signal).toBe("SIGKILL");
      expect(recovered.exitCode).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        state: "reviewed_pr",
        writer: { generation: 1 },
        evidence: { restartRecoveries: 1 },
      });
      expect(JSON.parse(await readFile(deliveryCounter, "utf8"))).toMatchObject({
        count: 1,
      });
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "recovers ambiguous PR and attestation responses without duplicate effects",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-github-"));
      const repository = join(directory, "repository");
      const bareRemote = join(directory, "remote.git");
      const stateDirectory = join(directory, "state");
      await mkdir(repository);
      await execa("git", ["init", "--bare", bareRemote]);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(
        join(repository, "check.mjs"),
        'import { access } from "node:fs/promises"; await access("delivered.txt");\n',
      );
      await execa("git", ["add", "check.mjs"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `github-${Date.now()}`;
      const branch = `agent/${taskId}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["node check.mjs passes."],
          nonGoals: [],
          projectCheck: { command: "node check.mjs", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch,
            issue: 3,
            title: "Fixture GitHub delivery",
            body: "Fixture GitHub delivery body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });

      let prCreates = 0;
      let attestationCreates = 0;
      let prExists = false;
      let remoteSha: string | null = null;
      let failureStage: "pr" | "attestation" | null = "pr";
      const comments: Array<{
        id: number;
        body: string;
        html_url: string;
        performed_via_github_app: { slug: string };
        user: { type: string };
      }> = [];
      const api = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (request.method === "GET" && url.pathname.includes("/git/ref/heads/")) {
          send(
            remoteSha ? 200 : 404,
            remoteSha ? { object: { sha: remoteSha } } : { message: "Not Found" },
          );
        } else if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
          send(
            200,
            prExists
              ? [
                  {
                    number: 7,
                    html_url: "http://fixture/pr/7",
                    state: "open",
                    head: { sha: remoteSha },
                  },
                ]
              : [],
          );
        } else if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
          prCreates += 1;
          prExists = true;
          remoteSha = (
            await execa("git", ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`])
          ).stdout;
          if (failureStage === "pr") {
            failureStage = "attestation";
            response.destroy();
            return;
          }
          send(201, {
            number: 7,
            html_url: "http://fixture/pr/7",
            head: { sha: remoteSha },
          });
        } else if (request.method === "GET" && url.pathname.endsWith("/issues/7/comments")) {
          const foreign = remoteSha
            ? [
                {
                  id: 54,
                  body: `<!-- usine-approval:${taskId}:${remoteSha} -->\nforeign body`,
                  html_url: "http://fixture/pr/7#comment-54",
                  performed_via_github_app: { slug: "foreign-app" },
                  user: { type: "Bot" },
                },
              ]
            : [];
          send(200, [...foreign, ...comments]);
        } else if (request.method === "POST" && url.pathname.endsWith("/issues/7/comments")) {
          let body = "";
          request.on("data", (chunk) => (body += String(chunk)));
          request.on("end", () => {
            attestationCreates += 1;
            const parsed = JSON.parse(body) as { body: string };
            const comment = {
              id: 99,
              body: parsed.body,
              html_url: "http://fixture/pr/7#comment-99",
              performed_via_github_app: { slug: "usine-test-app" },
              user: { type: "Bot" },
            };
            comments.push(comment);
            if (failureStage === "attestation") {
              failureStage = null;
              response.destroy();
              return;
            }
            send(201, comment);
          });
        } else {
          send(404, { message: `Unhandled ${request.method} ${url.pathname}` });
        }
      });
      await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
      const address = api.address();
      if (!address || typeof address === "string")
        throw new Error("fake GitHub API did not listen");
      const fakeCodex = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));
      const env = {
        USINE_CODEX_BIN: fakeCodex,
        USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
        USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
        USINE_DELIVERY_MODE: "github",
        USINE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        USINE_GITHUB_GIT_URL: bareRemote,
        USINE_GITHUB_APP_SLUG: "usine-test-app",
        USINE_GITHUB_TEST_TOKEN: "test-token",
        USINE_STATE_DIR: stateDirectory,
      };
      try {
        const run = await execa("node", [cliPath, "run", contractPath], {
          env,
          reject: false,
        });

        expect(run.exitCode).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result).toMatchObject({
          state: "reviewed_pr",
          delivery: {
            effect: "github",
            prNumber: 7,
            url: "http://fixture/pr/7",
            attestationId: "99",
          },
        });
        expect(
          (await execa("git", ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`]))
            .stdout,
        ).toBe(result.candidateSha);
        expect(prCreates).toBe(1);
        expect(attestationCreates).toBe(1);
        expect(comments[0]?.body).toContain(result.candidateSha);
      } finally {
        await new Promise<void>((resolveClose, rejectClose) =>
          api.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      }
    },
    30_000,
  );

  test.runIf(process.env.USINE_TEST_DATABASE_URL)(
    "quarantines a closed matching PR instead of creating another",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-pr-conflict-"));
      const repository = join(directory, "repository");
      const bareRemote = join(directory, "remote.git");
      await mkdir(repository);
      await execa("git", ["init", "--bare", bareRemote]);
      await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
      await execa("git", ["config", "user.name", "Usine Test"], { cwd: repository });
      await execa("git", ["config", "user.email", "usine@example.invalid"], { cwd: repository });
      await writeFile(join(repository, "README.md"), "fixture\n");
      await execa("git", ["add", "README.md"], { cwd: repository });
      await execa("git", ["commit", "-m", "fixture base"], { cwd: repository });
      const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout;
      const taskId = `pr-conflict-${Date.now()}`;
      const branch = `agent/${taskId}`;
      const contractPath = join(repository, "task.json");
      await writeFile(
        contractPath,
        JSON.stringify({
          id: taskId,
          repository: { path: repository, owner: "example", name: taskId },
          baseSha,
          instructions: "Create delivered.txt.",
          acceptance: ["The task is committed."],
          nonGoals: [],
          projectCheck: { command: "true", timeoutMs: 10_000 },
          budget: {
            maxImplementerActivations: 2,
            maxReviewCycles: 2,
            maxElapsedMs: 60_000,
          },
          authorization: { source: "test issue", delivery: true },
          delivery: {
            baseBranch: "main",
            branch,
            issue: 3,
            title: "Conflicting PR",
            body: "Conflicting PR body",
          },
        }),
      );
      await execa("git", ["add", "task.json"], { cwd: repository });
      await execa("git", ["commit", "-m", "authorize task"], { cwd: repository });
      let prCreates = 0;
      const api = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (request.method === "GET" && url.pathname.includes("/git/ref/heads/")) {
          send(404, { message: "Not Found" });
        } else if (request.method === "GET" && url.pathname.endsWith("/pulls")) {
          const candidate = (
            await execa("git", ["--git-dir", bareRemote, "rev-parse", `refs/heads/${branch}`])
          ).stdout;
          send(200, [
            {
              number: 6,
              html_url: "http://fixture/pr/6",
              state: "closed",
              merged_at: null,
              head: { sha: candidate },
            },
            {
              number: 5,
              html_url: "http://fixture/pr/5",
              state: "open",
              head: { sha: "f".repeat(40) },
            },
          ]);
        } else if (request.method === "POST" && url.pathname.endsWith("/pulls")) {
          prCreates += 1;
          send(201, { number: 7, html_url: "http://fixture/pr/7" });
        } else {
          send(404, { message: `Unhandled ${request.method} ${url.pathname}` });
        }
      });
      await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
      const address = api.address();
      if (!address || typeof address === "string") throw new Error("fake API did not listen");
      try {
        const result = await execa("node", [cliPath, "run", contractPath], {
          env: {
            USINE_CODEX_BIN: fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url)),
            USINE_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)),
            USINE_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
            USINE_DELIVERY_MODE: "github",
            USINE_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
            USINE_GITHUB_GIT_URL: bareRemote,
            USINE_GITHUB_APP_SLUG: "usine-test-app",
            USINE_GITHUB_TEST_TOKEN: "test-token",
            USINE_STATE_DIR: join(directory, "state"),
          },
          reject: false,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("closed delivery PR");
        expect(prCreates).toBe(0);
      } finally {
        await new Promise<void>((resolveClose, rejectClose) =>
          api.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      }
    },
    30_000,
  );
});
