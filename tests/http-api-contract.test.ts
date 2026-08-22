import { Effect, Layer, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiTest } from "effect/unstable/httpapi";
import { expect, test } from "vite-plus/test";
import { decodeApiEventEnvelope, UsineApi } from "@usine/runtime";

test("the generated client round-trips the shared server health contract", async () => {
  const handlers = HttpApiBuilder.group(UsineApi, "server", (group) =>
    group.handleAll({
      health: () => Effect.succeed({ status: "ok" as const, revision: 7 }),
      healthAlias: () => Effect.succeed({ status: "ok" as const, revision: 7 }),
      snapshot: () =>
        Effect.succeed({
          schemaVersion: 1 as const,
          revision: 7,
          server: { status: "ok" as const, revision: 7 },
          repositories: [],
          tasks: [],
          codingSessions: [],
        }),
      snapshotAlias: () =>
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
      subscribeAlias: () =>
        Effect.succeed(Stream.fromIterable([{ kind: "ready" as const }, envelope])),
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
