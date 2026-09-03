import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  deriveUsageReport,
  listUsageReportSources,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskEvent,
  type TaskResult,
  type UsageReportSource,
} from "../src/index.js";

const handles: Array<{ close: () => void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

const repository = {
  id: "usage-repository",
  path: "/tmp/repository",
  owner: "owner",
  name: "repository",
  baseBranch: "main",
  projectCheck: { command: "true", timeoutMs: 1_000 },
  gitAuthor: { name: "Usine", email: "usine@example.test" },
};
const repositoryRegistration = {
  ...repository,
  implementerProfile: "implementer-profile",
  reviewerProfile: "reviewer-profile",
  forgeProfile: "forge-profile",
  githubReadProfile: null,
};

function task(taskId = "usage-task"): TaskResult {
  return {
    schemaVersion: 4,
    taskId,
    contractHash: "a".repeat(64),
    revision: 1,
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
    activeActivation: null,
    writer: { repositoryIdentity: "owner/repository" },
    repository,
    evidence: {
      implementerActivations: 0,
      reviewCycles: 0,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function event(
  taskId: string,
  sequence: number,
  occurredAtEpochMs: number,
  data: TaskEvent["data"],
): TaskEvent {
  return {
    taskId,
    sequence,
    eventId: `usage-event-${taskId}-${sequence}`,
    occurredAtEpochMs,
    data,
  };
}

function successfulSource(): UsageReportSource {
  const taskId = "usage-task";
  return {
    task: task(taskId),
    events: [
      event(taskId, 1, 100, {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        sessionId: "session-1",
        requestedProfile: "profile-1",
      }),
      event(taskId, 2, 101, {
        type: "coding_usage_observed",
        role: "implementer",
        activation: 1,
        sessionId: "session-1",
        source: "provider",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          uncachedInputTokens: 7,
          cacheWriteInputTokens: 4,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
      }),
      event(taskId, 3, 102, {
        type: "coding_usage_observed",
        role: "implementer",
        activation: 1,
        sessionId: "session-1",
        source: "role_output_normalizer",
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
      event(taskId, 4, 103, {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "session-1",
        requestedProfile: "profile-1",
        effectiveProfile: {
          profileName: "profile-1",
          configSha256: "b".repeat(64),
          adapter: "sdk",
          model: "model-1",
          modelProvider: "provider-1",
          reasoningEffort: "high",
          developerInstructionsSha256: null,
          serviceTier: "standard",
        },
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          uncachedInputTokens: 7,
          cacheWriteInputTokens: 4,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        normalizer: {
          status: "succeeded",
          adapter: "role-output-normalizer",
          model: "normalizer-model",
          modelProvider: "normalizer-provider",
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      }),
    ],
  };
}

describe("usage report projection", () => {
  test("retains detailed successful, partial, unavailable, and normalizer rows without double counting", () => {
    const partialTaskId = "partial-task";
    const unavailableTaskId = "unavailable-task";
    const sources: UsageReportSource[] = [
      successfulSource(),
      {
        task: task(partialTaskId),
        events: [
          event(partialTaskId, 1, 200, {
            type: "coding_session_started",
            role: "reviewer",
            activation: 0,
            reviewCycle: 1,
            sessionId: "review-1",
          }),
          event(partialTaskId, 2, 201, {
            type: "coding_usage_observed",
            role: "reviewer",
            activation: 0,
            reviewCycle: 1,
            sessionId: "review-1",
            source: "provider",
            usage: { inputTokens: 4, outputTokens: 2 },
          }),
          event(partialTaskId, 3, 202, {
            type: "coding_session_interrupted",
            role: "reviewer",
            activation: 0,
            sessionId: "review-1",
            phase: "turn",
            failureClass: "cancellation",
          }),
        ],
      },
      {
        task: task(unavailableTaskId),
        events: [
          event(unavailableTaskId, 1, 300, {
            type: "coding_session_started",
            role: "implementer",
            activation: 1,
            sessionId: "unavailable-1",
          }),
          event(unavailableTaskId, 2, 301, {
            type: "coding_session_completed",
            role: "implementer",
            activation: 1,
            outcome: "failed",
            sessionId: "unavailable-1",
            usage: null,
          }),
        ],
      },
    ];
    const report = deriveUsageReport(sources, {
      taskId: null,
      repositoryId: "usage-repository",
      fromEpochMs: null,
      toEpochMs: null,
    });

    expect(report.invocations).toHaveLength(4);
    const providerRow = report.invocations.find((row) => row.adapter === "sdk");
    const normalizerRow = report.invocations.find(
      (row) => row.adapter === "role-output-normalizer",
    );
    const partialRow = report.invocations.find((row) => row.taskId === partialTaskId);
    const unavailableRow = report.invocations.find((row) => row.taskId === unavailableTaskId);
    expect(providerRow).toMatchObject({
      role: "implementer",
      profile: "profile-1",
      provider: "provider-1",
      adapter: "sdk",
      model: "model-1",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 3,
        uncachedInputTokens: 7,
        cacheWriteInputTokens: 4,
        outputTokens: 5,
        reasoningOutputTokens: 2,
        coverage: "complete",
      },
    });
    expect(normalizerRow).toMatchObject({
      adapter: "role-output-normalizer",
      model: "normalizer-model",
      usage: { inputTokens: 2, outputTokens: 1, coverage: "partial" },
    });
    expect(partialRow).toMatchObject({
      outcome: "cancelled",
      usage: { inputTokens: 4, outputTokens: 2, coverage: "partial" },
    });
    expect(unavailableRow?.usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      coverage: "unavailable",
    });
    expect(report.coverage).toBe("partial");
    expect(report.aggregates).toHaveLength(4);
  });

  test("uses persisted Task events beyond the capped task list and reloads complete streams for ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-usage-report-"));
    const path = join(directory, "state.sqlite");
    await applyMigrations(path);
    const handle = openSqliteDatabase(path);
    handles.push(handle);
    const authority = new TaskAuthority(handle.database);
    const contractFor = (taskId: string): TaskContract => ({
      id: taskId,
      repositoryId: repository.id,
      baseSha: "a".repeat(40),
      instructions: "usage",
      acceptance: ["usage"],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
      authorization: { source: "https://github.com/example/repository/issues/1", delivery: true },
      delivery: { branch: `usage-${taskId}`, issue: 1, title: "usage", body: "usage" },
    });
    for (let index = 0; index < 205; index += 1) {
      const taskId = `usage-many-${index}`;
      await authority.admit({
        contract: contractFor(taskId),
        contractHash: "a".repeat(64),
        repositoryIdentity: `owner/repository-${index}`,
        repository: repositoryRegistration,
        deadlineEpochMs: 10_000,
      });
      await authority.appendObservation(taskId, {
        eventId: `usage-many-start-${index}`,
        occurredAtEpochMs: 100,
        data: {
          type: "coding_session_started",
          role: "implementer",
          activation: 1,
          sessionId: `many-session-${index}`,
        },
      });
      await authority.appendObservation(taskId, {
        eventId: `usage-many-complete-${index}`,
        occurredAtEpochMs: 101,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: `many-session-${index}`,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      });
    }
    const page = await listUsageReportSources(handle.database, {
      taskId: null,
      repositoryId: repository.id,
      fromEpochMs: 100,
      toEpochMs: 102,
    });
    const report = deriveUsageReport(page.sources, {
      taskId: null,
      repositoryId: repository.id,
      fromEpochMs: 100,
      toEpochMs: 102,
    });
    expect(page.complete).toBe(true);
    expect(report.invocations).toHaveLength(205);
    expect(report.invocations[204]).toMatchObject({
      taskId: "usage-many-99",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });
});
