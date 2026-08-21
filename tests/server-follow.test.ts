import { createServer } from "node:http";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import type { TaskResult, TaskState } from "@usine/task-authority";

function result(taskId: string, revision: number, state: TaskState): TaskResult {
  return {
    schemaVersion: 2,
    taskId,
    contractHash: "contract-hash",
    revision,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    mergeAuthorized: false,
    candidateSha: state === "candidate" ? "a".repeat(40) : null,
    candidateFence: state === "candidate" ? 1 : null,
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

describe("CLI follow boundary", () => {
  test("polls bounded durable progress and prints one terminal result", async () => {
    const taskId = "follow-test";
    const snapshots = [
      result(taskId, 0, "admitted"),
      result(taskId, 1, "candidate"),
      result(taskId, 2, "blocked"),
    ];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      const snapshot = snapshots[Math.min(requestCount++, snapshots.length - 1)];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...snapshot, history: [] }));
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
      const progress = run.stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(progress.map((entry) => entry.state)).toEqual(["admitted", "candidate", "blocked"]);
      expect(progress.every((entry) => entry.event === "progress")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
