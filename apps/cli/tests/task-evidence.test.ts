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
      event(4, { archiveId: "archive_pruned", status: "pruned", completeness: "partial" }),
      event(5, { archiveId: "archive_truncated_legacy", status: "truncated" }),
    ]);

    expect(evidence.roleRuns.implementer.map((run) => run.archive)).toEqual([
      { archiveId: "archive_partial", status: "partial" },
      { archiveId: "archive_failed", status: "unavailable" },
      { archiveId: "archive_legacy", status: "unavailable" },
      { archiveId: "archive_pruned", status: "unavailable" },
      { archiveId: "archive_truncated_legacy", status: "unavailable" },
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

  test("derives elapsed effort and bounded turn/tool observations without double counting", () => {
    const taskId = "effort-evidence-task";
    const event = (sequence: number, occurredAtEpochMs: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `effort-${sequence}`,
        occurredAtEpochMs,
        data,
      });
    const evidence = deriveTaskEvidence(
      { taskId, state: "admitted", candidateSha: null } as TaskResource,
      [
        event(1, 1_000, {
          type: "coding_session_started",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
        }),
        event(2, 1_100, {
          type: "coding_thread_started",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
        }),
        event(3, 1_200, {
          type: "coding_turn_started",
          role: "implementer",
          activation: 1,
          turn: 1,
          sessionId: "coding-session:1:implementer",
        }),
        event(4, 1_300, {
          type: "coding_tool_completed",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
          outcomeId: "effort:tool:1",
          tool: "shell",
          outcome: "succeeded",
        }),
        event(5, 1_400, {
          type: "coding_mcp_tool_completed",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
          outcomeId: "effort:mcp:1",
          server: "github_read",
          tool: "github_issue_get",
          outcome: "succeeded",
        }),
        event(6, 1_500, {
          type: "coding_turn_completed",
          role: "implementer",
          activation: 1,
          turn: 1,
          sessionId: "coding-session:1:implementer",
          outcomeId: "effort:turn:1",
          outcome: "succeeded",
        }),
        event(7, 1_600, {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: "coding-session:1:implementer",
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
        event(8, 1_700, {
          type: "coding_tool_completed",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
          outcomeId: "effort:tool:1",
          tool: "shell",
          outcome: "succeeded",
        }),
      ],
    );

    expect(evidence.roleRuns.implementer[0]).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4 },
      effort: {
        elapsedMs: 600,
        counts: { turns: 1, tools: 1, mcpTools: 1 },
      },
    });
  });

  test("consumes completion enrichment after interruption without counting later effort", () => {
    const taskId = "interrupted-evidence-task";
    const event = (sequence: number, occurredAtEpochMs: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `interrupted-${sequence}`,
        occurredAtEpochMs,
        data,
      });
    const evidence = deriveTaskEvidence(
      { taskId, state: "blocked", candidateSha: null } as TaskResource,
      [
        event(1, 1_000, {
          type: "coding_session_started",
          role: "implementer",
          activation: 1,
          requestedProfile: "writer-profile",
          sessionId: "coding-session:1:implementer",
        }),
        event(2, 1_200, {
          type: "coding_turn_started",
          role: "implementer",
          activation: 1,
          turn: 1,
          sessionId: "coding-session:1:implementer",
        }),
        event(3, 1_300, {
          type: "coding_session_interrupted",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
          phase: "turn",
          failureClass: "network",
        }),
        event(4, 1_600, {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "failed",
          sessionId: "coding-session:1:implementer",
          requestedProfile: "writer-profile",
          usage: { inputTokens: 8, outputTokens: 2 },
          archive: {
            archiveId: "archive_interrupted",
            status: "failed",
            completeness: "partial",
          },
        }),
        event(5, 1_900, {
          type: "coding_tool_completed",
          role: "implementer",
          activation: 1,
          sessionId: "coding-session:1:implementer",
          outcomeId: "interrupted:tool:after",
          tool: "shell",
          outcome: "succeeded",
        }),
      ],
    );

    expect(evidence.roleRuns.implementer[0]).toMatchObject({
      requestedProfile: "writer-profile",
      usage: { inputTokens: 8, outputTokens: 2 },
      archive: { archiveId: "archive_interrupted", status: "unavailable" },
      outcome: { status: "failed" },
      effort: {
        elapsedMs: 600,
        counts: { turns: 1, tools: 0, mcpTools: 0 },
      },
    });
  });

  test("preserves the requested profile through pre-resolution failure and completion recovery", () => {
    const taskId = "profile-resolution-failure-task";
    const event = (sequence: number, occurredAtEpochMs: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `profile-resolution-${sequence}`,
        occurredAtEpochMs,
        data,
      });
    const evidence = deriveTaskEvidence(
      { taskId, state: "blocked", candidateSha: null } as TaskResource,
      [
        event(1, 1_000, {
          type: "coding_session_started",
          role: "reviewer",
          activation: 1,
          reviewCycle: 1,
          requestedProfile: "reviewer-profile",
          sessionId: "review-session:1:reviewer",
        }),
        event(2, 1_100, {
          type: "coding_session_interrupted",
          role: "reviewer",
          activation: 1,
          sessionId: "review-session:1:reviewer",
          phase: "startup",
          failureClass: "configuration",
        }),
        event(3, 1_200, {
          type: "coding_session_completed",
          role: "reviewer",
          activation: 1,
          reviewCycle: 1,
          outcome: "failed",
          sessionId: "review-session:1:reviewer",
          requestedProfile: "reviewer-profile",
          usage: null,
          archive: {
            archiveId: "archive_profile_failure",
            status: "failed",
            completeness: "partial",
          },
        }),
      ],
    );

    expect(evidence.roleRuns.reviewer[0]).toMatchObject({
      requestedProfile: "reviewer-profile",
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
      archive: { archiveId: "archive_profile_failure", status: "unavailable" },
      outcome: { status: "failed", taskRelation: "not_observed" },
      effort: { elapsedMs: 200, counts: { turns: 0, tools: 0, mcpTools: 0 } },
    });
  });

  test("keeps configured and provider-attested identities distinct", () => {
    const taskId = "identity-provenance-task";
    const event = (sequence: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `identity-provenance-${sequence}`,
        occurredAtEpochMs: sequence,
        data,
      });
    const configured = {
      profileName: "implementer-profile",
      configSha256: "a".repeat(64),
      adapter: "sdk",
      configuredModel: "configured-model",
      configuredProvider: "configured-provider",
      model: "configured-model",
      modelProvider: "configured-provider",
      reasoningEffort: "high",
      developerInstructionsSha256: null,
      serviceTier: "standard",
    };
    const observed = deriveTaskEvidence({ taskId, state: "admitted" } as TaskResource, [
      event(1, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "identity-session",
        effectiveProfile: {
          ...configured,
          actualModel: "provider-model",
          actualProvider: "provider-name",
          actualModelProvider: "provider-name",
        },
      }),
    ]);
    const omitted = deriveTaskEvidence({ taskId, state: "admitted" } as TaskResource, [
      event(1, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "identity-session",
        effectiveProfile: configured,
      }),
    ]);

    expect(observed.roleRuns.implementer[0]?.effectiveProfile).toMatchObject({
      configuredModel: "configured-model",
      configuredProvider: "configured-provider",
      model: "configured-model",
      modelProvider: "configured-provider",
      actualModel: "provider-model",
      actualProvider: "provider-name",
      actualModelProvider: "provider-name",
    });
    expect(omitted.roleRuns.implementer[0]?.effectiveProfile).toMatchObject({
      configuredModel: "configured-model",
      configuredProvider: "configured-provider",
      model: "configured-model",
      modelProvider: "configured-provider",
      actualModel: null,
      actualProvider: null,
      actualModelProvider: null,
    });
    expect(JSON.parse(renderTaskEvidence(observed, true))).toMatchObject({
      roleRuns: {
        implementer: [
          {
            effectiveProfile: {
              configuredModel: "configured-model",
              configuredProvider: "configured-provider",
              actualModel: "provider-model",
              actualProvider: "provider-name",
            },
          },
        ],
      },
    });
    expect(renderTaskEvidence(omitted, false)).toContain(
      "configured-model=configured-model configured-provider=configured-provider actual-model=unavailable actual-provider=unavailable",
    );
  });

  test("joins successful Role Runs to current Task facts across a repaired Candidate", () => {
    const taskId = "repair-join-task";
    const staleSha = "f".repeat(40);
    const acceptedSha = "0".repeat(40);
    const task = {
      taskId,
      state: "reviewed_pr",
      candidateSha: acceptedSha,
      candidateFence: 2,
      check: { sha: acceptedSha, status: "passed", exitCode: 0 },
      review: {
        sha: acceptedSha,
        verdict: "approved",
        classification: "approved",
        findingCount: 1,
      },
      delivery: {
        sha: acceptedSha,
        effect: "github",
        prNumber: 42,
        url: "https://github.com/example/repository/pull/42",
        attestationId: "attestation-42",
        merge: null,
      },
      evidence: { changesRequestedBatches: 1 },
    } as TaskResource;
    const event = (sequence: number, data: unknown): TaskEvent =>
      decodeTaskEvent({
        taskId,
        sequence,
        eventId: `repair-join-${sequence}`,
        occurredAtEpochMs: sequence,
        data,
      });
    const sessionEvents = (activation: number, sequence: number) => [
      event(sequence, {
        type: "coding_session_started",
        role: "implementer",
        activation,
        sessionId: `coding-session:${activation}:implementer`,
      }),
      event(sequence + 1, {
        type: "coding_session_completed",
        role: "implementer",
        activation,
        outcome: "succeeded",
        sessionId: `coding-session:${activation}:implementer`,
      }),
    ];

    const evidence = deriveTaskEvidence(task, [
      ...sessionEvents(1, 1),
      event(3, { type: "candidate_frozen", sha: staleSha, fence: 1 }),
      ...sessionEvents(2, 4),
      event(6, { type: "candidate_frozen", sha: acceptedSha, fence: 2 }),
    ]);

    expect(evidence.roleRuns.implementer.map((run) => run.outcome)).toEqual([
      { status: "succeeded", candidateSha: staleSha, taskRelation: "different_sha" },
      { status: "succeeded", candidateSha: acceptedSha, taskRelation: "accepted_exact_sha" },
    ]);
    expect(evidence.task).toMatchObject({
      state: "reviewed_pr",
      candidateSha: acceptedSha,
      candidateFence: 2,
      check: { sha: acceptedSha, status: "passed", exitCode: 0 },
      review: { sha: acceptedSha, verdict: "approved", findingCount: 1 },
      repairBatches: 1,
      delivery: { sha: acceptedSha, prNumber: 42 },
    });
    const rendered = renderTaskEvidence(evidence, false);
    expect(rendered).toContain(`Task candidate: ${acceptedSha} fence=2`);
    expect(rendered).toContain(`Task check: passed ${acceptedSha} exit=0`);
    expect(rendered).toContain(`Task review: approved ${acceptedSha} findings=1`);
    expect(rendered).toContain("Task repair batches: 1");
    expect(rendered).toContain(`Task delivery: github ${acceptedSha} pr=42 merged=false`);
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
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:tool:stable",
        tool: "shell",
        outcome: "succeeded",
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
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
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

  test("keeps the bounded interruption class in Task evidence and prose", () => {
    const taskId = "review-interruption-evidence-task";
    const task = {
      taskId,
      state: "blocked",
      candidateSha: null,
      review: {
        sha: "a".repeat(40),
        verdict: "inconclusive",
        classification: "inconclusive",
        findingCount: 0,
        failureClass: "transient_capacity",
      },
    } as TaskResource;
    const event = decodeTaskEvent({
      taskId,
      sequence: 1,
      eventId: "review-interruption-evidence",
      occurredAtEpochMs: 1,
      data: {
        type: "coding_session_interrupted",
        role: "reviewer",
        activation: 1,
        sessionId: "review-session",
        phase: "turn",
        failureClass: "rate_limit",
      },
    });

    const evidence = deriveTaskEvidence(task, [event]);
    expect(evidence.roleRuns.reviewer[0]).toMatchObject({
      outcome: { status: "failed" },
      effort: { failureClass: "transient_capacity" },
    });
    expect(evidence.task.review).toMatchObject({ failureClass: "transient_capacity" });
    const rendered = renderTaskEvidence(evidence, false);
    expect(rendered).toContain("failure-class=transient_capacity");
    expect(rendered).not.toContain("rate_limit");
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
              adapter: "opencode2",
              model: "writer-model",
              modelProvider: "openai",
              reasoningEffort: "low",
              developerInstructionsSha256: "2".repeat(64),
            },
            effort: {
              elapsedMs: 0,
              counts: { turns: 0, tools: 0, mcpTools: 0 },
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
              elapsedMs: 0,
              counts: { turns: 0, tools: 0, mcpTools: 0 },
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
        candidateFence: null,
        check: null,
        review: null,
        repairBatches: null,
        delivery: null,
        relation: "accepted_exact_sha",
      },
    };

    expect(JSON.parse(renderTaskEvidence(evidence, true))).toEqual(evidence);
    expect(renderTaskEvidence(evidence, false)).toContain("IMPLEMENTER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("REVIEWER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("adapter=opencode2");
    expect(renderTaskEvidence(evidence, false)).toContain("accepted_exact_sha");
  });
});
