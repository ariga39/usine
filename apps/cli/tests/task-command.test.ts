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

function event(
  taskId: string,
  sequence: number,
  data: TaskEvent["data"],
  occurredAtEpochMs = sequence,
): TaskEvent {
  return {
    taskId,
    sequence,
    eventId: `pagination-${sequence}`,
    occurredAtEpochMs,
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
    const originalWrite = process.stdout.write.bind(process.stdout);
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
    const originalWrite = process.stdout.write.bind(process.stdout);
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

  test("reports the complete role evidence join through the public command path", async () => {
    const taskId = "command-role-evidence-task";
    const staleSha = "c".repeat(40);
    const acceptedSha = "d".repeat(40);
    const currentTask = {
      ...task(taskId, acceptedSha),
      state: "reviewed_pr",
      evidence: { ...task(taskId, acceptedSha).evidence, changesRequestedBatches: 1 },
      delivery: {
        sha: acceptedSha,
        effect: "github" as const,
        prNumber: 42,
        url: "https://example.invalid/pr/42",
        attestationId: "private-attestation",
        merge: null,
      },
    } satisfies TaskResource;
    const initialTask = {
      ...currentTask,
      state: "candidate",
      check: null,
      review: null,
      delivery: null,
    } satisfies TaskResource;
    const history: TaskEvent[] = [
      event(taskId, 1, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        requestedProfile: "writer-profile",
        sessionId: "coding-session:1:implementer",
      }),
      event(taskId, 2, {
        type: "coding_turn_started",
        role: "implementer",
        activation: 1,
        turn: 1,
        sessionId: "coding-session:1:implementer",
      }),
      event(taskId, 3, {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:tool",
        tool: "shell",
        outcome: "succeeded",
      }),
      event(taskId, 4, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
        usage: { inputTokens: 12, outputTokens: 7 },
        archive: {
          archiveId: "archive_11111111-1111-1111-1111-111111111111",
          status: "stored",
          completeness: "complete",
        },
      }),
      event(taskId, 5, { type: "candidate_frozen", sha: staleSha, fence: 1 }),
      event(taskId, 6, { type: "repair_batch_recorded", cycle: 1 }),
      event(
        taskId,
        7,
        {
          type: "coding_session_started",
          role: "implementer",
          activation: 2,
          requestedProfile: "writer-profile",
          sessionId: "coding-session:2:implementer",
        },
        3_000,
      ),
      event(
        taskId,
        8,
        {
          type: "coding_session_interrupted",
          role: "implementer",
          activation: 2,
          sessionId: "coding-session:2:implementer",
          phase: "turn",
          failureClass: "network",
        },
        3_001,
      ),
      event(
        taskId,
        9,
        {
          type: "coding_session_completed",
          role: "implementer",
          activation: 2,
          outcome: "succeeded",
          sessionId: "coding-session:2:implementer",
          usage: null,
          archive: {
            archiveId: "archive_22222222-2222-2222-2222-222222222222",
            status: "pruned",
            completeness: "partial",
          },
        },
        3_002,
      ),
      event(taskId, 10, { type: "candidate_frozen", sha: acceptedSha, fence: 2 }),
      event(
        taskId,
        11,
        {
          type: "coding_session_started",
          role: "reviewer",
          activation: 2,
          reviewCycle: 1,
          requestedProfile: "reviewer-profile",
          sessionId: "review-session:1:reviewer",
        },
        4_000,
      ),
      event(
        taskId,
        12,
        {
          type: "coding_mcp_tool_completed",
          role: "reviewer",
          activation: 2,
          sessionId: "review-session:1:reviewer",
          outcomeId: "review:1:mcp",
          server: "github_read_reviewer",
          tool: "github_pull_request_reviews",
          outcome: "succeeded",
        },
        4_001,
      ),
      event(
        taskId,
        13,
        {
          type: "coding_session_completed",
          role: "reviewer",
          activation: 2,
          reviewCycle: 1,
          outcome: "succeeded",
          sessionId: "review-session:1:reviewer",
          usage: null,
          archive: {
            archiveId: "archive_33333333-3333-3333-3333-333333333333",
            status: "pruned",
            completeness: "partial",
          },
        },
        4_002,
      ),
      event(taskId, 14, {
        type: "review_completed",
        sha: acceptedSha,
        cycle: 1,
        verdict: "approved",
      }),
      event(taskId, 15, {
        type: "delivery_completed",
        sha: acceptedSha,
        prNumber: 42,
        merged: false,
      }),
    ];
    let taskReads = 0;
    const originalFetch = globalThis.fetch;
    const output: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith(`/v1/tasks/${taskId}`)) {
        taskReads += 1;
        return new Response(JSON.stringify(taskReads === 1 ? initialTask : currentTask), {
          status: 200,
        });
      }
      if (url.pathname.endsWith(`/v1/tasks/${taskId}/events`))
        return new Response(JSON.stringify({ taskId, events: history, nextSequence: 15 }), {
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
      task: {
        relation: string;
        candidateSha: string | null;
        check: unknown;
        review: unknown;
        repairBatches: number | null;
        delivery: { sha: string; prNumber: number; merged: boolean } | null;
      };
      roleRuns: {
        implementer: Array<{
          usage: unknown;
          archive: unknown;
          outcome: { candidateSha: string | null; taskRelation: string };
          effort: {
            elapsedMs: number | null;
            counts: { turns: number; tools: number; mcpTools: number };
            phase: string | null;
            failureClass: string | null;
          };
        }>;
        reviewer: Array<{
          usage: unknown;
          archive: unknown;
          outcome: { taskRelation: string };
          effort: {
            elapsedMs: number | null;
            counts: { turns: number; tools: number; mcpTools: number };
          };
        }>;
      };
    };
    expect(taskReads).toBe(2);
    expect(evidence.task).toMatchObject({
      relation: "accepted_exact_sha",
      candidateSha: acceptedSha,
      check: { sha: acceptedSha, status: "passed" },
      review: { sha: acceptedSha, verdict: "approved" },
      repairBatches: 1,
      delivery: { sha: acceptedSha, prNumber: 42, merged: false },
    });
    expect(evidence.roleRuns.implementer).toHaveLength(2);
    expect(evidence.roleRuns.reviewer).toHaveLength(1);
    expect(evidence.roleRuns.implementer[0]).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 7 },
      archive: { status: "complete" },
      outcome: { candidateSha: staleSha, taskRelation: "different_sha" },
      effort: { elapsedMs: 3, counts: { turns: 1, tools: 1, mcpTools: 0 } },
    });
    expect(evidence.roleRuns.implementer[1]).toMatchObject({
      usage: null,
      archive: { status: "unavailable" },
      outcome: { candidateSha: acceptedSha, taskRelation: "accepted_exact_sha" },
      effort: {
        elapsedMs: 2,
        counts: { turns: 0, tools: 0, mcpTools: 0 },
        phase: "turn",
        failureClass: "network",
      },
    });
    expect(evidence.roleRuns.reviewer[0]).toMatchObject({
      usage: null,
      archive: { status: "unavailable" },
      outcome: { taskRelation: "accepted_exact_sha" },
      effort: { elapsedMs: 2, counts: { turns: 0, tools: 0, mcpTools: 1 } },
    });
  });
});
