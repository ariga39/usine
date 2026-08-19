import { describe, expect, test } from "vite-plus/test";
import type { TaskResult } from "@usine/task-authority";
import {
  followTask,
  ServerClientError,
  serverUrlFromEnvironment,
  taskStatus,
} from "../src/server-client.js";

function result(taskId: string, revision: number, state: TaskResult["state"]): TaskResult {
  return {
    schemaVersion: 1,
    taskId,
    contractHash: "contract-hash",
    revision,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    candidateSha: null,
    candidateFence: null,
    check: null,
    review: null,
    delivery: null,
    blocker: state === "blocked" ? "operator stopped task" : null,
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

describe("server client follow", () => {
  test("derives the client URL from the configured server host and port", () => {
    expect(
      serverUrlFromEnvironment({
        USINE_SERVER_HOST: "::1",
        USINE_SERVER_PORT: "4321",
      }),
    ).toBe("http://[::1]:4321");
  });

  test("rejects malformed successful TaskResult responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ taskId: "malformed", state: "admitted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await expect(taskStatus("http://server.test", "malformed")).rejects.toMatchObject({
        name: "ServerClientError",
        status: 200,
      } satisfies Partial<ServerClientError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the durable deadline instead of a default poll-count bound", async () => {
    const taskId = "long-follow-test";
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      const revision = requestCount++;
      const state = revision === 600 ? "blocked" : "admitted";
      return new Response(JSON.stringify(result(taskId, revision, state)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const terminal = await followTask("http://server.test", taskId, { intervalMs: 0 });
      expect(terminal.state).toBe("blocked");
      expect(requestCount).toBe(601);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
