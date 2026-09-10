import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  deriveUsageReport,
  deriveUsageReportFromInvocations,
  listUsageReportSources,
  mergeProviderNeutralUsage,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskEvent,
  type TaskResult,
  type UsageInvocation,
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

const encodeTestCursor = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function sortedValues<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  const sorted: T[] = [];
  for (const value of values) {
    const index = sorted.findIndex((existing) => compare(value, existing) < 0);
    if (index === -1) sorted.push(value);
    else sorted.splice(index, 0, value);
  }
  return sorted;
}

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
    repairBatchRecorded: false,
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
        semantics: "replacement",
        actualModel: { model: "provider/gpt-5", provider: "provider:actual" },
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
        semantics: "replacement",
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
  test("sorts aggregates by failure class after grouping by it", () => {
    const usage = {
      inputTokens: 1,
      cachedInputTokens: 0,
      uncachedInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      coverage: "complete" as const,
    };
    const base: UsageInvocation = {
      invocationId: "aggregate-sort-invocation",
      taskId: "aggregate-sort-task",
      pullRequest: null,
      repositoryId: "repository",
      repository: "owner/repository",
      role: "reviewer",
      activation: 0,
      reviewCycle: 1,
      profile: "profile",
      configuredModel: "model",
      configuredProvider: "provider",
      actualModel: "actual-model",
      actualProvider: "actual-provider",
      provider: "provider",
      adapter: "adapter",
      model: "model",
      serviceTier: "standard",
      reasoningEffort: "high",
      outcome: "failed",
      occurredAtEpochMs: 1,
      elapsedMs: 1,
      usage,
    };
    const report = deriveUsageReportFromInvocations(
      [
        { ...base, invocationId: "transport", failureClass: "transient_transport" },
        { ...base, invocationId: "capacity", failureClass: "transient_capacity" },
      ],
      { taskId: null, repositoryId: null, fromEpochMs: null, toEpochMs: null },
    );

    expect(report.aggregates.map((aggregate) => aggregate.failureClass)).toEqual([
      "transient_capacity",
      "transient_transport",
    ]);
  });

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
            semantics: "delta",
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
      configuredModel: "model-1",
      configuredProvider: "provider-1",
      actualModel: "provider/gpt-5",
      actualProvider: "provider:actual",
      provider: "provider:actual",
      adapter: "sdk",
      model: "provider/gpt-5",
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
      configuredModel: "normalizer-model",
      configuredProvider: "normalizer-provider",
      actualModel: "unavailable",
      actualProvider: "unavailable",
      model: "unavailable",
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
    expect(
      report.aggregates.find((aggregate) => aggregate.taskId === partialTaskId)?.usage,
    ).toEqual({
      inputTokens: 4,
      cachedInputTokens: null,
      uncachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 2,
      reasoningOutputTokens: null,
      coverage: "partial",
    });
  });

  test("retains interrupted implementer and reviewer usage at complete, partial, and unavailable coverage", () => {
    const interruptedSource = (input: {
      taskId: string;
      role: "implementer" | "reviewer";
      sessionId: string;
      startedAtEpochMs: number;
      usage: {
        inputTokens?: number;
        cachedInputTokens?: number;
        uncachedInputTokens?: number;
        outputTokens?: number;
      } | null;
      semantics: "delta" | "replacement";
      usageCompleteness?: "complete" | "partial";
    }): UsageReportSource => {
      const roleFields = input.role === "reviewer" ? { reviewCycle: 1 } : {};
      const events: TaskEvent[] = [
        event(input.taskId, 1, input.startedAtEpochMs, {
          type: "coding_session_started",
          role: input.role,
          activation: 1,
          ...roleFields,
          sessionId: input.sessionId,
          requestedProfile: `${input.role}-profile`,
        }),
        ...(input.usage === null
          ? []
          : [
              event(input.taskId, 2, input.startedAtEpochMs + 1, {
                type: "coding_usage_observed",
                role: input.role,
                activation: 1,
                ...roleFields,
                sessionId: input.sessionId,
                source: "provider",
                semantics: input.semantics,
                ...(input.usageCompleteness ? { usageCompleteness: input.usageCompleteness } : {}),
                actualModel: { model: "provider/gpt-5", provider: "provider:actual" },
                usage: input.usage,
              }),
            ]),
        event(input.taskId, 3, input.startedAtEpochMs + 2, {
          type: "coding_session_interrupted",
          role: input.role,
          activation: 1,
          sessionId: input.sessionId,
          phase: "turn",
          failureClass: "transient_transport",
        }),
        event(input.taskId, 4, input.startedAtEpochMs + 3, {
          type: "coding_session_completed",
          role: input.role,
          activation: 1,
          ...roleFields,
          outcome: "failed",
          sessionId: input.sessionId,
          requestedProfile: `${input.role}-profile`,
          usage: null,
        }),
      ];
      return { task: task(input.taskId), events };
    };
    const report = deriveUsageReport(
      [
        interruptedSource({
          taskId: "interrupted-complete-task",
          role: "implementer",
          sessionId: "interrupted-complete",
          startedAtEpochMs: 511_537,
          semantics: "replacement",
          usageCompleteness: "partial",
          usage: {
            inputTokens: 120,
            cachedInputTokens: 20,
            uncachedInputTokens: 100,
            outputTokens: 8,
          },
        }),
        interruptedSource({
          taskId: "interrupted-partial-task",
          role: "reviewer",
          sessionId: "interrupted-partial",
          startedAtEpochMs: 600,
          semantics: "delta",
          usage: { inputTokens: 4, outputTokens: 2 },
        }),
        interruptedSource({
          taskId: "interrupted-unavailable-task",
          role: "implementer",
          sessionId: "interrupted-unavailable",
          startedAtEpochMs: 700,
          semantics: "replacement",
          usage: null,
        }),
      ],
      { taskId: null, repositoryId: "usage-repository", fromEpochMs: null, toEpochMs: null },
    );

    expect(report.invocations).toHaveLength(3);
    expect(
      report.invocations.find((row) => row.taskId === "interrupted-complete-task"),
    ).toMatchObject({
      role: "implementer",
      outcome: "failed",
      failureClass: "transient_transport",
      elapsedMs: 3,
      usage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        uncachedInputTokens: 100,
        cacheWriteInputTokens: null,
        outputTokens: 8,
        reasoningOutputTokens: null,
        coverage: "partial",
      },
    });
    expect(
      report.invocations.find((row) => row.taskId === "interrupted-partial-task"),
    ).toMatchObject({
      role: "reviewer",
      outcome: "failed",
      failureClass: "transient_transport",
      reviewCycle: 1,
      usage: {
        inputTokens: 4,
        cachedInputTokens: null,
        uncachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: 2,
        reasoningOutputTokens: null,
        coverage: "partial",
      },
    });
    expect(
      report.invocations.find((row) => row.taskId === "interrupted-unavailable-task"),
    ).toMatchObject({
      role: "implementer",
      outcome: "failed",
      failureClass: "transient_transport",
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        uncachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        coverage: "unavailable",
      },
    });
    expect(report.coverage).toBe("partial");
  });

  test("shares delta merging across all six usage dimensions", () => {
    expect(mergeProviderNeutralUsage(null, { inputTokens: 3, outputTokens: 4 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(
      mergeProviderNeutralUsage(
        {
          inputTokens: 3,
          cachedInputTokens: 1,
          uncachedInputTokens: 2,
          cacheWriteInputTokens: 4,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        {
          inputTokens: 5,
          cachedInputTokens: 2,
          uncachedInputTokens: 3,
          cacheWriteInputTokens: 1,
          outputTokens: 6,
          reasoningOutputTokens: 2,
        },
      ),
    ).toEqual({
      inputTokens: 8,
      cachedInputTokens: 3,
      uncachedInputTokens: 5,
      cacheWriteInputTokens: 5,
      outputTokens: 10,
      reasoningOutputTokens: 3,
    });
    expect(
      mergeProviderNeutralUsage({ inputTokens: 3, cachedInputTokens: 1 }, { inputTokens: 5 }),
    ).toEqual({
      inputTokens: 8,
      cachedInputTokens: undefined,
      uncachedInputTokens: undefined,
      cacheWriteInputTokens: undefined,
      outputTokens: undefined,
      reasoningOutputTokens: undefined,
    });
  });

  test("poisons missing dimensions across multiple deltas for providers and normalizers", () => {
    const taskId = "delta-poisoning-task";
    const report = deriveUsageReport(
      [
        {
          task: task(taskId),
          events: [
            event(taskId, 1, 100, {
              type: "coding_session_started",
              role: "implementer",
              activation: 1,
              sessionId: "delta-provider",
            }),
            event(taskId, 2, 101, {
              type: "coding_usage_observed",
              role: "implementer",
              activation: 1,
              sessionId: "delta-provider",
              source: "provider",
              semantics: "delta",
              usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
            }),
            event(taskId, 3, 102, {
              type: "coding_usage_observed",
              role: "implementer",
              activation: 1,
              sessionId: "delta-provider",
              source: "provider",
              semantics: "delta",
              usage: { inputTokens: 5, outputTokens: 4 },
            }),
            event(taskId, 4, 103, {
              type: "coding_usage_observed",
              role: "implementer",
              activation: 1,
              sessionId: "delta-normalizer",
              source: "role_output_normalizer",
              semantics: "delta",
              usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 1 },
            }),
            event(taskId, 5, 104, {
              type: "coding_usage_observed",
              role: "implementer",
              activation: 1,
              sessionId: "delta-normalizer",
              source: "role_output_normalizer",
              semantics: "delta",
              usage: { inputTokens: 3, outputTokens: 2 },
            }),
          ],
        },
      ],
      { taskId: null, repositoryId: "usage-repository", fromEpochMs: null, toEpochMs: null },
    );

    expect(report.invocations).toHaveLength(3);
    expect(
      report.invocations.find((row) => row.invocationId.endsWith("delta-provider"))?.usage,
    ).toEqual(
      expect.objectContaining({
        inputTokens: 15,
        cachedInputTokens: null,
        outputTokens: 7,
      }),
    );
    expect(
      report.invocations.find((row) => row.invocationId.endsWith(":role-output-normalizer"))?.usage,
    ).toEqual(
      expect.objectContaining({
        inputTokens: 5,
        cachedInputTokens: null,
        outputTokens: 3,
      }),
    );
  });

  test("replacement snapshots select the latest snapshot without accumulation", () => {
    const taskId = "replacement-snapshot-task";
    const report = deriveUsageReport(
      [
        {
          task: task(taskId),
          events: [
            event(taskId, 1, 100, {
              type: "coding_session_started",
              role: "reviewer",
              activation: 0,
              reviewCycle: 1,
              sessionId: "replacement-session",
            }),
            event(taskId, 2, 101, {
              type: "coding_usage_observed",
              role: "reviewer",
              activation: 0,
              reviewCycle: 1,
              sessionId: "replacement-session",
              source: "provider",
              semantics: "replacement",
              usage: {
                inputTokens: 10,
                cachedInputTokens: 2,
                uncachedInputTokens: 8,
                outputTokens: 3,
              },
            }),
            event(taskId, 3, 102, {
              type: "coding_usage_observed",
              role: "reviewer",
              activation: 0,
              reviewCycle: 1,
              sessionId: "replacement-session",
              source: "provider",
              semantics: "replacement",
              usage: {
                inputTokens: 20,
                cachedInputTokens: 5,
                uncachedInputTokens: 15,
                outputTokens: 6,
              },
            }),
          ],
        },
      ],
      { taskId: null, repositoryId: "usage-repository", fromEpochMs: null, toEpochMs: null },
    );
    expect(report.invocations[0]?.usage).toEqual(
      expect.objectContaining({ inputTokens: 20, cachedInputTokens: 5, outputTokens: 6 }),
    );
  });

  test("keeps activations and review cycles distinct while associating current delivery", () => {
    const taskId = "activation-review-task";
    const sessions = [
      {
        role: "implementer" as const,
        activation: 1,
        sessionId: "implementer-1",
        reviewCycle: undefined,
      },
      {
        role: "implementer" as const,
        activation: 2,
        sessionId: "implementer-2",
        reviewCycle: undefined,
      },
      { role: "reviewer" as const, activation: 0, sessionId: "reviewer-1", reviewCycle: 1 },
      { role: "reviewer" as const, activation: 0, sessionId: "reviewer-2", reviewCycle: 2 },
    ];
    const events = sessions.flatMap((session, index) => {
      const startedAt = 100 + index * 2;
      const usage = {
        inputTokens: 10 + index,
        cachedInputTokens: 1,
        uncachedInputTokens: 9 + index,
        outputTokens: 2,
      };
      return [
        event(taskId, index * 2 + 1, startedAt, {
          type: "coding_session_started",
          role: session.role,
          activation: session.activation,
          ...(session.reviewCycle === undefined ? {} : { reviewCycle: session.reviewCycle }),
          sessionId: session.sessionId,
        }),
        event(taskId, index * 2 + 2, startedAt + 1, {
          type: "coding_session_completed",
          role: session.role,
          activation: session.activation,
          ...(session.reviewCycle === undefined ? {} : { reviewCycle: session.reviewCycle }),
          outcome: "succeeded",
          sessionId: session.sessionId,
          usage,
        }),
      ];
    });
    const scope = {
      taskId: null,
      repositoryId: "usage-repository",
      fromEpochMs: null,
      toEpochMs: null,
    };
    const deliveredTask = {
      ...task(taskId),
      delivery: {
        sha: "a".repeat(40),
        effect: "github" as const,
        prNumber: 345,
        url: "https://github.com/example/repository/pull/345",
        attestationId: "attestation-345",
      },
    };
    const delivered = deriveUsageReport([{ task: deliveredTask, events }], scope);
    const beforeDelivery = deriveUsageReport([{ task: task(taskId), events }], scope);

    expect(delivered.invocations).toHaveLength(4);
    expect(new Set(delivered.invocations.map((row) => row.invocationId)).size).toBe(4);
    expect(delivered.invocations.map((row) => [row.role, row.activation, row.reviewCycle])).toEqual(
      [
        ["implementer", 1, null],
        ["implementer", 2, null],
        ["reviewer", 0, 1],
        ["reviewer", 0, 2],
      ],
    );
    expect(delivered.invocations.every((row) => row.pullRequest === 345)).toBe(true);
    expect(delivered.invocations.map((row) => row.invocationId)).toEqual(
      beforeDelivery.invocations.map((row) => row.invocationId),
    );
    expect(beforeDelivery.invocations.every((row) => row.pullRequest === null)).toBe(true);
    expect(
      sortedValues(
        delivered.aggregates.map((aggregate) => aggregate.invocations),
        (a, b) => a - b,
      ),
    ).toEqual([2, 2]);
    expect(
      sortedValues(
        delivered.aggregates.map((aggregate) => aggregate.usage.inputTokens),
        (a, b) => (a ?? 0) - (b ?? 0),
      ),
    ).toEqual([21, 25]);
  });

  test("reports coverage from selected invocation rows", () => {
    const scope = {
      taskId: null,
      repositoryId: "usage-repository",
      fromEpochMs: null,
      toEpochMs: null,
    };
    const unavailable = deriveUsageReport(
      [
        {
          task: task("all-unavailable"),
          events: [
            event("all-unavailable", 1, 100, {
              type: "coding_session_completed",
              role: "implementer",
              activation: 1,
              outcome: "failed",
              sessionId: "unavailable-session",
              usage: null,
            }),
          ],
        },
      ],
      scope,
    );
    expect(unavailable.coverage).toBe("unavailable");
    expect(deriveUsageReportFromInvocations([], scope).coverage).toBe("complete");
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
    const scope = {
      taskId: null,
      repositoryId: repository.id,
      fromEpochMs: 100,
      toEpochMs: 102,
    } as const;
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await listUsageReportSources(handle.database, scope, { cursor, limit: 100 });
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const sources = pages.flatMap((page) => page.sources);
    const report = deriveUsageReport(sources, scope);
    const taskIds = report.invocations.map((invocation) => invocation.taskId);
    const expectedTaskIds = sortedValues(
      Array.from({ length: 205 }, (_, index) => `usage-many-${index}`),
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.sources.length)).toEqual([100, 100, 5]);
    expect(report.invocations).toHaveLength(205);
    expect(taskIds).toEqual(expectedTaskIds);
    expect(new Set(taskIds).size).toBe(205);
    expect(report.invocations.at(-1)).toMatchObject({
      taskId: expectedTaskIds.at(-1),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const cursorBase = {
      version: 1,
      scope,
      upperTaskId: "usage-many-100",
      afterTaskId: "usage-many-099",
    };
    await expect(
      listUsageReportSources(handle.database, scope, {
        cursor: encodeTestCursor({ ...cursorBase, extra: true }),
        limit: 100,
      }),
    ).rejects.toThrow();
    await expect(
      listUsageReportSources(handle.database, scope, {
        cursor: encodeTestCursor({ ...cursorBase, scope: { ...scope, repositoryId: "other" } }),
        limit: 100,
      }),
    ).rejects.toThrow();
    await expect(
      listUsageReportSources(handle.database, scope, {
        cursor: encodeTestCursor({ ...cursorBase, upperTaskId: "", afterTaskId: "usage-many-099" }),
        limit: 100,
      }),
    ).rejects.toThrow();
    await expect(
      listUsageReportSources(handle.database, scope, {
        cursor: encodeTestCursor({
          ...cursorBase,
          upperTaskId: "usage-many-100",
          afterTaskId: "usage-many-999",
        }),
        limit: 100,
      }),
    ).rejects.toThrow();
    await expect(
      listUsageReportSources(handle.database, scope, {
        cursor: "x".repeat(4097),
        limit: 100,
      }),
    ).rejects.toThrow();
  });
});
