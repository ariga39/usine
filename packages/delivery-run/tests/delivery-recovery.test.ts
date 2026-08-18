import { describe, expect, test } from "vite-plus/test";
import type { TaskContract } from "@usine/task-authority";
import { executeDeliveryRun } from "../src/delivery-run.js";
import { applyTaskFact, type CandidateFact, type TaskResult } from "@usine/task-authority";

const sha = "b".repeat(40);
const implementer = {
  role: "implementer" as const,
  model: "test",
  reasoningEffort: "high",
  sandbox: "workspace-write" as const,
};
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
  quality: {
    check: (...args: never[]) => Promise<unknown>;
    review: (...args: never[]) => Promise<unknown>;
  },
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
  test("passes lossless failed-check evidence to repair without reviewing or delivering it", async () => {
    const id = "stdout-only-check-failure";
    const fake = fakeAuthority(persistedResult("admitted", id));
    const prompts: string[] = [];
    const checked: string[] = [];
    const sessions = [
      { status: "completed", output: { status: "proposed", summary: "candidate" } },
      { status: "completed", output: { status: "blocked", summary: "repair evidence received" } },
    ];
    const quality = {
      check: async (_contract: TaskContract, candidateSha: string) => {
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
      review: async () => {
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
        repository: ".",
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
            fence: activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer: { baseSha: string }) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt);
            return sessions.shift();
          },
        },
        quality,
        forge,
      } as never,
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
        repository: ".",
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
            fence: activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer: { baseSha: string }) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt);
            return { status: "completed", output: { status: "proposed", summary: "repaired" } };
          },
        },
        quality: {
          check: async (_contract: TaskContract, candidateSha: string) => {
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
          review: async (_contract: TaskContract, candidateSha: string) => {
            reviewed.push(candidateSha);
            return {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            };
          },
        },
        forge: {
          deliver: async (_contract: TaskContract, candidateSha: string) => {
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
      } as never,
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
        check: async (_contract: TaskContract, candidateSha: string) => {
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
        review: async (_contract: TaskContract, candidateSha: string) => {
          reviewed.push(candidateSha);
          return {
            sha: candidateSha,
            verdict: "approved" as const,
            summary: "approved",
            findings: [],
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
        repository: ".",
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
          review: async () => {
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
      deliver: async (_contract: TaskContract, candidateSha: string) => {
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
      repository: ".",
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
            review: async () => {
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
          review: async () => {
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
