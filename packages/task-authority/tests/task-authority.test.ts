import { describe, expect, test } from "vite-plus/test";
import { applyTaskFact, canTransition, type TaskResult } from "@usine/task-authority";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "authority-module-test" } as TaskContract;

describe("Task Authority module contract", () => {
  test("accepts only legal lifecycle transitions", () => {
    expect(canTransition("admitted", "candidate")).toBe(true);
    expect(canTransition("reviewed_pr", "candidate")).toBe(false);
  });

  test("applies legal facts and rejects stale fences without persistence", () => {
    const admitted: TaskResult = {
      schemaVersion: 1,
      taskId: contract.id,
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "admitted",
      candidateSha: null,
      candidateFence: null,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      activeActivation: 1,
      writer: { repositoryIdentity: "owner/repo" },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 0,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    const candidate = applyTaskFact(admitted, {
      type: "candidate",
      candidate: { sha, baseSha: sha, fence: 1 },
    });
    expect(candidate).toMatchObject({
      state: "candidate",
      candidateSha: sha,
      activeActivation: null,
    });
    expect(() =>
      applyTaskFact(admitted, {
        type: "candidate",
        candidate: { sha, baseSha: sha, fence: 0 },
      }),
    ).toThrow("stale");
  });
});
