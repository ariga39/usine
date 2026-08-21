import { createServer } from "node:http";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import type { TaskEvent, TaskResource, TaskState } from "@usine/task-authority";

function result(taskId: string, revision: number, state: TaskState): TaskResource {
  return {
    schemaVersion: 2,
    taskId,
    contractHash: "a".repeat(64),
    revision,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    mergeAuthorized: false,
    candidateSha: state === "candidate" ? "a".repeat(40) : null,
    candidateFence: state === "candidate" ? 1 : null,
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

describe("CLI follow boundary", () => {
  test("replays cursor events and prints one authoritative terminal result", async () => {
    const taskId = "follow-test";
    let state: TaskState = "admitted";
    let sequence = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/events")) {
        if (state === "blocked") {
          response.end(JSON.stringify({ taskId, events: [], nextSequence: sequence }));
          return;
        }
        sequence += 1;
        const current = event(
          taskId,
          sequence,
          sequence === 1
            ? { type: "task_admitted", contractHash: "a".repeat(64) }
            : { type: "task_terminal", state: "blocked" },
        );
        if (sequence === 2) state = "blocked";
        response.end(JSON.stringify({ taskId, events: [current], nextSequence: sequence }));
        return;
      }
      response.end(JSON.stringify(result(taskId, sequence, state)));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("follow test did not bind");

    try {
      const run = await execa("node", ["apps/cli/dist/cli.mjs", "follow", taskId], {
        env: { USINE_SERVER_URL: `http://127.0.0.1:${address.port}` },
        reject: false,
      });
      expect(run.exitCode, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ taskId, state: "blocked" });
      const events = run.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEvent);
      expect(events.map((entry) => entry.sequence)).toEqual([1, 2]);
      expect(
        events.every(
          (entry) =>
            typeof entry.taskId === "string" &&
            typeof entry.eventId === "string" &&
            typeof entry.occurredAtEpochMs === "number" &&
            typeof entry.data.type === "string",
        ),
      ).toBe(true);
      expect(events.at(-1)?.data).toMatchObject({ type: "task_terminal", state: "blocked" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
