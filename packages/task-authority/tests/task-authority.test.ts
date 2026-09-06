import { describe, expect, test } from "vite-plus/test";
import {
  applyTaskFact,
  canTransition,
  TASK_BLOCKER_CLASSIFICATIONS,
  taskFailureClassFromProvider,
  type TaskResult,
} from "@usine/task-authority";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "authority-module-test" } as TaskContract;

function checkedTask(): TaskResult {
  return {
    schemaVersion: 4,
    taskId: contract.id,
    contractHash: "hash",
    revision: 4,
    deadlineEpochMs: 10_000,
    state: "checked",
    mergeAuthorized: false,
    candidateSha: sha,
    candidateFence: 1,
    check: { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
    review: null,
    delivery: null,
    blocker: null,
    blockerClassification: null,
    waiting: null,
    activeActivation: null,
    writer: { repositoryIdentity: "owner/repo" },
    evidence: {
      implementerActivations: 1,
      reviewCycles: 0,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

describe("Task Authority module contract", () => {
  test.each([
    ["rate_limit", "transient_capacity"],
    ["transport", "protocol"],
    ["transient_transport", "transient_transport"],
    ["network", "network"],
    ["timeout", "timeout"],
    ["configuration", "configuration"],
    ["authority", "authority"],
    ["cancellation", "cancellation"],
    ["unknown", "unknown"],
    ["provider detail with secret", "unknown"],
  ] as const)("sanitizes provider class %s as %s", (providerClass, expected) => {
    expect(taskFailureClassFromProvider(providerClass)).toBe(expected);
  });

  test.each(["approved", "changes_requested"] as const)(
    "rejects a failure class on a %s review",
    (verdict) => {
      expect(() =>
        applyTaskFact(checkedTask(), {
          type: "review",
          review: {
            sha,
            verdict,
            summary: "incomplete review",
            findings: [],
            failureClass: "unknown",
          },
        }),
      ).toThrow("failure class requires an inconclusive verdict");
    },
  );

  test("does not treat cancellation as a terminal blocker classification", () => {
    expect(TASK_BLOCKER_CLASSIFICATIONS).not.toContain("cancellation");
  });

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

  test("keeps an approved delivery waiting until an explicit reconciliation retry", () => {
    const reviewed: TaskResult = {
      schemaVersion: 4,
      taskId: contract.id,
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "reviewed",
      mergeAuthorized: false,
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
    const waiting = applyTaskFact(reviewed, {
      type: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed", activation: 1 },
    });
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed", activation: 1 },
      activeActivation: null,
      candidateSha: sha,
      review: { verdict: "approved" },
    });
    expect(applyTaskFact(waiting, { type: "retry" })).toMatchObject({
      state: "reviewed",
      waiting: null,
      activeActivation: null,
      candidateSha: sha,
      review: { verdict: "approved" },
    });

    expect(() =>
      applyTaskFact(
        { ...reviewed, review: { ...reviewed.review!, verdict: "changes_requested" } },
        {
          type: "waiting",
          waiting: { reason: "delivery_reconciliation", resumeState: "reviewed", activation: 1 },
        },
      ),
    ).toThrow("waiting activation is stale");
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
