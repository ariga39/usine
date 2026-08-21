import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  type ResolvedTaskContract,
} from "@usine/task-authority";
import { executeDeliveryRun, type DeliveryRunServices } from "../src/delivery-run.js";
import { DeliveryQuarantineError } from "@usine/forge-delivery";
import {
  applyTaskFact,
  type CandidateFact,
  type TaskObservationEventInput,
  type TaskResult,
} from "@usine/task-authority";

type ObservationCapabilityIsRequired = DeliveryRunServices["authority"] extends {
  appendObservation: (taskId: string, input: TaskObservationEventInput) => Promise<unknown>;
}
  ? true
  : false;
const observationCapabilityIsRequired: ObservationCapabilityIsRequired = true;
void observationCapabilityIsRequired;

const sha = "b".repeat(40);
const implementer = {
  role: "implementer" as const,
  profile: "implementer-profile",
  sandbox: "workspace-write" as const,
};
function contract(id: string, merge = false): ResolvedTaskContract {
  return {
    id,
    repositoryId: "recovery-repository",
    repository: { path: ".", owner: "recovery", name: "recovery" },
    baseSha: "a".repeat(40),
    instructions: "recover",
    acceptance: ["recover"],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 60_000 },
    authorization: { source: "recovery test", delivery: true, ...(merge ? { merge: true } : {}) },
    delivery: {
      baseBranch: "main",
      branch: "agent/recovery",
      issue: 80,
      title: "recovery",
      body: "recovery",
    },
  };
}

function persistedResult(
  state: TaskResult["state"],
  id: string,
  mergeAuthorized = false,
): TaskResult {
  return {
    schemaVersion: 2,
    taskId: id,
    contractHash: "hash",
    revision: 4,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    mergeAuthorized,
    candidateSha: state === "admitted" ? null : sha,
    candidateFence: state === "admitted" ? null : 1,
    check:
      state === "checked" || state === "reviewed"
        ? { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" }
        : null,
    review:
      state === "reviewed" ? { sha, verdict: "approved", summary: "approved", findings: [] } : null,
    delivery: null,
    blocker: null,
    activeActivation: null,
    writer: { repositoryIdentity: `recovery/${id}` },
    evidence: {
      implementerActivations: state === "admitted" ? 0 : 1,
      reviewCycles: state === "reviewed" ? 1 : 0,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function fakeAuthority(initial: TaskResult) {
  let stored = initial;
  let implementerActivations = 0;
  const observations: TaskObservationEventInput[] = [];
  const transition = async (
    observation: { taskId: string; revision: number },
    fact: Parameters<typeof applyTaskFact>[1],
  ) => {
    if (observation.taskId !== stored.taskId || observation.revision !== stored.revision)
      throw new Error("stale task revision");
    stored = { ...applyTaskFact(stored, fact), revision: stored.revision + 1 };
    return stored;
  };
  const authority = {
    admit: async () => stored,
    recordCandidate: (
      observation: { taskId: string; revision: number },
      candidate: CandidateFact,
    ) => transition(observation, { type: "candidate", candidate }),
    recordCheck: (observation: { taskId: string; revision: number }, check: TaskResult["check"]) =>
      transition(observation, { type: "check", check: check! }),
    recordReview: (
      observation: { taskId: string; revision: number },
      review: TaskResult["review"],
    ) => transition(observation, { type: "review", review: review! }),
    recordRepairBatch: (observation: { taskId: string; revision: number }) =>
      transition(observation, { type: "repair_batch" }),
    recordDelivery: (
      observation: { taskId: string; revision: number },
      delivery: TaskResult["delivery"],
    ) => transition(observation, { type: "delivery", delivery: delivery! }),
    block: (observation: { taskId: string; revision: number }, blocker: string) =>
      transition(observation, { type: "blocked", blocker }),
    appendObservation: async (_taskId: string, observation: TaskObservationEventInput) => {
      observations.push(observation);
    },
    reserveActivation: async () => {
      implementerActivations += 1;
      stored = {
        ...stored,
        revision: stored.revision + 1,
        activeActivation: stored.evidence.implementerActivations + 1,
        evidence: {
          ...stored.evidence,
          implementerActivations: stored.evidence.implementerActivations + 1,
        },
      };
      return { result: stored, activation: stored.evidence.implementerActivations };
    },
  };
  return {
    authority,
    getStored: () => stored,
    getImplementerActivations: () => implementerActivations,
    getObservations: () => observations,
  };
}

function servicesFor(
  authority: DeliveryRunServices["authority"],
  quality: DeliveryRunServices["quality"],
  forge: DeliveryRunServices["forge"],
): DeliveryRunServices {
  return {
    authority,
    workspace: {
      quarantinePriorWriters: async () => undefined,
      prepareWriter: async () => ({
        taskId: "recovery",
        activation: 1,
        path: ".",
        baseSha: "a".repeat(40),
      }),
      freeze: async () => ({
        sha,
        baseSha: "a".repeat(40),
        workspace: {
          taskId: "recovery",
          activation: 1,
          path: ".",
          baseSha: "a".repeat(40),
        },
      }),
      quarantine: async () => undefined,
    },
    session: {
      run: async () => {
        throw new Error("unexpected implementer activation");
      },
    },
    quality,
    forge,
  };
}

describe("Delivery Run durable phase recovery", () => {
  test("requires a typed fresh-review observation from Quality Gate", () => {
    const legacyQuality = {
      check: async () => ({
        sha,
        status: "passed" as const,
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      review: async () => ({
        sha,
        verdict: "approved" as const,
        summary: "approved",
        findings: [],
      }),
    };

    // @ts-expect-error Delivery Run must not accept the legacy verdict-only callback.
    const quality: DeliveryRunServices["quality"] = legacyQuality;
    expect(quality).toBe(legacyQuality);
  });

  test("records provider-neutral coding observations without raw session data", async () => {
    const id = `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("admitted", id));
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "history-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
        reviewer: { ...implementer, role: "reviewer", sandbox: "read-only" },
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId, activation, baseSha) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({ sha, baseSha: writer.baseSha, workspace: writer }),
          quarantine: async () => undefined,
        },
        session: {
          run: async () => ({
            status: "completed" as const,
            output: { status: "proposed" as const, summary: "candidate" },
            summary: "completed",
            failure: null,
            usage: { inputTokens: 12, outputTokens: 7 },
          }),
        },
        quality: {
          check: async (_contract, candidateSha) => ({
            sha: candidateSha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
          reviewWithObservation: async (_contract, candidateSha) => ({
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
            usage: { inputTokens: 5, outputTokens: 3 },
          }),
        },
        forge: {
          deliver: async (_contract, candidateSha) => ({
            sha: candidateSha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "history",
          }),
        },
      },
    );

    expect(result.state).toBe("reviewed_pr");
    expect(fake.getObservations().map(({ data }) => data.type)).toEqual([
      "coding_session_started",
      "coding_session_completed",
      "coding_session_started",
      "coding_session_completed",
    ]);
    expect(
      fake
        .getObservations()
        .map(({ data }) => (data.type === "coding_session_started" ? data.sessionId : null)),
    ).toEqual(["coding-session:1:implementer", null, "review-session:1:reviewer", null]);
    expect(JSON.stringify(fake.getObservations())).not.toMatch(
      /prompt|stdout|stderr|profile|token/i,
    );
  });

  test("persists an authorized exact-head merge effect as the merged terminal state", async () => {
    const id = "authorized-merge-boundary";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const mergeCommitSha = "c".repeat(40);
    const result = await executeDeliveryRun(
      {
        contract: contract(id, true),
        contractHash: "authorized-merge-boundary-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => ({
            sha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "authorized",
            merge: {
              prNumber: 80,
              approvedHeadSha: sha,
              mergeCommitSha,
              observedState: "merged" as const,
            },
          }),
        },
      ),
    );

    expect(result).toMatchObject({
      state: "merged",
      mergeAuthorized: true,
      delivery: {
        sha,
        attestationId: "authorized",
        merge: { prNumber: 80, approvedHeadSha: sha, mergeCommitSha, observedState: "merged" },
      },
    });
  });

  test("turns a proved platform merge refusal into a blocker without a delivery fact", async () => {
    const id = "platform-refusal-boundary";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const result = await executeDeliveryRun(
      {
        contract: contract(id, true),
        contractHash: "platform-refusal-boundary-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => {
            throw new DeliveryQuarantineError(
              "platform merge refused after authoritative probe: required check is pending",
            );
          },
        },
      ),
    );

    expect(result).toMatchObject({
      state: "blocked",
      blocker: "platform merge refused after authoritative probe: required check is pending",
      delivery: null,
    });
    expect(fake.getStored().delivery).toBeNull();
  });

  test("re-enters an authorized pre-merge result and records one recovered merge effect", async () => {
    const id = "authorized-merge-reentry";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const mergeCommitSha = "d".repeat(40);
    let calls = 0;
    const forge = {
      deliver: async () => {
        calls += 1;
        if (calls === 1) throw new Error("merge response lost after platform acceptance");
        return {
          sha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "recovered-merge",
          merge: {
            prNumber: 80,
            approvedHeadSha: sha,
            mergeCommitSha,
            observedState: "merged" as const,
          },
        };
      },
    };
    const input = {
      contract: contract(id, true),
      contractHash: "authorized-merge-reentry-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    const noOpQuality = {
      check: async () => {
        throw new Error("unexpected check");
      },
      reviewWithObservation: async () => {
        throw new Error("unexpected review");
      },
    };

    await expect(
      executeDeliveryRun(input, servicesFor(fake.authority, noOpQuality, forge)),
    ).rejects.toThrow("merge response lost after platform acceptance");
    expect(fake.getStored()).toMatchObject({ state: "reviewed", delivery: null });

    const recovered = await executeDeliveryRun(
      input,
      servicesFor(fake.authority, noOpQuality, forge),
    );
    expect(recovered).toMatchObject({
      state: "merged",
      delivery: { attestationId: "recovered-merge", merge: { mergeCommitSha } },
    });
    expect(calls).toBe(2);
  });

  test("stops before recording candidate evidence when cancelled", async () => {
    const id = `cancelled-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const controller = new AbortController();
    const state = fakeAuthority(persistedResult("admitted", id));
    const input = {
      contract: contract(id),
      contractHash: "cancelled-run-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 30_000,
      implementer,
      signal: controller.signal,
    };

    await expect(
      executeDeliveryRun(input, {
        ...servicesFor(
          state.authority,
          {
            check: async () => {
              throw new Error("check should not start");
            },
            reviewWithObservation: async () => {
              throw new Error("review should not start");
            },
          },
          {
            deliver: async () => {
              throw new Error("delivery should not start");
            },
          },
        ),
        session: {
          run: async () => {
            controller.abort();
            return {
              status: "completed" as const,
              output: { status: "proposed" as const, summary: "candidate" },
              summary: "completed",
              failure: null,
            };
          },
        },
      }),
    ).rejects.toThrow("task execution cancelled");
    expect(state.getStored()).toMatchObject({ state: "admitted", candidateSha: null });
  });

  test("returns the first durable blocker after a failed check exhausts activations", async () => {
    const id = `sqlite-terminal-block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const taskContract = {
      ...contract(id),
      budget: { ...contract(id).budget, maxImplementerActivations: 1 },
    };
    const repositoryIdentity = `recovery/${id}`;
    const directory = await mkdtemp(join(tmpdir(), "usine-delivery-run-"));
    const databasePath = join(directory, "state.sqlite");
    await applyMigrations(databasePath);
    const database = openSqliteDatabase(databasePath);
    const realAuthority = new TaskAuthority(database.database);
    let blockCalls = 0;
    const authority = new Proxy(realAuthority, {
      get(target, property, receiver) {
        if (property === "block") {
          return (...args: Parameters<TaskAuthority["block"]>) => {
            blockCalls += 1;
            return target.block(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = {
      contract: taskContract,
      contractHash: "sqlite-terminal-block-hash",
      repositoryIdentity,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };

    try {
      const result = await executeDeliveryRun(input, {
        authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async () => ({
            status: "completed" as const,
            output: { status: "proposed" as const, summary: "candidate" },
            summary: "completed",
            failure: null,
          }),
        },
        quality: {
          check: async () => ({
            sha,
            status: "failed" as const,
            command: "pnpm test",
            exitCode: 1,
            stdout: "",
            stderr: "budget exhausted while checking candidate",
          }),
          reviewWithObservation: async () => {
            throw new Error("failed candidate must not be reviewed");
          },
        },
        forge: {
          deliver: async () => {
            throw new Error("failed candidate must not be delivered");
          },
        },
      });

      expect(result.state).toBe("blocked");
      expect(result.blocker).toBe("implementer activation budget exhausted");
      expect(result.evidence.implementerActivations).toBe(1);
      expect(blockCalls).toBe(1);

      const rerun = await executeDeliveryRun(
        input,
        servicesFor(
          authority,
          {
            check: async () => {
              throw new Error("terminal task must not be checked");
            },
            reviewWithObservation: async () => {
              throw new Error("terminal task must not be reviewed");
            },
          },
          {
            deliver: async () => {
              throw new Error("terminal task must not be delivered");
            },
          },
        ),
      );
      expect(rerun).toEqual(result);
      expect(blockCalls).toBe(1);

      const nextTask = await authority.admit({
        contract: contract(`${id}-next`),
        contractHash: "sqlite-terminal-block-next-hash",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 60_000,
      });
      expect(nextTask.state).toBe("admitted");
    } finally {
      database.close();
    }
  }, 30_000);

  test("passes lossless failed-check evidence to repair without reviewing or delivering it", async () => {
    const id = "stdout-only-check-failure";
    const fake = fakeAuthority(persistedResult("admitted", id));
    const prompts: string[] = [];
    const checked: string[] = [];
    const sessions = [
      {
        status: "completed" as const,
        output: { status: "proposed" as const, summary: "candidate" },
        summary: "completed",
        failure: null,
      },
      {
        status: "completed" as const,
        output: { status: "blocked" as const, summary: "repair evidence received" },
        summary: "blocked",
        failure: null,
      },
    ];
    const quality = {
      check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
        checked.push(candidateSha);
        return {
          sha: candidateSha,
          status: "failed" as const,
          command: "vp test run tests/repair.test.ts",
          exitCode: 7,
          stdout: "repair this stdout-only diagnostic",
          stderr: "",
        };
      },
      reviewWithObservation: async () => {
        throw new Error("failed candidate must not be reviewed");
      },
    };
    const forge = {
      deliver: async () => {
        throw new Error("failed candidate must not be delivered");
      },
    };
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }) => {
            prompts.push(prompt);
            return sessions.shift()!;
          },
        },
        quality,
        forge,
      },
    );

    expect(result.state).toBe("blocked");
    expect(checked).toEqual([sha]);
    expect(fake.getImplementerActivations()).toBe(2);
    expect(prompts[1]).toContain(
      `Failed project check evidence: ${JSON.stringify({
        sha,
        status: "failed",
        command: "vp test run tests/repair.test.ts",
        exitCode: 7,
        stdout: "repair this stdout-only diagnostic",
        stderr: "",
      })}`,
    );
    expect(result.review).toBeNull();
  });

  test("aggregates one changes-requested batch before the repair delivery", async () => {
    const id = "review-repair";
    const initial = {
      ...persistedResult("reviewed", id),
      review: { sha, verdict: "changes_requested" as const, summary: "fix", findings: ["fix"] },
    };
    const fake = fakeAuthority(initial);
    const prompts: string[] = [];
    const checked: string[] = [];
    const reviewed: string[] = [];
    const delivered: string[] = [];
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }) => {
            prompts.push(prompt);
            return {
              status: "completed" as const,
              output: { status: "proposed" as const, summary: "repaired" },
              summary: "completed",
              failure: null,
            };
          },
        },
        quality: {
          check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            checked.push(candidateSha);
            return {
              sha: candidateSha,
              status: "passed" as const,
              command: "true",
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
          reviewWithObservation: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            reviewed.push(candidateSha);
            return {
              review: {
                sha: candidateSha,
                verdict: "approved" as const,
                summary: "approved",
                findings: [],
              },
              usage: null,
            };
          },
        },
        forge: {
          deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            delivered.push(candidateSha);
            return {
              sha: candidateSha,
              effect: "github" as const,
              prNumber: 80,
              url: "https://example.invalid/pr/80",
              attestationId: "repair",
            };
          },
        },
      },
    );

    expect(result.state).toBe("reviewed_pr");
    expect(prompts[0]).toContain("Aggregated findings to repair: fix");
    expect(checked).toEqual([sha]);
    expect(reviewed).toEqual([sha]);
    expect(delivered).toEqual([sha]);
    expect(fake.getStored().evidence.changesRequestedBatches).toBe(1);
  });

  test.each(["candidate", "checked", "reviewed"] as const)(
    "resumes %s without another implementer activation",
    async (state) => {
      const id = `phase-${state}`;
      const initial = persistedResult(state, id);
      const fake = fakeAuthority(initial);
      const evaluated: string[] = [];
      const reviewed: string[] = [];
      const delivered: string[] = [];
      const quality = {
        check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          evaluated.push(candidateSha);
          return {
            sha: candidateSha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
        reviewWithObservation: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          reviewed.push(candidateSha);
          return {
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
            usage: null,
          };
        },
      };
      const forge = {
        deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          delivered.push(candidateSha);
          return {
            sha: candidateSha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "recovery",
          };
        },
      };
      const result = await executeDeliveryRun(
        {
          contract: contract(id),
          contractHash: "hash",
          repositoryIdentity: `recovery/${id}`,
          deadlineEpochMs: Date.now() + 60_000,
          implementer,
        },
        servicesFor(fake.authority, quality, forge),
      );
      expect(result.state).toBe("reviewed_pr");
      expect(fake.getImplementerActivations()).toBe(0);
      expect(evaluated).toEqual(state === "candidate" ? [sha] : []);
      expect(reviewed).toEqual(state === "reviewed" ? [] : [sha]);
      expect(delivered).toEqual([sha]);
    },
  );

  test("durably blocks an expired persisted deadline without activating a writer", async () => {
    const id = "expired-phase";
    const initial = persistedResult("admitted", id);
    const expired = { ...initial, deadlineEpochMs: Date.now() - 1 };
    const fake = fakeAuthority(expired);
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        // A restarted caller may supply a fresh wall-clock budget; the reducer
        // must ignore it in favor of the persisted deadline.
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => {
            throw new Error("unexpected delivery");
          },
        },
      ),
    );
    expect(result.state).toBe("blocked");
    expect(result.blocker).toBe("elapsed budget exhausted");
    expect(fake.getImplementerActivations()).toBe(0);
  });

  test("reconciles an uncertain forge effect from the persisted approved review", async () => {
    const id = "uncertain-forge";
    const fake = fakeAuthority(persistedResult("reviewed", id));
    let calls = 0;
    let effectObserved = false;
    const forge = {
      deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
        calls += 1;
        if (!effectObserved) {
          // The external PR/comment write happened, but the coordinator lost
          // the response before it could persist reviewed_pr.
          effectObserved = true;
          throw new Error("response lost after effect");
        }
        return {
          sha: candidateSha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "reconciled",
        };
      },
    };
    const input = {
      contract: contract(id),
      contractHash: "hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    await expect(
      executeDeliveryRun(
        input,
        servicesFor(
          fake.authority,
          {
            check: async () => {
              throw new Error("unexpected check");
            },
            reviewWithObservation: async () => {
              throw new Error("unexpected review");
            },
          },
          forge,
        ),
      ),
    ).rejects.toThrow("response lost after effect");
    const result = await executeDeliveryRun(
      input,
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        forge,
      ),
    );
    expect(result.state).toBe("reviewed_pr");
    expect(result.candidateSha).toBe(sha);
    expect(fake.getImplementerActivations()).toBe(0);
    expect(calls).toBe(2);
    expect(effectObserved).toBe(true);
  });
});
