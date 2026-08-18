import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { applyMigrations } from "../packages/runtime/src/apply-migrations.js";
import { openSqliteDatabase } from "../packages/runtime/src/sqlite-database.js";
import type { TaskContract } from "../packages/runtime/src/contract.js";
import { TaskAuthority, type TaskResult } from "../packages/runtime/src/task-authority.js";

const handles: Array<{ close: () => void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
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

async function makeDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "usine-authority-"));
  const path = join(directory, "state.sqlite");
  await applyMigrations(path);
  return path;
}

function authorityAt(path: string): TaskAuthority {
  const handle = openSqliteDatabase(path);
  handles.push(handle);
  return new TaskAuthority(handle.database);
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

describe("Task Authority SQLite concurrency and terminal leases", () => {
  test("rejects every stale activation observation without releasing the newer lease", async () => {
    const path = await makeDatabase();
    const firstAuthority = authorityAt(path);
    const secondAuthority = authorityAt(path);
    const taskId = `authority-revision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const repositoryIdentity = `authority/revision-${taskId}`;
    const admitted = await firstAuthority.admit({
      contract,
      contractHash: "authority-revision-hash",
      repository: ".",
      repositoryIdentity,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const first = await firstAuthority.reserveActivation(taskId, 3);
    const second = await secondAuthority.reserveActivation(taskId, 3);

    await expect(
      firstAuthority.save({
        ...first.result,
        candidateSha: null,
        candidateFence: null,
        state: "candidate",
      }),
    ).rejects.toThrow("stale task revision");
    await expect(
      firstAuthority.save({
        ...first.result,
        state: "blocked",
        blocker: "stale terminal observation",
      }),
    ).rejects.toThrow("stale task revision");

    const current = await secondAuthority.save({
      ...second.result,
      state: "candidate",
      candidateSha: "b".repeat(40),
      candidateFence: second.activation,
      deadlineEpochMs: second.result.deadlineEpochMs + 60_000,
    });
    expect(current.revision).toBeGreaterThan(second.result.revision);
    expect(current.deadlineEpochMs).toBe(admitted.deadlineEpochMs);
    await expect(
      firstAuthority.admit({
        contract: makeContract(`${taskId}-other`),
        contractHash: "other-hash",
        repository: ".",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 30_000,
      }),
    ).rejects.toThrow("active writer");
    expect(admitted.revision).toBe(0);
  }, 30_000);

  test("atomically admits one immutable task and one lease for concurrent same-ID requests", async () => {
    const path = await makeDatabase();
    const firstAuthority = authorityAt(path);
    const secondAuthority = authorityAt(path);
    const taskId = `authority-admission-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const input = {
      contract,
      contractHash: "authority-admission-race-hash",
      repository: ".",
      repositoryIdentity: `authority/admission-race-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    };
    const results = await Promise.all([firstAuthority.admit(input), secondAuthority.admit(input)]);
    expect(results.map((result) => result.taskId)).toEqual([taskId, taskId]);
    expect(results[0]?.deadlineEpochMs).toBe(results[1]?.deadlineEpochMs);

    const changed = makeContract(taskId);
    changed.instructions = "changed contract";
    await expect(
      firstAuthority.admit({ ...input, contract: changed, contractHash: "changed-hash" }),
    ).rejects.toThrow("immutable");
    await expect(
      secondAuthority.admit({
        ...input,
        contract: makeContract(`${taskId}-other`),
        contractHash: "other-hash",
        repositoryIdentity: input.repositoryIdentity,
      }),
    ).rejects.toThrow("active writer");
  }, 30_000);

  test("reserves distinct monotonic fences for concurrent physical activations", async () => {
    const path = await makeDatabase();
    const firstAuthority = authorityAt(path);
    const secondAuthority = authorityAt(path);
    const taskId = `authority-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const input = {
      contract,
      contractHash: "authority-fence-hash",
      repository: ".",
      repositoryIdentity: `authority/fence-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    };
    await firstAuthority.admit(input);

    const reservations = await Promise.all([
      firstAuthority.reserveActivation(taskId, 3),
      secondAuthority.reserveActivation(taskId, 3),
    ]);
    expect(reservations.map(({ activation }) => activation).toSorted((a, b) => a - b)).toEqual([
      1, 2,
    ]);
    expect(
      (await firstAuthority.lookupExisting(taskId, input.contractHash))?.evidence,
    ).toMatchObject({
      implementerActivations: 2,
    });
  }, 30_000);

  test.each(["blocked", "reviewed_pr"] as const)(
    "releases the repository lease when a task becomes %s and rejects stale observations",
    async (state) => {
      const path = await makeDatabase();
      const authority = authorityAt(path);
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
