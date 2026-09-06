import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  encodeTaskIdCursor,
  openSqliteDatabase,
  RepositoryWriterConflictError,
  taskResourceFromResult,
  TaskAuthority,
  type TaskContract,
  type TaskResult,
} from "@usine/task-authority";

const handles: Array<{ close: () => void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

function makeContract(taskId: string, merge = false): TaskContract {
  return {
    id: taskId,
    repositoryId: "authority-repository",
    baseSha: "a".repeat(40),
    instructions: "exercise task authority",
    acceptance: ["authority is correct"],
    nonGoals: [],
    budget: { maxImplementerActivations: 3, maxReviewCycles: 2, maxElapsedMs: 30_000 },
    authorization: { source: "authority test", delivery: true, ...(merge ? { merge: true } : {}) },
    delivery: {
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

async function makeDatabaseBeforeMigration(migrationCount: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "usine-authority-upgrade-"));
  const path = join(directory, "state.sqlite");
  const sourceDirectory = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const migrationsDirectory = join(directory, "migrations");
  await mkdir(join(migrationsDirectory, "meta"), { recursive: true });
  for (const name of (await readdir(sourceDirectory)).filter((entry) => entry.endsWith(".sql")))
    await copyFile(join(sourceDirectory, name), join(migrationsDirectory, name));
  const journal = JSON.parse(
    await readFile(join(sourceDirectory, "meta/_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  await writeFile(
    join(migrationsDirectory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, migrationCount) }),
  );

  const prior = openSqliteDatabase(path);
  try {
    await prior.exclusiveTransaction(() =>
      migrate(prior.database, prior.migrate, { migrationsFolder: migrationsDirectory }),
    );
  } finally {
    prior.close();
  }

  return path;
}

async function makePreTaskEventsDatabase(): Promise<string> {
  const path = await makeDatabaseBeforeMigration(10);
  const legacy = new DatabaseSync(path);
  const deadline = Date.now() + 30_000;
  const taskRuns = legacy.prepare(
    "INSERT INTO task_runs (task_id, result, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const taskId of ["legacy-with-history", "legacy-without-history"])
    taskRuns.run(taskId, "{}", deadline, deadline);
  const history = legacy.prepare(
    "INSERT INTO task_history (task_id, kind, started_at_epoch_ms, outcome) VALUES (?, ?, ?, ?)",
  );
  history.run("legacy-with-history", "implementer", 100, "succeeded");
  history.run("legacy-with-history", "project_check", 200, "failed");
  legacy.close();

  await applyMigrations(path);
  return path;
}

async function makePreBlockerClassificationDatabase(): Promise<string> {
  const path = await makeDatabaseBeforeMigration(13);
  const initialHandle = openSqliteDatabase(path);
  const admitted = await new TaskAuthority(initialHandle.database).admit({
    contract: makeContract("legacy-blocked-with-event"),
    contractHash: "d".repeat(64),
    repositoryIdentity: "authority/legacy-blocked-with-event",
    deadlineEpochMs: Date.now() + 30_000,
  });
  initialHandle.close();

  const diagnostic = "check failure: exact legacy private diagnostic";
  const legacyResult = {
    ...admitted,
    schemaVersion: 3,
    state: "blocked",
    blocker: diagnostic,
  } as Record<string, unknown>;
  delete legacyResult.blockerClassification;

  const legacy = new DatabaseSync(path);
  legacy
    .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
    .run(JSON.stringify(legacyResult), admitted.taskId);
  legacy
    .prepare(
      "INSERT INTO task_events (task_id, sequence, event_id, occurred_at_epoch_ms, data) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      admitted.taskId,
      2,
      "blocked:legacy",
      Date.now(),
      JSON.stringify({ type: "task_blocked", reason: "unknown" }),
    );
  legacy.close();
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
  const reviewAttempt = await authority.reserveReviewAttempt(
    checked.taskId,
    3,
    "authority-fixture-reviewer",
  );
  const reviewed = await authority.recordReview(
    { taskId: checked.taskId, revision: reviewAttempt.result.revision },
    { sha: candidateSha, verdict: "approved", summary: "approved", findings: [] },
    "authority-fixture-reviewer",
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
  test("lists every admitted Task through a stable bounded Task-ID cursor", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const contractFor = (taskId: string): TaskContract => ({
      ...makeContract(taskId),
      repositoryId: `repository-${taskId}`,
    });

    for (let index = 0; index < 205; index += 1) {
      const taskId = `paged-task-${String(index).padStart(3, "0")}`;
      await authority.admit({
        contract: contractFor(taskId),
        contractHash: "a".repeat(64),
        repositoryIdentity: `example/${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      });
    }

    const first = await authority.listTaskPage({ cursor: null, limit: 200 });
    expect(first.tasks.map((task) => task.taskId)).toEqual(
      Array.from({ length: 200 }, (_, index) => `paged-task-${String(index).padStart(3, "0")}`),
    );
    expect(first.cursor).toBeNull();
    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === undefined || first.nextCursor === null)
      throw new Error("first Task page did not provide a continuation cursor");

    await authority.admit({
      contract: contractFor("paged-task-999"),
      contractHash: "a".repeat(64),
      repositoryIdentity: "example/paged-task-999",
      deadlineEpochMs: Date.now() + 30_000,
    });
    const second = await authority.listTaskPage({ cursor: first.nextCursor, limit: 200 });
    expect(second.tasks.map((task) => task.taskId)).toEqual([
      "paged-task-200",
      "paged-task-201",
      "paged-task-202",
      "paged-task-203",
      "paged-task-204",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.taskId)).size).toBe(205);
  });

  test("rejects invalid and stale Task list cursors", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = "paged-cursor-task";
    await authority.admit({
      contract: makeContract(taskId),
      contractHash: "a".repeat(64),
      repositoryIdentity: `example/${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });

    await expect(
      authority.listTaskPage({ cursor: "not-a-cursor", limit: 1 }),
    ).rejects.toMatchObject({ code: "task_list_cursor_invalid" });
    const staleCursor = encodeTaskIdCursor({
      version: 1,
      scope: "task-list",
      upperTaskId: "missing-upper",
      afterTaskId: taskId,
    });
    await expect(authority.listTaskPage({ cursor: staleCursor, limit: 1 })).rejects.toMatchObject({
      code: "task_list_cursor_invalid",
    });
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        scope: "other-resource",
        upperTaskId: taskId,
        afterTaskId: taskId,
      }),
      "utf8",
    ).toString("base64url");
    await expect(authority.listTaskPage({ cursor, limit: 1 })).rejects.toMatchObject({
      code: "task_list_cursor_invalid",
    });
  });

  test("rejects Repository capability-policy changes while its writer lease is active", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const registration = {
      id: "profile-switch-repository",
      path: "/repositories/profile-switch",
      owner: "example",
      name: "profile-switch",
      baseBranch: "main",
      implementerProfile: "baseline-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "forge-profile",
      githubReadProfile: "read-profile",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    };
    await authority.registerRepository(registration);
    await authority.admit({
      contract: { ...makeContract("profile-switch-task"), repositoryId: registration.id },
      contractHash: "profile-switch-hash",
      repositoryIdentity: "example/profile-switch",
      repository: registration,
      deadlineEpochMs: Date.now() + 30_000,
    });

    for (const changed of [
      { owner: "other-owner" },
      { name: "other-name" },
      { implementerProfile: "candidate-profile" },
      { reviewerProfile: "other-reviewer" },
      { forgeProfile: "other-forge" },
      { githubReadProfile: "other-read" },
    ]) {
      await expect(authority.registerRepository({ ...registration, ...changed })).rejects.toThrow(
        "cannot change repository capability policy while a Task is active",
      );
    }
  });

  test("normalizes omitted and null GitHub read profiles during an active lease", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const registration = {
      id: "read-profile-normalization",
      path: "/repositories/read-profile-normalization",
      owner: "example",
      name: "read-profile-normalization",
      baseBranch: "main",
      implementerProfile: "baseline-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "forge-profile",
      githubReadProfile: null,
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    };
    await expect(authority.registerRepository(registration)).resolves.toMatchObject({
      githubReadProfile: null,
    });
    const admitted = await authority.admit({
      contract: {
        ...makeContract("read-profile-normalization-task"),
        repositoryId: registration.id,
      },
      contractHash: "read-profile-normalization-hash",
      repositoryIdentity: "example/read-profile-normalization",
      repository: { ...registration, githubReadProfile: null },
      deadlineEpochMs: Date.now() + 30_000,
    });

    await expect(
      authority.registerRepository({ ...registration, githubReadProfile: null }),
    ).resolves.toMatchObject({ githubReadProfile: null });
    await expect(
      authority.registerRepository({ ...registration, githubReadProfile: undefined }),
    ).resolves.toMatchObject({ githubReadProfile: null });
    expect(admitted.repository).not.toHaveProperty("githubReadProfile");
  });

  test("allows unrelated updates while active and capability-policy changes after lease release", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const registration = {
      id: "profile-switch-release",
      path: "/repositories/profile-switch-release",
      owner: "example",
      name: "profile-switch-release",
      baseBranch: "main",
      implementerProfile: "baseline-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "forge-profile",
      githubReadProfile: "read-profile",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    };
    await authority.registerRepository(registration);
    const admitted = await authority.admit({
      contract: { ...makeContract("profile-switch-release-task"), repositoryId: registration.id },
      contractHash: "profile-switch-release-hash",
      repositoryIdentity: "example/profile-switch-release",
      repository: registration,
      deadlineEpochMs: Date.now() + 30_000,
    });

    await expect(
      authority.registerRepository({
        ...registration,
        projectCheck: { command: "false", timeoutMs: 2_000 },
      }),
    ).resolves.toMatchObject({ projectCheck: { command: "false", timeoutMs: 2_000 } });

    const blocked = await authority.block(
      { taskId: admitted.taskId, revision: admitted.revision },
      "release test",
    );
    expect(blocked.state).toBe("blocked");
    await expect(
      authority.registerRepository({
        ...registration,
        owner: "other-owner",
        name: "other-name",
        implementerProfile: "candidate-profile",
        reviewerProfile: "other-reviewer",
        forgeProfile: "other-forge",
        githubReadProfile: "other-read",
      }),
    ).resolves.toMatchObject({
      implementerProfile: "candidate-profile",
      reviewerProfile: "other-reviewer",
      forgeProfile: "other-forge",
      githubReadProfile: "other-read",
      owner: "other-owner",
      name: "other-name",
    });
  });

  test("accepts one explicit retry while retaining the lease and active slot", async () => {
    const path = await makeDatabase();
    const first = authorityAt(path);
    const second = authorityAt(path);
    const taskId = `authority-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await first.admit({
      contract: makeContract(taskId),
      contractHash: "authority-retry-hash",
      repositoryIdentity: `authority/retry-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const reservation = await first.reserveActivation(taskId, 3);
    const waiting = await first.recordWaiting(
      { taskId, revision: reservation.result.revision },
      {
        reason: "network_interruption",
        resumeState: "admitted",
        activation: reservation.activation,
      },
    );
    expect(waiting.state).toBe("waiting");
    expect((await first.listRestartable()).activeTaskCount).toBe(1);

    const retries = await Promise.allSettled([
      first.retryTask(taskId, 3),
      second.retryTask(taskId, 3),
    ]);
    expect(retries.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(retries.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const rejected = retries.find((entry) => entry.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "task_retry_conflict", retryable: false } });

    const resumed = await first.lookup(taskId);
    expect(resumed).toMatchObject({
      state: "admitted",
      waiting: null,
      evidence: { implementerActivations: 1 },
    });
    const restart = await first.listRestartable();
    expect(restart.activeTaskCount).toBe(1);
    expect(restart.restartable).toHaveLength(0);
    expect(admitted.writer.repositoryIdentity).toBe(resumed?.writer.repositoryIdentity);
  });

  test("retries delivery reconciliation even when the implementer budget is exhausted", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-delivery-retry-${Date.now()}`;
    const contract = makeContract(taskId);
    const admitted = await authority.admit(
      {
        contract,
        contractHash: "a".repeat(64),
        repositoryIdentity: `authority/delivery-retry-${taskId}`,
        repository: {
          id: contract.repositoryId,
          path: ".",
          owner: "authority",
          name: "delivery-retry",
          baseBranch: "main",
          implementerProfile: "implementer",
          reviewerProfile: "reviewer",
          forgeProfile: "forge",
          githubReadProfile: null,
          projectCheck: { command: "true", timeoutMs: 1_000 },
          gitAuthor: { name: "Test", email: "test@example.invalid" },
        },
        deadlineEpochMs: Date.now() + 30_000,
      },
      {
        contractPath: "task.json",
        rawContract: JSON.stringify(contract),
      },
    );
    const reservation = await authority.reserveActivation(taskId, 3);
    const candidate = await authority.recordCandidate(
      { taskId, revision: reservation.result.revision },
      { sha: "b".repeat(40), baseSha: "a".repeat(40), fence: reservation.activation },
    );
    await authority.recordCheck(
      { taskId, revision: candidate.revision },
      {
        sha: candidate.candidateSha!,
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    const reviewAttempt = await authority.reserveReviewAttempt(
      taskId,
      3,
      "authority-fixture-reviewer",
    );
    const reviewed = await authority.recordReview(
      { taskId, revision: reviewAttempt.result.revision },
      { sha: candidate.candidateSha!, verdict: "approved", summary: "approved", findings: [] },
      "authority-fixture-reviewer",
    );
    const waiting = await authority.recordWaiting(
      { taskId, revision: reviewed.revision },
      {
        reason: "delivery_reconciliation",
        resumeState: "reviewed",
        activation: reservation.activation,
      },
    );

    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed" },
    });
    expect((await authority.listRestartable()).restartable).toHaveLength(0);

    const resumed = await authority.retryTask(taskId, 1);
    expect(resumed).toMatchObject({
      state: "reviewed",
      waiting: null,
      candidateSha: candidate.candidateSha,
      check: { status: "passed" },
      review: { verdict: "approved" },
      evidence: { implementerActivations: 1 },
    });
    expect((await authority.listRestartable()).restartable).toHaveLength(1);
    expect(await authority.listEvents(taskId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: { type: "task_waiting", reason: "delivery_reconciliation", activation: 1 },
        }),
        expect.objectContaining({
          data: { type: "task_retry_accepted", reason: "delivery_reconciliation", activation: 1 },
        }),
      ]),
    );
    expect(admitted.writer).toEqual(resumed.writer);
  });

  test("fails closed when Task discovery encounters malformed durable state", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-list-quarantine-${Date.now()}`;
    await authority.admit({
      contract: makeContract(taskId),
      contractHash: "authority-list-quarantine-hash",
      repositoryIdentity: `authority/list-quarantine-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });

    const database = new DatabaseSync(path);
    database.prepare("UPDATE task_runs SET result = ? WHERE task_id = ?").run("{ invalid", taskId);
    database.close();

    await expect(authority.listTasks()).rejects.toMatchObject({
      code: "task_state_quarantined",
    });
  });

  test("keeps admission events in the existing Task-local history", async () => {
    const path = await makeDatabase();
    const handle = openSqliteDatabase(path);
    handles.push(handle);
    const observed: unknown[] = [];
    const authority = new TaskAuthority(handle.database, {
      onEvent: (event) => observed.push(event),
    });
    const taskId = `authority-legacy-admission-${Date.now()}`;
    const contractHash = "a".repeat(64);

    await expect(
      authority.admit({
        contract: makeContract(taskId),
        contractHash,
        repositoryIdentity: `authority/legacy-admission-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      }),
    ).resolves.toMatchObject({ taskId, state: "admitted" });

    const inspection = new DatabaseSync(path);
    const event = inspection
      .prepare("SELECT data FROM task_events WHERE task_id = ?")
      .get(taskId) as { data: string };
    inspection.close();
    expect(JSON.parse(event.data)).toMatchObject({
      type: "task_admitted",
      contractHash,
    });
    expect(observed).toHaveLength(1);
    await expect(authority.listEvents(taskId)).resolves.toHaveLength(1);
  });

  test("isolates corrupt rows during capacity admission without acquiring a rejected lease", async () => {
    const path = await makeDatabase();
    const corruptTaskId = `authority-capacity-corrupt-${Date.now()}`;
    const database = new DatabaseSync(path);
    database
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(corruptTaskId, "{ invalid");
    database.close();

    const authority = authorityAt(path);
    const admittedTaskId = `${corruptTaskId}-admitted`;
    const admittedRepository = `authority/capacity-${admittedTaskId}`;
    const admitted = await authority.admit(
      {
        contract: makeContract(admittedTaskId),
        contractHash: `${admittedTaskId}-hash`,
        repositoryIdentity: admittedRepository,
        deadlineEpochMs: Date.now() + 30_000,
      },
      undefined,
      1,
    );
    expect(admitted.taskId).toBe(admittedTaskId);

    const rejectedTaskId = `${corruptTaskId}-rejected`;
    const rejectedRepository = `authority/capacity-${rejectedTaskId}`;
    await expect(
      authority.admit(
        {
          contract: makeContract(rejectedTaskId),
          contractHash: `${rejectedTaskId}-hash`,
          repositoryIdentity: rejectedRepository,
          deadlineEpochMs: Date.now() + 30_000,
        },
        undefined,
        1,
      ),
    ).rejects.toMatchObject({ code: "active_task_capacity", active: 1 });
    await expect(authority.lookup(rejectedTaskId)).resolves.toBeNull();

    const inspection = new DatabaseSync(path);
    const lease = inspection
      .prepare("SELECT task_id FROM repository_leases WHERE repository_identity = ?")
      .get(rejectedRepository);
    inspection.close();
    expect(lease).toBeUndefined();
  });

  test("upgrades task history into ordered decodable events and removes the legacy table", async () => {
    const path = await makePreTaskEventsDatabase();
    const authority = authorityAt(path);
    const withHistory = await authority.listEvents("legacy-with-history");
    const withoutHistory = await authority.listEvents("legacy-without-history");

    expect(withHistory.map((event) => [event.sequence, event.eventId, event.data])).toEqual([
      [
        1,
        "legacy-history-1",
        {
          type: "legacy_observation",
          kind: "implementer",
          outcome: "succeeded",
          complete: false,
        },
      ],
      [
        2,
        "legacy-history-2",
        {
          type: "legacy_observation",
          kind: "project_check",
          outcome: "failed",
          complete: false,
        },
      ],
      [
        3,
        "legacy-import-incomplete",
        { type: "legacy_import_incomplete", importedCount: 2, complete: false },
      ],
    ]);
    expect(
      withHistory.every(
        (event) =>
          (event.data.type === "legacy_observation" ||
            event.data.type === "legacy_import_incomplete") &&
          !event.data.complete,
      ),
    ).toBe(true);
    expect(withoutHistory).toEqual([
      {
        taskId: "legacy-without-history",
        sequence: 1,
        eventId: "legacy-import-incomplete",
        occurredAtEpochMs: expect.any(Number),
        data: { type: "legacy_import_incomplete", importedCount: 0, complete: false },
      },
    ]);

    const inspection = new DatabaseSync(path);
    expect(
      inspection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_history'")
        .get(),
    ).toBeUndefined();
    expect(
      inspection
        .prepare("PRAGMA table_info(repositories)")
        .all()
        .find((row) => row.name === "github_read_profile"),
    ).toMatchObject({ name: "github_read_profile", notnull: 0 });
    inspection.close();
  });

  test("persists per-Repository read ownership while hiding it from projections", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const first = {
      id: "read-repository-one",
      path: "/repositories/one",
      owner: "example",
      name: "one",
      baseBranch: "main",
      implementerProfile: "writer-one",
      reviewerProfile: "reviewer-one",
      forgeProfile: "forge-one",
      githubReadProfile: "read-one",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    };
    const second = { ...first, id: "read-repository-two", name: "two", githubReadProfile: null };
    const savedFirst = await authority.registerRepository(first);
    await authority.registerRepository(second);

    expect(savedFirst.githubReadProfile).toBe("read-one");
    expect(await authority.lookupRepository(first.id)).toMatchObject({
      id: first.id,
      githubReadProfile: "read-one",
    });
    expect(await authority.lookupRepository(second.id)).toMatchObject({
      id: second.id,
      githubReadProfile: null,
    });
    const publicResource = await authority.lookupRepositoryResource(first.id);
    expect(publicResource).toMatchObject({ id: first.id, owner: "example", name: "one" });
    expect(JSON.stringify(publicResource)).not.toContain("read-one");

    const admitted = await authority.admit({
      contract: { ...makeContract("read-snapshot-task"), repositoryId: first.id },
      contractHash: "read-snapshot-hash",
      repositoryIdentity: "example/one",
      repository: savedFirst,
      deadlineEpochMs: Date.now() + 30_000,
    });
    expect(admitted.repository).toBeDefined();
    expect(JSON.stringify(admitted.repository)).not.toContain("read-one");
    expect(admitted.repository).not.toHaveProperty("githubReadProfile");
  });

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
      .run(taskId, JSON.stringify({ schemaVersion: 2, taskId }));
    inspection.close();

    const authority = authorityAt(path);
    await expect(authority.lookupExisting(taskId, "unused-contract-hash")).rejects.toMatchObject({
      code: "task_state_quarantined",
      message: "durable task state quarantined",
    });
  });

  test("decodes a version-one persisted result as an unauthorized current result", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-legacy-result-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await authority.admit({
      contract: makeContract(taskId),
      contractHash: "authority-legacy-result-hash",
      repositoryIdentity: `authority/legacy-result-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const inspection = new DatabaseSync(path);
    const legacy = { ...admitted, schemaVersion: 1 } as Record<string, unknown>;
    delete legacy.mergeAuthorized;
    inspection
      .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
      .run(JSON.stringify(legacy), taskId);
    inspection.close();

    await expect(authority.lookup(taskId)).resolves.toMatchObject({
      schemaVersion: 4,
      mergeAuthorized: false,
      state: "admitted",
      blockerClassification: null,
    });
  });

  test.each(["approved", "changes_requested"] as const)(
    "quarantines a persisted %s review with a failure class",
    async (verdict) => {
      const path = await makeDatabase();
      const authority = authorityAt(path);
      const taskId = `authority-invalid-review-${verdict}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const admitted = await authority.admit({
        contract: makeContract(taskId),
        contractHash: `authority-invalid-review-${verdict}`,
        repositoryIdentity: `authority/invalid-review-${verdict}-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const inspection = new DatabaseSync(path);
      inspection.prepare("UPDATE task_runs SET result = ? WHERE task_id = ?").run(
        JSON.stringify({
          ...admitted,
          review: {
            sha: "a".repeat(40),
            verdict,
            summary: "invalid persisted review",
            findings: [],
            failureClass: "unknown",
          },
        }),
        taskId,
      );
      inspection.close();

      await expect(authority.lookup(taskId)).rejects.toMatchObject({
        code: "task_state_quarantined",
        message: "durable task state quarantined",
      });
    },
  );

  test("decodes the prior version-two result without a waiting field", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-prior-result-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await authority.admit({
      contract: makeContract(taskId),
      contractHash: "authority-prior-result-hash",
      repositoryIdentity: `authority/prior-result-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const inspection = new DatabaseSync(path);
    const prior = { ...admitted, schemaVersion: 2 } as Record<string, unknown>;
    delete prior.waiting;
    inspection
      .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
      .run(JSON.stringify(prior), taskId);
    inspection.close();

    await expect(authority.lookup(taskId)).resolves.toMatchObject({
      schemaVersion: 4,
      state: "admitted",
      waiting: null,
    });
  });

  test("backfills a legacy blocked classification from its frozen event across migration and reopen", async () => {
    const path = await makePreBlockerClassificationDatabase();
    await applyMigrations(path);

    const inspection = new DatabaseSync(path);
    const persisted = inspection
      .prepare("SELECT result FROM task_runs WHERE task_id = ?")
      .get("legacy-blocked-with-event") as { result: string };
    inspection.close();
    expect(JSON.parse(persisted.result)).toMatchObject({ blockerClassification: "unknown" });

    const authority = authorityAt(path);
    const reopened = await authority.lookup("legacy-blocked-with-event");
    if (!reopened) throw new Error("blocked task is missing after migration");
    const resource = taskResourceFromResult(reopened);
    const blockedEvent = (await authority.listEvents(reopened.taskId)).find(
      (event) => event.data.type === "task_blocked",
    );
    if (!blockedEvent || blockedEvent.data.type !== "task_blocked")
      throw new Error("legacy blocked event is missing");

    expect(reopened.blocker).toBe("check failure: exact legacy private diagnostic");
    expect(reopened.blockerClassification).toBe(blockedEvent.data.reason);
    expect(resource.blocker).toEqual({ classification: blockedEvent.data.reason });
  });

  test("keeps blocker classification and exact diagnostic across SQLite close and reopen", async () => {
    const path = await makeDatabase();
    const taskId = `authority-blocker-reopen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstHandle = openSqliteDatabase(path);
    const first = new TaskAuthority(firstHandle.database);
    const admitted = await first.admit({
      contract: makeContract(taskId),
      contractHash: "a".repeat(64),
      repositoryIdentity: `authority/blocker-reopen-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const diagnostic = "check failure: exact private diagnostic";
    const blocked = await first.block({ taskId, revision: admitted.revision }, diagnostic);
    firstHandle.close();

    const secondHandle = openSqliteDatabase(path);
    const second = new TaskAuthority(secondHandle.database);
    const reopened = await second.lookup(taskId);
    if (!reopened) throw new Error("blocked task is missing after reopen");
    const resource = taskResourceFromResult(reopened);
    const blockedEvent = (await second.listEvents(taskId)).find(
      (event) => event.data.type === "task_blocked",
    );

    expect(blocked.blocker).toBe(diagnostic);
    expect(blocked.blockerClassification).toBe("project_check_failure");
    expect(reopened.blocker).toBe(blocked.blocker);
    expect(reopened.blockerClassification).toBe(blocked.blockerClassification);
    expect(resource.blocker).toEqual({ classification: "project_check_failure" });
    expect(blockedEvent).toMatchObject({
      data: { type: "task_blocked", reason: resource.blocker?.classification },
    });
    secondHandle.close();
  });

  test("blocks retry expiry with the same durable classification and diagnostic", async () => {
    const path = await makeDatabase();
    const taskId = `authority-retry-expiry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const handle = openSqliteDatabase(path);
    const authority = new TaskAuthority(handle.database);
    await authority.admit({
      contract: makeContract(taskId),
      contractHash: "b".repeat(64),
      repositoryIdentity: `authority/retry-expiry-${taskId}`,
      deadlineEpochMs: Date.now() - 1,
    });
    const reservation = await authority.reserveActivation(taskId, 3);
    const waiting = await authority.recordWaiting(
      { taskId, revision: reservation.result.revision },
      {
        reason: "network_interruption",
        resumeState: "admitted",
        activation: reservation.activation,
      },
    );

    const blocked = await authority.retryTask(taskId, 3);
    const resource = taskResourceFromResult(blocked);
    const events = await authority.listEvents(taskId);

    expect(waiting.state).toBe("waiting");
    expect(blocked.blocker).toBe("elapsed budget exhausted");
    expect(blocked.blockerClassification).toBe("elapsed_budget");
    expect(resource.blocker).toEqual({ classification: "elapsed_budget" });
    expect(events).toContainEqual(
      expect.objectContaining({
        data: { type: "task_blocked", reason: resource.blocker?.classification },
      }),
    );
    handle.close();
  });

  test("migrates a legacy activation exhaustion classification", async () => {
    const path = await makeDatabaseBeforeMigration(18);
    const taskId = `authority-implementation-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const elapsedTaskId = `${taskId}-elapsed`;
    const firstHandle = openSqliteDatabase(path);
    const first = new TaskAuthority(firstHandle.database);
    const admitted = await first.admit({
      contract: makeContract(taskId),
      contractHash: "a".repeat(64),
      repositoryIdentity: `authority/implementation-budget-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const elapsedAdmitted = await first.admit({
      contract: makeContract(elapsedTaskId),
      contractHash: "b".repeat(64),
      repositoryIdentity: `authority/implementation-budget-${elapsedTaskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    firstHandle.close();

    const legacyResult = {
      ...admitted,
      state: "blocked",
      blocker: "implementer activation budget exhausted",
      blockerClassification: "elapsed_budget",
    };
    const elapsedResult = {
      ...elapsedAdmitted,
      state: "blocked",
      blocker: "elapsed budget exhausted",
      blockerClassification: "elapsed_budget",
    };
    const legacy = new DatabaseSync(path);
    legacy
      .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
      .run(JSON.stringify(legacyResult), taskId);
    legacy
      .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
      .run(JSON.stringify(elapsedResult), elapsedTaskId);
    const blockedEvent = JSON.stringify({ type: "task_blocked", reason: "elapsed_budget" });
    legacy
      .prepare(
        "INSERT INTO task_events (task_id, sequence, event_id, occurred_at_epoch_ms, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, 2, `blocked:${taskId}`, Date.now(), blockedEvent);
    legacy
      .prepare(
        "INSERT INTO task_events (task_id, sequence, event_id, occurred_at_epoch_ms, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(elapsedTaskId, 2, `blocked:${elapsedTaskId}`, Date.now(), blockedEvent);
    legacy.close();

    await applyMigrations(path);
    const reopened = authorityAt(path);
    const result = await reopened.lookup(taskId);
    if (!result) throw new Error("migrated task is missing");

    expect(result.blockerClassification).toBe("implementation_budget");
    expect(taskResourceFromResult(result).blocker).toEqual({
      classification: "implementation_budget",
    });
    const elapsedResultAfterMigration = await reopened.lookup(elapsedTaskId);
    if (!elapsedResultAfterMigration) throw new Error("migrated elapsed task is missing");
    const events = await reopened.listEvents(taskId);
    const elapsedEvents = await reopened.listEvents(elapsedTaskId);
    expect(elapsedResultAfterMigration.blockerClassification).toBe("elapsed_budget");
    expect(events).toContainEqual(
      expect.objectContaining({
        data: { type: "task_blocked", reason: "implementation_budget" },
      }),
    );
    expect(elapsedEvents).toContainEqual(
      expect.objectContaining({
        data: { type: "task_blocked", reason: "elapsed_budget" },
      }),
    );
  });

  test.each(["unversioned", 1, 2, 3] as const)(
    "decodes a %s persisted blocker without quarantine",
    async (version) => {
      const path = await makeDatabase();
      const taskId = `authority-blocker-legacy-${String(version)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const firstHandle = openSqliteDatabase(path);
      const first = new TaskAuthority(firstHandle.database);
      const admitted = await first.admit({
        contract: makeContract(taskId),
        contractHash: "c".repeat(64),
        repositoryIdentity: `authority/blocker-legacy-${String(version)}-${taskId}`,
        deadlineEpochMs: Date.now() + 30_000,
      });
      const legacy = {
        ...admitted,
        state: "blocked",
        blocker: "check failure: legacy exact diagnostic",
      } as Record<string, unknown>;
      delete legacy.blockerClassification;
      if (version === "unversioned") delete legacy.schemaVersion;
      else legacy.schemaVersion = version;
      if (version === "unversioned" || version === 1) {
        delete legacy.mergeAuthorized;
        delete legacy.waiting;
      }
      if (version === 2) delete legacy.waiting;

      const inspection = new DatabaseSync(path);
      inspection
        .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
        .run(JSON.stringify(legacy), taskId);
      inspection.close();
      firstHandle.close();

      const secondHandle = openSqliteDatabase(path);
      const second = new TaskAuthority(secondHandle.database);
      await expect(second.lookup(taskId)).resolves.toMatchObject({
        schemaVersion: 4,
        blocker: "check failure: legacy exact diagnostic",
        blockerClassification: "unknown",
      });
      secondHandle.close();
    },
  );

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
    expect(JSON.parse(admittedRow.result)).toMatchObject({ schemaVersion: 4 });
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
        rawContract,
      },
    );

    const inspection = new DatabaseSync(path);
    const row = inspection
      .prepare("SELECT contract_path, raw_contract FROM task_runs WHERE task_id = ?")
      .get(taskId) as {
      contract_path: string;
      raw_contract: string;
    };
    inspection.close();
    expect(row).toEqual({
      contract_path: "repository/task.json",
      raw_contract: rawContract,
    });
  });

  test("quarantines an admitted V0 lifecycle row that lacks a repository snapshot", async () => {
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
    ).rejects.toMatchObject({ code: "task_state_quarantined" });

    const inspection = new DatabaseSync(path);
    const taskColumns = inspection
      .prepare("PRAGMA table_info(task_runs)")
      .all()
      .map((row) => String(row.name));
    const leaseColumns = inspection
      .prepare("PRAGMA table_info(repository_leases)")
      .all()
      .map((row) => String(row.name));
    expect(taskColumns).toEqual([
      "task_id",
      "result",
      "created_at",
      "updated_at",
      "contract_path",
      "raw_contract",
    ]);
    expect(leaseColumns).toEqual(["repository_identity", "task_id", "created_at"]);
    const quarantine = inspection
      .prepare("SELECT reason FROM task_quarantines WHERE task_id = ?")
      .get("authority-v0-migration") as { reason: string };
    expect(quarantine.reason).toBe("repository registration required");
    inspection.close();
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
    ).rejects.toBeInstanceOf(RepositoryWriterConflictError);
    await expect(
      firstAuthority.admit({
        contract: makeContract(`${taskId}-other-message`),
        contractHash: "other-message-hash",
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
        "authority-fixture-reviewer",
      ),
    ).rejects.toThrow("owned");

    const reviewAttempt = await authority.reserveReviewAttempt(
      taskId,
      3,
      "authority-fixture-reviewer",
    );
    const reviewed = await authority.recordReview(
      { taskId, revision: reviewAttempt.result.revision },
      { sha: "c".repeat(40), verdict: "approved", summary: "approved", findings: [] },
      "authority-fixture-reviewer",
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

  test("holds an authorized writer lease until a valid merged fact", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const inspection = new DatabaseSync(path);
    const taskId = `authority-merge-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await authority.admit({
      contract: makeContract(taskId, true),
      contractHash: "authority-merge-lease-hash",
      repositoryIdentity: `authority/merge-lease-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const reservation = await authority.reserveActivation(taskId, 3);
    const candidate = await authority.recordCandidate(
      { taskId, revision: reservation.result.revision },
      { sha: "b".repeat(40), baseSha: "a".repeat(40), fence: reservation.activation },
    );
    await authority.recordCheck(
      { taskId, revision: candidate.revision },
      {
        sha: "b".repeat(40),
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    const reviewAttempt = await authority.reserveReviewAttempt(
      taskId,
      3,
      "authority-fixture-reviewer",
    );
    const reviewed = await authority.recordReview(
      { taskId, revision: reviewAttempt.result.revision },
      { sha: "b".repeat(40), verdict: "approved", summary: "approved", findings: [] },
      "authority-fixture-reviewer",
    );
    const delivery = {
      sha: "b".repeat(40),
      effect: "github" as const,
      prNumber: 199,
      url: "https://example.invalid/pr/199",
      attestationId: "attestation",
    };
    await expect(
      authority.recordDelivery({ taskId, revision: reviewed.revision }, delivery),
    ).rejects.toThrow("exact approved candidate");
    expect(
      inspection
        .prepare("SELECT task_id FROM repository_leases WHERE repository_identity = ?")
        .get(admitted.writer.repositoryIdentity),
    ).toMatchObject({ task_id: taskId });

    const merged = await authority.recordDelivery(
      { taskId, revision: reviewed.revision },
      {
        ...delivery,
        merge: {
          prNumber: 199,
          approvedHeadSha: "b".repeat(40),
          mergeCommitSha: "c".repeat(40),
          observedState: "merged" as const,
        },
      },
    );
    expect(merged).toMatchObject({
      state: "merged",
      mergeAuthorized: true,
      delivery: { merge: { approvedHeadSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) } },
    });
    expect(
      inspection
        .prepare("SELECT task_id FROM repository_leases WHERE repository_identity = ?")
        .get(admitted.writer.repositoryIdentity),
    ).toBeUndefined();
    inspection.close();
  });

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

  test("atomically claims one reviewer and releases an interrupted reservation", async () => {
    const path = await makeDatabase();
    const firstAuthority = authorityAt(path);
    const secondAuthority = authorityAt(path);
    const taskId = `authority-review-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const input = {
      contract: makeContract(taskId),
      contractHash: "a".repeat(64),
      repositoryIdentity: `authority/review-race-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    };
    const admitted = await firstAuthority.admit(input);
    const activation = await firstAuthority.reserveActivation(taskId, 3);
    const candidate = await firstAuthority.recordCandidate(
      { taskId, revision: activation.result.revision },
      { sha: "b".repeat(40), baseSha: "a".repeat(40), fence: activation.activation },
    );
    await firstAuthority.recordCheck(
      { taskId, revision: candidate.revision },
      {
        sha: "b".repeat(40),
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );

    const reservations = await Promise.all([
      firstAuthority.reserveReviewAttempt(taskId, 2, "authority-race-owner-a"),
      secondAuthority.reserveReviewAttempt(taskId, 2, "authority-race-owner-b"),
    ]);
    expect(reservations.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect(reservations.map(({ result }) => result.state)).toEqual(["reviewing", "reviewing"]);
    const reviewing = reservations.find(({ claimed }) => claimed)?.result;
    expect(reviewing).toMatchObject({
      candidateSha: "b".repeat(40),
      check: { sha: "b".repeat(40), status: "passed" },
      evidence: { reviewCycles: 1 },
    });

    const released = await firstAuthority.releaseReviewAttempt(
      {
        taskId,
        revision: reviewing!.revision,
      },
      reviewing!.reviewAttempt!.ownerId,
    );
    expect(released).toMatchObject({
      state: "checked",
      candidateSha: "b".repeat(40),
      check: { sha: "b".repeat(40), status: "passed" },
      evidence: { reviewCycles: 0 },
    });
    const replacement = await secondAuthority.reserveReviewAttempt(
      taskId,
      2,
      "authority-race-owner-replacement",
    );
    expect(replacement).toMatchObject({ claimed: true, cycle: 1 });
    const events = await firstAuthority.listEvents(taskId);
    expect(events.filter((event) => event.data.type === "review_started")).toHaveLength(2);
    expect(events.filter((event) => event.data.type === "review_released")).toHaveLength(1);
    expect(admitted.taskId).toBe(taskId);
  }, 30_000);

  test("takes over a durable reviewing reservation after restart and fences stale completion", async () => {
    const path = await makeDatabase();
    const firstAuthority = authorityAt(path);
    const secondAuthority = authorityAt(path);
    const taskId = `authority-review-takeover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const admitted = await firstAuthority.admit({
      contract: makeContract(taskId),
      contractHash: "b".repeat(64),
      repositoryIdentity: `authority/review-takeover-${taskId}`,
      deadlineEpochMs: Date.now() + 30_000,
    });
    const activation = await firstAuthority.reserveActivation(taskId, 3);
    const candidate = await firstAuthority.recordCandidate(
      { taskId, revision: activation.result.revision },
      { sha: "b".repeat(40), baseSha: "a".repeat(40), fence: activation.activation },
    );
    const checked = await firstAuthority.recordCheck(
      { taskId, revision: candidate.revision },
      {
        sha: "b".repeat(40),
        status: "passed",
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    const firstReservation = await firstAuthority.reserveReviewAttempt(
      taskId,
      3,
      "process-owner-a",
    );
    expect(firstReservation).toMatchObject({
      claimed: true,
      cycle: 1,
      result: {
        state: "reviewing",
        reviewAttempt: { ownerId: "process-owner-a" },
        evidence: { reviewCycles: 1 },
      },
    });

    // The first process exits after reservation and before Quality Gate can
    // produce either a verdict or an interruption fact.
    const takeover = await secondAuthority.takeOverReviewAttempt(taskId, 3, "process-owner-b");
    expect(takeover).toMatchObject({
      claimed: true,
      cycle: 2,
      result: {
        state: "reviewing",
        candidateSha: "b".repeat(40),
        check: { sha: "b".repeat(40), status: "passed" },
        reviewAttempt: { ownerId: "process-owner-b" },
        evidence: { reviewCycles: 2 },
      },
    });
    await expect(
      firstAuthority.recordReview(
        { taskId, revision: firstReservation.result.revision },
        { sha: "b".repeat(40), verdict: "approved", summary: "stale", findings: [] },
        "process-owner-a",
      ),
    ).rejects.toThrow("stale task revision");

    const reviewed = await secondAuthority.recordReview(
      { taskId, revision: takeover.result.revision },
      { sha: "b".repeat(40), verdict: "approved", summary: "fresh", findings: [] },
      "process-owner-b",
    );
    expect(reviewed).toMatchObject({
      state: "reviewed",
      candidateSha: "b".repeat(40),
      check: { sha: "b".repeat(40), status: "passed" },
      review: { sha: "b".repeat(40), verdict: "approved" },
      reviewAttempt: null,
      evidence: { reviewCycles: 2 },
    });
    const events = await firstAuthority.listEvents(taskId);
    expect(events.filter((event) => event.data.type === "review_started")).toHaveLength(2);
    expect(events.filter((event) => event.data.type === "review_completed")).toHaveLength(1);
    expect(admitted.taskId).toBe(taskId);
    expect(checked.candidateSha).toBe("b".repeat(40));
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
