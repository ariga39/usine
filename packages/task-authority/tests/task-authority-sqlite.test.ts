import { mkdtemp } from "node:fs/promises";
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
      generation: admitted.writer.generation,
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
  test("accepts a candidate fact without accepting a caller-owned durable snapshot", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-candidate-fact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const deadlineEpochMs = Date.now() + 30_000;
    const admitted = await authority.admit({
      contract,
      contractHash: "authority-candidate-fact-hash",
      repository: ".",
      repositoryIdentity: `authority/candidate-fact-${taskId}`,
      deadlineEpochMs,
    });
    const reservation = await authority.reserveActivation(taskId, 3);

    const candidate = await authority.recordCandidate(
      { taskId, revision: reservation.result.revision },
      {
        sha: "b".repeat(40),
        baseSha: contract.baseSha,
        generation: reservation.result.writer.generation,
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
      repository: ".",
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
          generation: first.result.writer.generation,
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
          generation: second.result.writer.generation,
          fence: first.activation,
        },
      ),
    ).rejects.toThrow("candidate fence is stale");

    const current = await secondAuthority.recordCandidate(
      { taskId, revision: second.result.revision },
      {
        sha: "b".repeat(40),
        baseSha: contract.baseSha,
        generation: second.result.writer.generation,
        fence: second.activation,
      },
    );
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

  test("rejects check, review, and delivery facts from an older candidate SHA", async () => {
    const path = await makeDatabase();
    const authority = authorityAt(path);
    const taskId = `authority-stale-evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const contract = makeContract(taskId);
    const input = {
      contract,
      contractHash: "authority-stale-evidence-hash",
      repository: ".",
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
        generation: first.result.writer.generation,
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
        generation: second.result.writer.generation,
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
      await expect(
        authority.block({ taskId, revision: terminal.revision }, "stale observation"),
      ).rejects.toThrow("repository writer lease is stale");
    },
    30_000,
  );
});
