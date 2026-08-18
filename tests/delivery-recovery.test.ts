import { describe, expect, test } from "vitest";
import type { TaskContract } from "../packages/runtime/src/contract.js";
import { executeDeliveryRun } from "../packages/runtime/src/delivery-run.js";
import type { TaskResult } from "../packages/runtime/src/task-authority.js";

const sha = "b".repeat(40);

function contract(id: string): TaskContract {
  return {
    id,
    repository: { path: ".", owner: "recovery", name: "recovery" },
    baseSha: "a".repeat(40),
    instructions: "recover",
    acceptance: ["recover"],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 60_000 },
    authorization: { source: "recovery test", delivery: true },
    delivery: {
      baseBranch: "main",
      branch: "agent/recovery",
      issue: 80,
      title: "recovery",
      body: "recovery",
    },
  };
}

function persistedResult(state: TaskResult["state"], id: string): TaskResult {
  return {
    taskId: id,
    contractHash: "hash",
    revision: 4,
    deadlineEpochMs: Date.now() + 30_000,
    state,
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
    writer: { repository: ".", repositoryIdentity: `recovery/${id}`, generation: 1 },
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
  const authority = {
    admit: async () => stored,
    save: async (next: TaskResult) => {
      if (next.revision !== stored.revision) throw new Error("stale task revision");
      stored = { ...next, revision: stored.revision + 1 };
      return stored;
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
  };
}

function servicesFor(
  authority: ReturnType<typeof fakeAuthority>["authority"],
  quality: { evaluate: (...args: never[]) => Promise<unknown> },
  forge: { deliver: (...args: never[]) => Promise<unknown> },
) {
  return {
    authority,
    workspace: {
      quarantinePriorWriters: async () => undefined,
      prepareWriter: async () => ({
        taskId: "recovery",
        activation: 1,
        fence: 1,
        path: ".",
        baseSha: "a".repeat(40),
      }),
      freeze: async () => ({
        sha,
        baseSha: "a".repeat(40),
        workspace: {
          taskId: "recovery",
          activation: 1,
          fence: 1,
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
  } as never;
}

describe("Delivery Run durable phase recovery", () => {
  test.each(["candidate", "checked", "reviewed"] as const)(
    "resumes %s without another implementer activation",
    async (state) => {
      const id = `phase-${state}`;
      const initial = persistedResult(state, id);
      const fake = fakeAuthority(initial);
      const evaluated: string[] = [];
      const delivered: string[] = [];
      const quality = {
        evaluate: async (_contract: TaskContract, candidateSha: string) => {
          evaluated.push(candidateSha);
          return {
            check: {
              sha: candidateSha,
              status: "passed" as const,
              command: "true",
              exitCode: 0,
              stdout: "",
              stderr: "",
            },
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
          };
        },
      };
      const forge = {
        deliver: async (_contract: TaskContract, candidateSha: string) => {
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
          repository: ".",
          repositoryIdentity: `recovery/${id}`,
          deadlineEpochMs: Date.now() + 60_000,
          implementerModel: "test",
          stopAfterAdmitted: false,
        },
        servicesFor(fake.authority, quality, forge),
      );
      expect(result.state).toBe("reviewed_pr");
      expect(fake.getImplementerActivations()).toBe(0);
      expect(evaluated).toEqual(state === "reviewed" ? [] : [sha]);
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
        repository: ".",
        repositoryIdentity: `recovery/${id}`,
        // A restarted caller may supply a fresh wall-clock budget; the reducer
        // must ignore it in favor of the persisted deadline.
        deadlineEpochMs: Date.now() + 60_000,
        implementerModel: "test",
        stopAfterAdmitted: false,
      },
      servicesFor(
        fake.authority,
        {
          evaluate: async () => {
            throw new Error("unexpected check");
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
      deliver: async (_contract: TaskContract, candidateSha: string) => {
        calls += 1;
        if (!effectObserved) {
          // The external PR/comment write happened, but the coordinator lost
          // the response before it could save reviewed_pr.
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
      repository: ".",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementerModel: "test",
      stopAfterAdmitted: false,
    };
    await expect(
      executeDeliveryRun(
        input,
        servicesFor(
          fake.authority,
          {
            evaluate: async () => {
              throw new Error("unexpected check");
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
          evaluate: async () => {
            throw new Error("unexpected check");
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
