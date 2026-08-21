import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskObservationEventInput,
} from "../src/index.js";

const handles: Array<{ close: () => void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

function contract(taskId: string): TaskContract {
  return {
    id: taskId,
    repositoryId: "event-repository",
    baseSha: "a".repeat(40),
    instructions: "exercise the event stream",
    acceptance: ["events are ordered"],
    nonGoals: [],
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 30_000 },
    authorization: {
      source: "https://github.com/example/event-repository/issues/187",
      delivery: true,
    },
    delivery: {
      branch: `agent/${taskId}`,
      issue: 187,
      title: "event stream",
      body: "event stream",
    },
  };
}

async function authorityFor(taskId: string): Promise<{ authority: TaskAuthority; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "usine-task-events-"));
  const path = join(directory, "state.sqlite");
  await applyMigrations(path);
  const handle = openSqliteDatabase(path);
  handles.push(handle);
  const authority = new TaskAuthority(handle.database);
  await authority.admit({
    contract: contract(taskId),
    contractHash: "a".repeat(64),
    repositoryIdentity: `event/${taskId}`,
    deadlineEpochMs: 123_456,
  });
  return { authority, path };
}

describe("Task event stream", () => {
  test("replays one ordered Task-local stream and deduplicates a stable event identity", async () => {
    const taskId = `events-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { authority } = await authorityFor(taskId);
    const toolEvent: TaskObservationEventInput = {
      eventId: "coding-tool-1",
      occurredAtEpochMs: 200,
      data: {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        tool: "shell",
        outcome: "succeeded",
      },
    };

    const first = await authority.appendObservation(taskId, toolEvent);
    const duplicate = await authority.appendObservation(taskId, toolEvent);

    expect(first).toEqual(duplicate);
    const events = await authority.listEvents(taskId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sequence: 1,
      eventId: "task-admitted",
      occurredAtEpochMs: expect.any(Number),
      data: { type: "task_admitted", contractHash: "a".repeat(64) },
    });
    expect(events[1]).toMatchObject({
      sequence: 2,
      eventId: "coding-tool-1",
      occurredAtEpochMs: 200,
      data: {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        tool: "shell",
        outcome: "succeeded",
      },
    });
    expect(await authority.listEvents(taskId, 1)).toEqual([duplicate]);
    expect(JSON.stringify(await authority.listEvents(taskId))).not.toMatch(
      /prompt|response|reasoning|transcript|argv|stdout|stderr|credential|private-key|secret/i,
    );
  });

  test("rejects unbounded or provider-specific event payloads at the public boundary", async () => {
    const taskId = `events-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { authority } = await authorityFor(taskId);
    const unsafe = {
      eventId: "unsafe",
      occurredAtEpochMs: 200,
      data: {
        type: "coding_tool_completed",
        role: "implementer",
        activation: 1,
        tool: "shell",
        outcome: "succeeded",
        stdout: "private-key",
      },
    } as unknown as TaskObservationEventInput;

    await expect(authority.appendObservation(taskId, unsafe)).rejects.toThrow();
    await expect(authority.listEvents(taskId)).resolves.toHaveLength(1);
  });
});
