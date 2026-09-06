import { Effect, Layer, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiTest } from "effect/unstable/httpapi";
import { expect, test } from "vite-plus/test";
import { decodeApiEventEnvelope, UsineApi } from "@usine/runtime";

test("the generated client round-trips the shared server health contract", async () => {
  const handlers = HttpApiBuilder.group(UsineApi, "server", (group) =>
    group.handleAll({
      health: () => Effect.succeed({ status: "ok" as const, revision: 7 }),
      snapshot: () =>
        Effect.succeed({
          schemaVersion: 1 as const,
          revision: 7,
          server: { status: "ok" as const, revision: 7 },
          repositories: [],
          tasks: [],
          codingSessions: [],
        }),
    }),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(UsineApi, ["server"]);
        return yield* client.health();
      }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
    ),
  );
  expect(result).toEqual({ status: "ok", revision: 7 });
});

test("the generated client round-trips the durable usage report contract", async () => {
  const report = {
    schemaVersion: 1 as const,
    scope: { taskId: null, repositoryId: "repo-1", fromEpochMs: 100, toEpochMs: 200 },
    cursor: null,
    nextCursor: null,
    coverage: "partial" as const,
    invocations: [],
    aggregates: [],
  };
  const handlers = HttpApiBuilder.group(UsineApi, "usage", (group) =>
    group.handleAll({ report: () => Effect.succeed(report) }),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(UsineApi, ["usage"]);
        return yield* client.usage.report({
          query: { repositoryId: "repo-1", fromEpochMs: 100, toEpochMs: 200, limit: 2 },
        });
      }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
    ),
  );
  expect(result).toEqual(report);
});

test("the generated client round-trips the Campaign evidence contract", async () => {
  const report = {
    schemaVersion: 1 as const,
    campaignId: "goal:v1",
    goalId: "goal",
    goalVersion: 1,
    cursor: null,
    nextCursor: null,
    progress: { revision: 7, occurredAtEpochMs: 1700000000000 },
    coverage: "complete" as const,
    runs: [],
    aggregates: [],
    totals: {
      invocations: 0,
      elapsedMs: 0,
      reviewCycles: 0,
      repairBatches: 0,
      blockedProposals: 0,
      guardianTouches: 0,
      acceptedDeliveries: 0,
      terminalTaskCounts: {
        elapsed_budget: 0,
        implementation_budget: 0,
        invalid_phase: 0,
        missing_evidence: 0,
        provider_failure: 0,
        project_check_failure: 0,
        review_inconclusive: 0,
        delivery_failure: 0,
        unknown: 0,
      },
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        coverage: "complete" as const,
      },
    },
    touches: [],
    deliveries: [],
  };
  const handlers = HttpApiBuilder.group(UsineApi, "campaigns", (group) =>
    group.handleAll({
      publish: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      propose: () => Effect.die("unused"),
      handoff: () => Effect.die("unused"),
      abandon: () => Effect.die("unused"),
      evidence: () => Effect.succeed(report),
      touch: () => Effect.die("unused"),
    }),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(UsineApi, ["campaigns"]);
        return yield* client.campaigns.evidence({ params: { campaignId: "goal:v1" }, query: {} });
      }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
    ),
  );
  expect(result).toEqual(report);
});

test("the shared event envelope preserves exact fields and Task identity", () => {
  const event = {
    taskId: "task-1",
    sequence: 0,
    eventId: "event-1",
    occurredAtEpochMs: 0,
    data: { type: "task_blocked" as const, reason: "unknown" as const },
  };
  expect(decodeApiEventEnvelope({ taskId: "task-1", repositoryId: "repo-1", event })).toEqual({
    taskId: "task-1",
    repositoryId: "repo-1",
    event,
  });
  expect(() =>
    decodeApiEventEnvelope({ taskId: "task-1", repositoryId: "repo-1", event, extra: true }),
  ).toThrow();
  expect(() =>
    decodeApiEventEnvelope({ taskId: "task-2", repositoryId: "repo-1", event }),
  ).toThrow();
});

test("the typed SSE contract emits readiness before a domain envelope", async () => {
  const event = {
    taskId: "task-1",
    sequence: 0,
    eventId: "event-1",
    occurredAtEpochMs: 0,
    data: { type: "task_blocked" as const, reason: "unknown" as const },
  };
  const envelope = { taskId: "task-1", repositoryId: "repo-1", event };
  const handlers = HttpApiBuilder.group(UsineApi, "events", (group) =>
    group.handleAll({
      wait: () => Effect.succeed(envelope),
      subscribe: () => Effect.succeed(Stream.fromIterable([{ kind: "ready" as const }, envelope])),
    }),
  );
  const values = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(UsineApi, ["events"]);
        const stream = yield* client.events.subscribe({ query: {} });
        return yield* Stream.runCollect(Stream.take(stream, 2));
      }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
    ),
  );
  expect(Array.from(values)).toEqual([{ kind: "ready" }, envelope]);
});

test("the shared error contract encodes quarantined Tasks as HTTP 503", async () => {
  const handlers = HttpApiBuilder.group(UsineApi, "tasks", (group) =>
    group.handleAll({
      list: () => Effect.die("unused"),
      get: () =>
        Effect.fail({ taskId: "task-quarantined", error: "task_state_quarantined" as const }),
      history: () => Effect.die("unused"),
      submit: () => Effect.die("unused"),
      retry: () => Effect.die("unused"),
    }),
  );
  const request = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(UsineApi, ["tasks"]);
      return yield* client.tasks.get({ params: { taskId: "task-quarantined" } });
    }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
  );
  await expect(Effect.runPromise(request)).rejects.toEqual({
    taskId: "task-quarantined",
    error: "task_state_quarantined",
  });
});

test("the shared error contract encodes quarantined Campaigns as HTTP 503", async () => {
  const handlers = HttpApiBuilder.group(UsineApi, "campaigns", (group) =>
    group.handleAll({
      publish: () => Effect.die("unused"),
      get: () =>
        Effect.fail({
          campaignId: "campaign-quarantined:v1",
          error: "campaign_state_quarantined" as const,
        }),
      propose: () => Effect.die("unused"),
      handoff: () => Effect.die("unused"),
      abandon: () => Effect.die("unused"),
      evidence: () => Effect.die("unused"),
      touch: () => Effect.die("unused"),
    }),
  );
  const request = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(UsineApi, ["campaigns"]);
      return yield* client.campaigns.get({ params: { campaignId: "campaign-quarantined:v1" } });
    }).pipe(Effect.provide(Layer.mergeAll(handlers, HttpServer.layerServices))),
  );
  await expect(Effect.runPromise(request)).rejects.toEqual({
    campaignId: "campaign-quarantined:v1",
    error: "campaign_state_quarantined",
  });
});
