import { describe, expect, test } from "vite-plus/test";
import type { TaskEvent, TaskResource } from "@usine/task-authority";
import {
  followTask,
  ServerClientError,
  serverUrlFromEnvironment,
  taskEvents,
  taskStatus,
} from "../src/server-client.js";

function result(taskId: string, revision: number, state: TaskResource["state"]): TaskResource {
  return {
    schemaVersion: 2,
    taskId,
    contractHash: "a".repeat(64),
    revision,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    mergeAuthorized: false,
    candidateSha: null,
    candidateFence: null,
    check: null,
    review: null,
    delivery: null,
    blocker: state === "blocked" ? { classification: "unknown" } : null,
    activeActivation: state === "admitted" ? 1 : null,
    writer: { repositoryIdentity: "example/repository" },
    evidence: {
      implementerActivations: 1,
      reviewCycles: 0,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function event(taskId: string, sequence: number, data: TaskEvent["data"]): TaskEvent {
  return { taskId, sequence, eventId: `event-${sequence}`, occurredAtEpochMs: sequence, data };
}

describe("server client follow", () => {
  test("derives the client URL from the configured server host and port", () => {
    expect(serverUrlFromEnvironment({ USINE_SERVER_HOST: "::1", USINE_SERVER_PORT: "4321" })).toBe(
      "http://[::1]:4321",
    );
  });

  test("decodes a strict cursor event page", async () => {
    const originalFetch = globalThis.fetch;
    const taskId = "event-page";
    const page = {
      taskId,
      events: [event(taskId, 201, { type: "recovery_observed", kind: "server_restart" })],
      nextSequence: 201,
    };
    globalThis.fetch = async () => new Response(JSON.stringify(page), { status: 200 });
    try {
      await expect(taskEvents("http://server.test", taskId, 200)).resolves.toEqual(page);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects malformed successful TaskResult responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ taskId: "malformed", state: "admitted" }), { status: 200 });
    try {
      await expect(taskStatus("http://server.test", "malformed")).rejects.toMatchObject({
        name: "ServerClientError",
        status: 200,
      } satisfies Partial<ServerClientError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("follows events by cursor and returns the authoritative terminal snapshot", async () => {
    const taskId = "follow-events";
    const originalFetch = globalThis.fetch;
    let state: TaskResource["state"] = "admitted";
    const received: TaskEvent[] = [];
    const requestedAfter: number[] = [];
    let sequenceNumber = 0;
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (new URL(url).pathname.endsWith("/events")) {
        requestedAfter.push(Number(new URL(url).searchParams.get("after")));
        if (state === "blocked")
          return new Response(
            JSON.stringify({ taskId, events: [], nextSequence: sequenceNumber }),
            {
              status: 200,
            },
          );
        const sequence = ++sequenceNumber;
        const data: TaskEvent["data"] =
          sequence === 1
            ? {
                type: "coding_session_started",
                role: "implementer",
                activation: 1,
                sessionId: "coding-session:1:implementer",
              }
            : { type: "task_terminal", state: "blocked" };
        const next = event(taskId, sequence, data);
        state = sequence === 1 ? "admitted" : "blocked";
        return new Response(JSON.stringify({ taskId, events: [next], nextSequence: sequence }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(result(taskId, sequenceNumber, state)), { status: 200 });
    };
    try {
      await expect(
        followTask("http://server.test", taskId, {
          intervalMs: 0,
          onEvent: (value) => received.push(value),
        }),
      ).resolves.toMatchObject({ state: "blocked" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(received.map((value) => value.data.type)).toEqual([
      "coding_session_started",
      "task_terminal",
    ]);
    expect(requestedAfter).toEqual([0, 1, 2]);
    expect(new Set(received.map((value) => value.sequence)).size).toBe(received.length);
    expect(received.every((value) => value.data.type.length > 0)).toBe(true);
  });

  test("drains every cursor page before returning an already-terminal snapshot", async () => {
    const taskId = "follow-many-events";
    const originalFetch = globalThis.fetch;
    const allEvents = Array.from({ length: 201 }, (_, index) =>
      event(
        taskId,
        index + 1,
        index === 200
          ? { type: "task_terminal", state: "blocked" }
          : { type: "recovery_observed", kind: "server_restart" },
      ),
    );
    const requestedAfter: number[] = [];
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (new URL(url).pathname.endsWith("/events")) {
        const after = Number(new URL(url).searchParams.get("after"));
        requestedAfter.push(after);
        const events = allEvents.slice(after, after + 200);
        return new Response(
          JSON.stringify({ taskId, events, nextSequence: events.at(-1)?.sequence ?? after }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(result(taskId, 201, "blocked")), { status: 200 });
    };
    const received: TaskEvent[] = [];
    try {
      await expect(
        followTask("http://server.test", taskId, {
          intervalMs: 0,
          onEvent: (value) => received.push(value),
        }),
      ).resolves.toMatchObject({ taskId, state: "blocked" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestedAfter).toEqual([0, 200]);
    expect(received.map((value) => value.sequence)).toEqual(
      Array.from({ length: 201 }, (_, index) => index + 1),
    );
    expect(received.at(-1)?.data).toEqual({ type: "task_terminal", state: "blocked" });
  });
});
