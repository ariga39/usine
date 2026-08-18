import { drizzle } from "../packages/runtime/node_modules/drizzle-orm/node-postgres/index.js";
import { eq } from "../packages/runtime/node_modules/drizzle-orm/index.js";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { applyMigrations } from "../packages/runtime/src/apply-migrations.js";
import type { TaskContract } from "../packages/runtime/src/contract.js";
import { repositoryLeases, taskRuns } from "../packages/runtime/src/schema.js";
import { TaskAuthority, type TaskResult } from "../packages/runtime/src/task-authority.js";

const databaseUrl = process.env.USINE_TEST_DATABASE_URL;
const require = createRequire(import.meta.url);
const { Pool } = require("../packages/runtime/node_modules/pg");
const pools: Array<{ end: () => Promise<void> }> = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
});

function makeContract(taskId: string): TaskContract {
  return {
    id: taskId,
    repository: { path: ".", owner: "authority", name: "shared" },
    baseSha: "a".repeat(40),
    instructions: "exercise task authority",
    acceptance: ["authority is correct"],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 3, maxReviewCycles: 2, maxElapsedMs: 30_000 },
    authorization: { source: "authority test", delivery: true },
    delivery: {
      baseBranch: "main",
      branch: `agent/${taskId}`,
      issue: 80,
      title: "authority test",
      body: "authority test",
    },
  };
}

async function makeAuthority() {
  await applyMigrations(databaseUrl!);
  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return {
    authority: new TaskAuthority(drizzle(pool, { schema: { repositoryLeases, taskRuns } })),
    pool,
  };
}

async function terminalResult(
  authority: TaskAuthority,
  admitted: TaskResult,
  state: "reviewed_pr" | "blocked",
): Promise<TaskResult> {
  if (state === "blocked")
    return authority.save({ ...admitted, state, blocker: "blocked by test" });

  const candidateSha = "b".repeat(40);
  const candidate = await authority.save({
    ...admitted,
    state: "candidate",
    candidateSha,
    candidateFence: null,
  });
  const checked = await authority.save({
    ...candidate,
    state: "checked",
    check: {
      sha: candidateSha,
      status: "passed",
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  });
  const reviewed = await authority.save({
    ...checked,
    state: "reviewed",
    review: { sha: candidateSha, verdict: "approved", summary: "approved", findings: [] },
  });
  return authority.save({
    ...reviewed,
    state,
    delivery: {
      sha: candidateSha,
      effect: "github",
      prNumber: 80,
      url: "https://example.invalid/pr/80",
      attestationId: "authority-test",
    },
  });
}

describe("Task Authority PostgreSQL concurrency and terminal leases", () => {
  test.runIf(Boolean(databaseUrl))(
    "rejects every stale activation observation without releasing the newer lease",
    async () => {
      const { authority, pool } = await makeAuthority();
      const taskId = `authority-revision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const contract = makeContract(taskId);
      const repositoryIdentity = `authority/revision-${taskId}`;
      const admitted = await authority.admit({
        contract,
        contractHash: "authority-revision-hash",
        repository: ".",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const first = await authority.reserveActivation(taskId, 3);
      const second = await authority.reserveActivation(taskId, 3);

      await expect(
        authority.save({
          ...first.result,
          candidateSha: null,
          candidateFence: null,
          state: "candidate",
        }),
      ).rejects.toThrow("stale task revision");
      await expect(
        authority.save({
          ...first.result,
          state: "blocked",
          blocker: "stale terminal observation",
        }),
      ).rejects.toThrow("stale task revision");

      const current = await authority.save({
        ...second.result,
        state: "candidate",
        candidateSha: "b".repeat(40),
        candidateFence: second.activation,
        deadlineEpochMs: second.result.deadlineEpochMs + 60_000,
      });
      expect(current.revision).toBeGreaterThan(second.result.revision);
      expect(current.deadlineEpochMs).toBe(admitted.deadlineEpochMs);
      const database = drizzle(pool, { schema: { repositoryLeases, taskRuns } });
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, repositoryIdentity),
      });
      expect(lease).toMatchObject({ taskId, generation: 1 });
      expect(admitted.revision).toBe(0);
    },
    30_000,
  );

  test.runIf(Boolean(databaseUrl))(
    "atomically admits one immutable task and one lease for concurrent same-ID requests",
    async () => {
      const { authority, pool } = await makeAuthority();
      const taskId = `authority-admission-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const contract = makeContract(taskId);
      const input = {
        contract,
        contractHash: "authority-admission-race-hash",
        repository: ".",
        repositoryIdentity: `authority/admission-race-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      };
      const results = await Promise.all([authority.admit(input), authority.admit(input)]);
      expect(results.map((result) => result.taskId)).toEqual([taskId, taskId]);
      expect(results[0]?.deadlineEpochMs).toBe(results[1]?.deadlineEpochMs);

      const changed = makeContract(taskId);
      changed.instructions = "changed contract";
      await expect(
        authority.admit({ ...input, contract: changed, contractHash: "changed-hash" }),
      ).rejects.toThrow("immutable");
      const database = drizzle(pool, { schema: { repositoryLeases, taskRuns } });
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, input.repositoryIdentity),
      });
      const task = await database.query.taskRuns.findFirst({ where: eq(taskRuns.taskId, taskId) });
      expect(lease).toMatchObject({ taskId, generation: 1 });
      expect(task?.contractHash).toBe(input.contractHash);
    },
    30_000,
  );

  test.runIf(Boolean(databaseUrl))(
    "reserves distinct monotonic fences for concurrent physical activations",
    async () => {
      const { authority, pool } = await makeAuthority();
      const taskId = `authority-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const contract = makeContract(taskId);
      await authority.admit({
        contract,
        contractHash: "authority-fence-hash",
        repository: ".",
        repositoryIdentity: `authority/fence-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      });

      const client = await pool.connect();
      let reservations: Awaited<ReturnType<TaskAuthority["reserveActivation"]>>[];
      try {
        await client.query("BEGIN");
        await client.query("SELECT task_id FROM task_runs WHERE task_id = $1 FOR UPDATE", [taskId]);
        const pending = Promise.all([
          authority.reserveActivation(taskId, 3),
          authority.reserveActivation(taskId, 3),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.query("COMMIT");
        reservations = await pending;
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      expect(reservations.map(({ activation }) => activation).toSorted()).toEqual([1, 2]);
      const stored = await drizzle(pool, {
        schema: { repositoryLeases, taskRuns },
      }).query.taskRuns.findFirst({ where: eq(taskRuns.taskId, taskId) });
      if (!stored) throw new Error("reserved task was not persisted");
      expect((stored.result as TaskResult).evidence.implementerActivations).toBe(2);
    },
    30_000,
  );

  test.runIf(Boolean(databaseUrl)).each(["blocked", "reviewed_pr"] as const)(
    "releases the repository lease when a task becomes %s and rejects stale observations",
    async (state) => {
      const { authority } = await makeAuthority();
      const taskId = `authority-terminal-${state}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const contract = makeContract(taskId);
      const repositoryIdentity = `authority/terminal-${taskId}`;
      const admitted = await authority.admit({
        contract,
        contractHash: `authority-terminal-${state}-hash`,
        repository: ".",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const terminal = await terminalResult(authority, admitted, state);
      const nextContract = makeContract(`${taskId}-next`);

      await expect(
        authority.admit({
          contract: nextContract,
          contractHash: `${taskId}-next-hash`,
          repository: ".",
          repositoryIdentity,
          deadlineEpochMs: Date.now() + 30_000,
        }),
      ).resolves.toMatchObject({ taskId: nextContract.id, state: "admitted" });
      await expect(authority.save({ ...terminal, blocker: "stale observation" })).rejects.toThrow(
        "repository writer lease is stale",
      );
    },
    30_000,
  );
});
