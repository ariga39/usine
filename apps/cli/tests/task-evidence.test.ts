import { describe, expect, test } from "vite-plus/test";
import { deriveTaskEvidence, renderTaskEvidence, type TaskEvidence } from "../src/task-evidence.js";
import { decodeTaskEvent, type TaskEvent, type TaskResource } from "@usine/task-authority";

describe("task evidence", () => {
  test("does not treat a matching Candidate SHA as an accepted outcome", () => {
    const taskId = "candidate-only-task";
    const sha = "b".repeat(40);
    const task = {
      taskId,
      state: "candidate",
      candidateSha: sha,
    } as TaskResource;
    const event = (sequence: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `candidate-only-${sequence}`,
        occurredAtEpochMs: sequence,
        data,
      });

    const evidence = deriveTaskEvidence(task, [
      event(1, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
      }),
      event(2, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
      }),
      event(3, { type: "candidate_frozen", sha, fence: 1 }),
    ]);

    expect(evidence.task.relation).toBe("not_yet_accepted");
    expect(evidence.roleRuns.implementer[0]?.outcome).toMatchObject({
      candidateSha: sha,
      taskRelation: "not_yet_accepted",
    });
  });

  test("preserves archive completeness and does not infer it from legacy capture status", () => {
    const taskId = "archive-completeness-task";
    const task = { taskId, state: "admitted", candidateSha: null } as TaskResource;
    const event = (sequence: number, archive: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `archive-completeness-${sequence}`,
        occurredAtEpochMs: sequence,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: sequence,
          outcome: "succeeded",
          sessionId: `coding-session:${sequence}:implementer`,
          archive,
        },
      });

    const evidence = deriveTaskEvidence(task, [
      event(1, {
        archiveId: "archive_partial",
        status: "stored",
        completeness: "partial",
      }),
      event(2, {
        archiveId: "archive_failed",
        status: "failed",
        completeness: "complete",
      }),
      event(3, { archiveId: "archive_legacy", status: "stored" }),
    ]);

    expect(evidence.roleRuns.implementer.map((run) => run.archive)).toEqual([
      { archiveId: "archive_partial", status: "partial" },
      { archiveId: "archive_failed", status: "unavailable" },
      { archiveId: "archive_legacy", status: "unavailable" },
    ]);
  });

  test("identifies reviewer runs by explicit review cycle, not Candidate fence or opaque ID", () => {
    const taskId = "review-cycle-task";
    const sha = "c".repeat(40);
    const task = {
      taskId,
      state: "reviewed",
      candidateSha: sha,
      check: { sha, status: "passed", exitCode: 0 },
      review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
    } as TaskResource;
    const event = (sequence: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `review-cycle-${sequence}`,
        occurredAtEpochMs: sequence,
        data,
      });

    const evidence = deriveTaskEvidence(task, [
      event(1, { type: "candidate_frozen", sha, fence: 7 }),
      event(2, {
        type: "coding_session_started",
        role: "reviewer",
        activation: 7,
        reviewCycle: 2,
        sessionId: "opaque-provider-correlation",
      }),
      event(3, {
        type: "coding_session_completed",
        role: "reviewer",
        activation: 7,
        reviewCycle: 2,
        outcome: "succeeded",
        sessionId: "opaque-provider-correlation",
      }),
      event(4, { type: "review_completed", sha, cycle: 2, verdict: "approved" }),
    ]);

    expect(evidence.roleRuns.reviewer[0]).toMatchObject({
      role: "reviewer",
      activation: null,
      reviewCycle: 2,
      outcome: { candidateSha: sha, taskRelation: "accepted_exact_sha" },
    });
  });

  test("projects old optional session fields as unknown or unavailable and binds role runs to the exact SHA", () => {
    const taskId = "history-evidence-task";
    const sha = "a".repeat(40);
    const event = (sequence: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `event-${sequence}`,
        occurredAtEpochMs: sequence,
        data,
      });
    const task = {
      taskId,
      state: "reviewed_pr",
      candidateSha: sha,
      check: { sha, status: "passed", exitCode: 0 },
      review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
    } as TaskResource;
    const evidence = deriveTaskEvidence(task, [
      event(1, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
      }),
      event(2, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
      }),
      event(3, {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:tool:stable",
        tool: "shell",
        outcome: "succeeded",
      }),
      event(4, {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:tool:stable",
        tool: "shell",
        outcome: "succeeded",
      }),
      event(5, {
        type: "candidate_frozen",
        sha,
        fence: 1,
      }),
      event(6, {
        type: "coding_session_started",
        role: "reviewer",
        activation: 1,
        reviewCycle: 1,
        sessionId: "review-session:1:reviewer",
      }),
      event(7, {
        type: "coding_session_completed",
        role: "reviewer",
        activation: 1,
        reviewCycle: 1,
        outcome: "succeeded",
        sessionId: "review-session:1:reviewer",
      }),
      event(8, { type: "review_completed", sha, cycle: 1, verdict: "approved" }),
    ]);

    expect(evidence.roleRuns.implementer[0]).toMatchObject({
      requestedProfile: null,
      effectiveProfile: {
        profileName: null,
        configSha256: null,
        adapter: null,
        model: null,
        modelProvider: null,
        reasoningEffort: null,
        developerInstructionsSha256: null,
      },
      usage: null,
      archive: { archiveId: null, status: "unavailable" },
      outcome: { candidateSha: sha, taskRelation: "accepted_exact_sha" },
    });
    expect(evidence.roleRuns.implementer[0]?.effort.observations).toHaveLength(1);
    expect(evidence.roleRuns.reviewer[0]?.outcome).toMatchObject({
      candidateSha: sha,
      taskRelation: "accepted_exact_sha",
    });
    expect(renderTaskEvidence(evidence, false)).toContain("requested-profile=unknown");
    expect(renderTaskEvidence(evidence, false)).toContain("archive=unavailable (unavailable)");
  });

  test("renders separate implementer and reviewer Role Runs for one exact Task outcome", () => {
    const evidence: TaskEvidence = {
      schemaVersion: 1,
      taskId: "evidence-task",
      roleRuns: {
        implementer: [
          {
            role: "implementer",
            activation: 1,
            reviewCycle: null,
            requestedProfile: "writer-profile",
            effectiveProfile: {
              profileName: "writer-profile",
              configSha256: "1".repeat(64),
              adapter: "sdk",
              model: "writer-model",
              modelProvider: "openai",
              reasoningEffort: "low",
              developerInstructionsSha256: "2".repeat(64),
            },
            effort: {
              phase: "output",
              failureClass: null,
              observations: [{ type: "turn_completed", turn: 1, outcome: "succeeded" }],
            },
            usage: { inputTokens: 12, outputTokens: 7 },
            archive: { archiveId: "archive_writer", status: "complete" },
            outcome: {
              status: "succeeded",
              candidateSha: "a".repeat(40),
              taskRelation: "accepted_exact_sha",
            },
          },
        ],
        reviewer: [
          {
            role: "reviewer",
            activation: 1,
            reviewCycle: 1,
            requestedProfile: "review-profile",
            effectiveProfile: {
              profileName: "review-profile",
              configSha256: "3".repeat(64),
              adapter: "app-server",
              model: "review-model",
              modelProvider: "openai",
              reasoningEffort: "high",
              developerInstructionsSha256: "4".repeat(64),
            },
            effort: {
              phase: "output",
              failureClass: null,
              observations: [{ type: "turn_completed", turn: 1, outcome: "succeeded" }],
            },
            usage: { inputTokens: 5, outputTokens: 3 },
            archive: { archiveId: "archive_reviewer", status: "complete" },
            outcome: {
              status: "succeeded",
              candidateSha: "a".repeat(40),
              taskRelation: "accepted_exact_sha",
            },
          },
        ],
      },
      task: {
        state: "reviewed_pr",
        candidateSha: "a".repeat(40),
        relation: "accepted_exact_sha",
      },
    };

    expect(JSON.parse(renderTaskEvidence(evidence, true))).toEqual(evidence);
    expect(renderTaskEvidence(evidence, false)).toContain("IMPLEMENTER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("REVIEWER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("accepted_exact_sha");
  });
});
