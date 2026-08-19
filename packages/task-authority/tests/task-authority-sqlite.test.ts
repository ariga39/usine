import { mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskResult,
} from "@usine/task-authority";

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
    return authority.block(
      { taskId: admitted.taskId, revision: admitted.revision },
      "blocked by test",
    );

  const candidateSha = "b".repeat(40);
  const reservation = await authority.reserveActivation(admitted.taskId, 3);
  const candidate = await authority.recordCandidate(
    { taskId: admitted.taskId, revision: reservation.result.revision },
    {
      sha: candidateSha,
      baseSha: "a".repeat(40),
      fence: reservation.activation,
    },
  );
  const checked = await authority.recordCheck(
    { taskId: candidate.taskId, revision: candidate.revision },
    {
      sha: candidateSha,
      status: "passed",
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  );
  const reviewed = await authority.recordReview(
    { taskId: checked.taskId, revision: checked.revision },
    { sha: candidateSha, verdict: "approved", summary: "approved", findings: [] },
  );
  return authority.recordDelivery(
    { taskId: reviewed.taskId, revision: reviewed.revision },
    {
      sha: candidateSha,
      effect: "github",
      prNumber: 80,
      url: "https://example.invalid/pr/80",
      attestationId: "authority-test",
    },
  );
}

describe("Task Authority SQLite concurrency and terminal leases", () => {
  test("quarantines unsupported durable state at the lookup boundary", async () => {
    const path = await makeDatabase();
    const taskId = `authority-unsupported-state-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inspection = new DatabaseSync(path);
    inspection
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(taskId, JSON.stringify({ schemaVersion: 99, taskId }));
    inspection.close();

    const authority = authorityAt(path);
    await expect(authority.lookup(taskId)).rejects.toMatchObject({
      code: "task_state_quarantined",
      message: "durable task state quarantined",
    });
  });

  test("quarantines malformed current-version state at the lookup boundary", async () => {
    const path = await makeDatabase();
    const taskId = `authority-malformed-state-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inspection = new DatabaseSync(path);
    inspection
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(taskId, JSON.stringify({ schemaVersion: 1, taskId }));
    inspection.close();

    const authority = authorityAt(path);
    await expect(authority.lookupExisting(taskId, "unused-contract-hash")).rejects.toMatchObject({
      code: "task_state_quarantined",
      message: "durable task state quarantined",
    });
  });

  test("keeps repository paths out of admitted and terminal durable results", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-path-free-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await authority.admit({
      contract: makeContract(taskId),
      contractHash: "authority-path-free-hash",
      repositoryIdentity: `authority/path-free-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });

    expect(admitted.writer).toEqual({ repositoryIdentity: `authority/path-free-${taskId}` });
    expect(await authority.lookup(taskId)).toEqual(admitted);
    const inspection = new DatabaseSync(path);
    const admittedRow = inspection
      .prepare("SELECT result FROM task_runs WHERE task_id = ?")
      .get(taskId) as { result: string };
    expect(JSON.parse(admittedRow.result)).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(admittedRow.result).writer).toEqual(admitted.writer);
    expect(admittedRow.result).not.toContain('"repository"');

    const terminal = await terminalResult(authority, admitted, "blocked");
    expect(terminal.writer).toEqual(admitted.writer);
    expect(JSON.stringify(terminal)).not.toContain('"repository"');
    const terminalRow = inspection
      .prepare("SELECT result FROM task_runs WHERE task_id = ?")
      .get(taskId) as { result: string };
    expect(terminalRow.result).not.toContain('"repository"');
    inspection.close();
  });

  test("persists restart input in the admitted task row", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-restart-input-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rawContract = JSON.stringify({ taskId, frozen: true });
    await authority.admit(
      {
        contract: makeContract(taskId),
        contractHash: "authority-restart-input-hash",
        repositoryIdentity: `authority/restart-input-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      },
      {
        contractPath: "repository/task.json",
        repositoryPath: "repository",
        rawContract,
      },
    );

    const inspection = new DatabaseSync(path);
    const row = inspection
      .prepare(
        "SELECT contract_path, repository_path, raw_contract FROM task_runs WHERE task_id = ?",
      )
      .get(taskId) as {
      contract_path: string;
      repository_path: string;
      raw_contract: string;
    };
    inspection.close();
    expect(row).toEqual({
      contract_path: "repository/task.json",
      repository_path: "repository",
      raw_contract: rawContract,
    });
  });

  test("migrates an admitted V0 lifecycle row into the result-only authority schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-authority-v0-"));
    const path = join(directory, "state.sqlite");
    const v0Migration = await readFile(
      new URL("../drizzle/0000_polite_ken_ellis.sql", import.meta.url),
      "utf8",
    );
    const migrationHash = createHash("sha256").update(v0Migration).digest("hex");
    const deadlineEpochMs = Date.now() + 30_000;
    const oldResult = {
      taskId: "authority-v0-migration",
      contractHash: "authority-v0-hash",
      revision: 2,
      deadlineEpochMs,
      state: "candidate",
      candidateSha: "b".repeat(40),
      candidateFence: 1,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      activeActivation: null,
      writer: {
        repository: ".",
        repositoryIdentity: "authority/v0-migration",
        generation: 1,
      },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 0,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    const client = new DatabaseSync(path);
    client.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash TEXT NOT NULL,
        created_at NUMERIC
      );
      INSERT INTO __drizzle_migrations (hash, created_at)
      VALUES ('${migrationHash}', 1787063395038);
      CREATE TABLE repository_leases (
        repository_identity TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX repository_leases_task_id_unique ON repository_leases (task_id);
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY NOT NULL,
        contract_hash TEXT NOT NULL,
        contract TEXT NOT NULL,
        repository TEXT NOT NULL,
        state TEXT NOT NULL,
        writer_generation INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO task_runs (
        task_id, contract_hash, contract, repository, state, writer_generation,
        deadline_at, result, created_at, updated_at
      ) VALUES (
        'authority-v0-migration', 'authority-v0-hash', '{}', '.', 'candidate', 1,
        ${deadlineEpochMs}, '${JSON.stringify(oldResult)}', ${deadlineEpochMs}, ${deadlineEpochMs}
      );
      INSERT INTO repository_leases (repository_identity, task_id, generation, created_at)
      VALUES ('authority/v0-migration', 'authority-v0-migration', 1, ${deadlineEpochMs});
    `);
    client.close();

    await applyMigrations(path);
    const migrated = authorityAt(path);
    await expect(
      migrated.lookupExisting("authority-v0-migration", "authority-v0-hash"),
    ).resolves.toEqual({
      schemaVersion: 1,
      ...oldResult,
      writer: { repositoryIdentity: "authority/v0-migration" },
    });

    const inspection = new DatabaseSync(path);
    const taskColumns = inspection
      .prepare("PRAGMA table_info(task_runs)")
      .all()
      .map((row) => String(row.name));
    const leaseColumns = inspection
      .prepare("PRAGMA table_info(repository_leases)")
      .all()
      .map((row) => String(row.name));
    inspection.close();
    expect(taskColumns).toEqual([
      "task_id",
      "result",
      "created_at",
      "updated_at",
      "contract_path",
      "repository_path",
      "raw_contract",
    ]);
    expect(leaseColumns).toEqual(["repository_identity", "task_id", "created_at"]);
  });

  test("accepts a candidate fact without accepting a caller-owned durable snapshot", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-candidate-fact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const deadlineEpochMs = Date.now() + 30_000;
    const admitted = await authority.admit({
      contract,
      contractHash: "authority-candidate-fact-hash",
      repositoryIdentity: `authority/candidate-fact-${taskId}`,
      deadlineEpochMs,
    });
    const reservation = await authority.reserveActivation(taskId, 3);

    const candidate = await authority.recordCandidate(
      { taskId, revision: reservation.result.revision },
      {
        sha: "b".repeat(40),
        baseSha: contract.baseSha,
        fence: reservation.activation,
      },
    );

    expect(candidate).toMatchObject({
      state: "candidate",
      deadlineEpochMs: admitted.deadlineEpochMs,
      writer: admitted.writer,
      revision: reservation.result.revision + 1,
      candidateSha: "b".repeat(40),
      candidateFence: reservation.activation,
      evidence: reservation.result.evidence,
    });
    expect(
      (await authority.lookupExisting(taskId, "authority-candidate-fact-hash"))?.deadlineEpochMs,
    ).toBe(deadlineEpochMs);
  });

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
      repositoryIdentity,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const first = await firstAuthority.reserveActivation(taskId, 3);
    const second = await secondAuthority.reserveActivation(taskId, 3);

    await expect(
      firstAuthority.recordCandidate(
        { taskId, revision: first.result.revision },
        {
          sha: "b".repeat(40),
          baseSha: contract.baseSha,
          fence: first.activation,
        },
      ),
    ).rejects.toThrow("stale task revision");
    await expect(
      firstAuthority.block(
        { taskId, revision: first.result.revision },
        "stale terminal observation",
      ),
    ).rejects.toThrow("stale task revision");
    await expect(
      firstAuthority.recordCandidate(
        { taskId, revision: second.result.revision },
        {
          sha: "c".repeat(40),
          baseSha: contract.baseSha,
          fence: first.activation,
        },
      ),
    ).rejects.toThrow("candidate fence is stale");

    const current = await secondAuthority.recordCandidate(
      { taskId, revision: second.result.revision },
      {
        sha: "b".repeat(40),
        baseSha: contract.baseSha,
        fence: second.activation,
      },
    );
    expect(current.revision).toBeGreaterThan(second.result.revision);
    expect(current.deadlineEpochMs).toBe(admitted.deadlineEpochMs);
    await expect(
      firstAuthority.admit({
        contract: makeContract(`${taskId}-other`),
        contractHash: "other-hash",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 30_000,
      }),
    ).rejects.toThrow("active writer");
    expect(admitted.revision).toBe(0);
  }, 30_000);

  test("rejects check, review, and delivery facts from an older candidate SHA", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-stale-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const input = {
      contract,
      contractHash: "authority-stale-evidence-hash",
      repositoryIdentity: `authority/stale-evidence-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    };
    await authority.admit(input);
    const first = await authority.reserveActivation(taskId, 3);
    const candidateOne = await authority.recordCandidate(
      { taskId, revision: first.result.revision },
      {
        sha: "b".repeat(40),
        baseSha: contract.baseSha,
        fence: first.activation,
      },
    );
    const checkedOne = await authority.recordCheck(
      { taskId, revision: candidateOne.revision },
      {
        sha: "b".repeat(40),
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    const second = await authority.reserveActivation(taskId, 3);
    const candidateTwo = await authority.recordCandidate(
      { taskId, revision: second.result.revision },
      {
        sha: "c".repeat(40),
        baseSha: "b".repeat(40),
        fence: second.activation,
      },
    );

    await expect(
      authority.recordCheck(
        { taskId, revision: candidateTwo.revision },
        {
          sha: "b".repeat(40),
          status: "passed",
          command: "true",
          exitCode: 0,
          stdout: "",
          stderr: "",
        },
      ),
    ).rejects.toThrow("stale candidate");

    const checkedTwo = await authority.recordCheck(
      { taskId, revision: candidateTwo.revision },
      {
        sha: "c".repeat(40),
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    await expect(
      authority.recordReview(
        { taskId, revision: checkedTwo.revision },
        { sha: "b".repeat(40), verdict: "approved", summary: "old", findings: [] },
      ),
    ).rejects.toThrow("stale");

    const reviewed = await authority.recordReview(
      { taskId, revision: checkedTwo.revision },
      { sha: "c".repeat(40), verdict: "approved", summary: "approved", findings: [] },
    );
    await expect(
      authority.recordDelivery(
        { taskId, revision: reviewed.revision },
        {
          sha: "b".repeat(40),
          effect: "github",
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "old",
        },
      ),
    ).rejects.toThrow("exact approved candidate");
    expect(checkedOne.review).toBeNull();
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
      repositoryIdentity: `authority/fence-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    };
    await firstAuthority.admit(input);

    const reservations = await Promise.all([
      firstAuthority.reserveActivation(taskId, 3),
      secondAuthority.reserveActivation(taskId, 3),
    ]);
    expect(
      reservations.map(({ activation }) => activation).sort((a: number, b: number) => a - b),
    ).toEqual([1, 2]);
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
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const terminal = await terminalResult(authority, admitted, state);
      const nextContract = makeContract(`${taskId}-next`);

      await expect(
        authority.admit({
          contract: nextContract,
          contractHash: `${taskId}-next-hash`,
          repositoryIdentity,
          deadlineEpochMs: Date.now() + 30_000,
        }),
      ).resolves.toMatchObject({ taskId: nextContract.id, state: "admitted" });
      await expect(
        authority.block({ taskId, revision: terminal.revision }, "stale observation"),
      ).rejects.toThrow("repository writer lease is stale");
    },
    30_000,
  );
});
