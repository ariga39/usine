import { describe, expect, test } from "vite-plus/test";
import type { TaskEvent, TaskResource } from "@usine/task-authority";
import { runTaskEvidenceCommand } from "../src/task-command.js";

function task(taskId: string, sha: string): TaskResource {
  return {
    schemaVersion: 3,
    taskId,
    contractHash: "d".repeat(64),
    revision: 9,
    deadlineEpochMs: Date.now() + 30_000,
    state: "reviewed_pr",
    mergeAuthorized: false,
    candidateSha: sha,
    candidateFence: 1,
    check: { sha, status: "passed", exitCode: 0 },
    review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
    delivery: null,
    blocker: null,
    waiting: null,
    retryable: false,
    activeActivation: null,
    writer: { repositoryIdentity: "example/repository" },
    evidence: {
      implementerActivations: 1,
      reviewCycles: 1,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function event(taskId: string, sequence: number, data: TaskEvent["data"]): TaskEvent {
  return {
    taskId,
    sequence,
    eventId: `pagination-${sequence}`,
    occurredAtEpochMs: sequence,
    data,
  };
}

describe("task evidence command", () => {
  test("rereads current Task facts after draining history", async () => {
    const taskId = "refresh-evidence-task";
    const sha = "f".repeat(40);
    const initialTask = {
      ...task(taskId, sha),
      state: "candidate",
      check: null,
      review: null,
      delivery: null,
    } satisfies TaskResource;
    const currentTask = task(taskId, sha);
    const history = [
      event(taskId, 1, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
      }),
    ];
    let taskReads = 0;
    const originalFetch = globalThis.fetch;
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith(`/v1/tasks/${taskId}`)) {
        taskReads += 1;
        return new Response(JSON.stringify(taskReads === 1 ? initialTask : currentTask), {
          status: 200,
        });
      }
      if (url.pathname.endsWith(`/v1/tasks/${taskId}/events`))
        return new Response(JSON.stringify({ taskId, events: history, nextSequence: 1 }), {
          status: 200,
        });
      return new Response("not found", { status: 404 });
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runTaskEvidenceCommand({ taskId, json: true }, "http://server.test");
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalWrite;
    }

    const evidence = JSON.parse(output.join("")) as {
      task: { relation: string; state: string; check: unknown; review: unknown };
    };
    expect(taskReads).toBe(2);
    expect(evidence.task).toMatchObject({
      relation: "accepted_exact_sha",
      state: "reviewed_pr",
      check: { sha, status: "passed" },
      review: { sha, verdict: "approved" },
    });
  });

  test("drains overlapping history pages into one report using current Task facts", async () => {
    const taskId = "paginated-evidence-task";
    const sha = "e".repeat(40);
    const currentTask = task(taskId, sha);
    const firstPage = [
      event(taskId, 1, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        requestedProfile: "writer-profile",
        sessionId: "coding-session:1:implementer",
      }),
      event(taskId, 2, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
      }),
      event(taskId, 3, { type: "candidate_frozen", sha, fence: 1 }),
      ...Array.from({ length: 197 }, (_, index) =>
        event(taskId, index + 4, { type: "recovery_observed", kind: "server_restart" }),
      ),
    ];
    const secondPage = [
      firstPage.at(-1)!,
      event(taskId, 201, {
        type: "coding_session_started",
        role: "reviewer",
        activation: 1,
        reviewCycle: 1,
        sessionId: "opaque-review-correlation",
      }),
      event(taskId, 202, {
        type: "coding_session_completed",
        role: "reviewer",
        activation: 1,
        reviewCycle: 1,
        outcome: "succeeded",
        sessionId: "opaque-review-correlation",
      }),
      event(taskId, 203, { type: "review_completed", sha, cycle: 1, verdict: "approved" }),
    ];
    const requestedAfter: number[] = [];
    const originalFetch = globalThis.fetch;
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith(`/v1/tasks/${taskId}`))
        return new Response(JSON.stringify(currentTask), { status: 200 });
      if (url.pathname.endsWith(`/v1/tasks/${taskId}/events`)) {
        const after = Number(url.searchParams.get("after"));
        requestedAfter.push(after);
        const page = after === 0 ? firstPage : secondPage;
        return new Response(
          JSON.stringify({ taskId, events: page, nextSequence: page.at(-1)?.sequence ?? after }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runTaskEvidenceCommand({ taskId, json: true }, "http://server.test");
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalWrite;
    }

    const evidence = JSON.parse(output.join("")) as {
      task: { relation: string; candidateSha: string | null };
      roleRuns: { implementer: unknown[]; reviewer: unknown[] };
    };
    expect(requestedAfter).toEqual([0, 200]);
    expect(evidence.task).toMatchObject({ relation: "accepted_exact_sha", candidateSha: sha });
    expect(evidence.roleRuns.implementer).toHaveLength(1);
    expect(evidence.roleRuns.reviewer).toHaveLength(1);
  });
});
