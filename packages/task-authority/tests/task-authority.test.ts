import { describe, expect, test } from "vite-plus/test";
import { applyTaskFact, canTransition, type TaskResult } from "@usine/task-authority";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "authority-module-test" } as TaskContract;

describe("Task Authority module contract", () => {
  test("accepts only legal lifecycle transitions", () => {
    expect(canTransition("admitted", "candidate")).toBe(true);
    expect(canTransition("admitted", "waiting")).toBe(true);
    expect(canTransition("reviewed_pr", "candidate")).toBe(false);
    expect(canTransition("reviewed", "merged")).toBe(true);
  });

  test("makes a turn network interruption waiting until an explicit retry fact", () => {
    const active: TaskResult = {
      schemaVersion: 4,
      taskId: contract.id,
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "admitted",
      mergeAuthorized: false,
      candidateSha: null,
      candidateFence: null,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      blockerClassification: null,
      waiting: null,
      activeActivation: 1,
      writer: { repositoryIdentity: "owner/repo" },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 0,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    const waiting = applyTaskFact(active, {
      type: "waiting",
      waiting: { reason: "network_interruption", resumeState: "admitted", activation: 1 },
    });
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "network_interruption", resumeState: "admitted", activation: 1 },
      activeActivation: null,
      evidence: { implementerActivations: 1 },
    });
    const resumed = applyTaskFact(waiting, { type: "retry" });
    expect(resumed).toMatchObject({ state: "admitted", waiting: null, activeActivation: null });
  });

  test("applies legal facts and rejects stale fences without persistence", () => {
    const admitted: TaskResult = {
      schemaVersion: 4,
      taskId: contract.id,
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "admitted",
      mergeAuthorized: false,
      candidateSha: null,
      candidateFence: null,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      blockerClassification: null,
      waiting: null,
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

  test("requires an authorized merge effect for the merged terminal state", () => {
    const reviewed: TaskResult = {
      schemaVersion: 4,
      taskId: contract.id,
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "reviewed",
      mergeAuthorized: true,
      candidateSha: sha,
      candidateFence: 1,
      check: { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
      review: { sha, verdict: "approved", summary: "approved", findings: [] },
      delivery: null,
      blocker: null,
      blockerClassification: null,
      waiting: null,
      activeActivation: null,
      writer: { repositoryIdentity: "owner/repo" },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 1,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    const delivery = {
      sha,
      effect: "github" as const,
      prNumber: 199,
      url: "https://example.invalid/pr/199",
      attestationId: "attestation",
    };
    expect(() => applyTaskFact(reviewed, { type: "delivery", delivery })).toThrow(
      "delivery is not bound",
    );
    expect(() =>
      applyTaskFact(
        { ...reviewed, mergeAuthorized: false },
        {
          type: "delivery",
          delivery: {
            ...delivery,
            merge: {
              prNumber: 199,
              approvedHeadSha: sha,
              mergeCommitSha: "b".repeat(40),
              observedState: "merged",
            },
          },
        },
      ),
    ).toThrow("delivery is not bound");
    expect(
      applyTaskFact(reviewed, {
        type: "delivery",
        delivery: {
          ...delivery,
          merge: {
            prNumber: 199,
            approvedHeadSha: sha,
            mergeCommitSha: "b".repeat(40),
            observedState: "merged",
          },
        },
      }),
    ).toMatchObject({ state: "merged", delivery: { merge: { mergeCommitSha: "b".repeat(40) } } });
  });
});
