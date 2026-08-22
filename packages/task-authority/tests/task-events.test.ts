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
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:0:outcome",
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
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:0:outcome",
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
        sessionId: "coding-session:1:implementer",
        outcomeId: "coding:1:unsafe:outcome",
        tool: "shell",
        outcome: "succeeded",
        stdout: "private-key",
      },
    } as unknown as TaskObservationEventInput;
    const oversized = {
      eventId: "oversized",
      occurredAtEpochMs: 201,
      data: {
        type: "coding_session_started",
        role: "implementer",
        activation: 1,
        sessionId: "s".repeat(97),
      },
    } as unknown as TaskObservationEventInput;

    await expect(authority.appendObservation(taskId, unsafe)).rejects.toThrow();
    await expect(authority.appendObservation(taskId, oversized)).rejects.toThrow();
    await expect(authority.listEvents(taskId)).resolves.toHaveLength(1);
  });

  test("records only sanitized MCP outcomes and unavailable fallback", async () => {
    const taskId = `events-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { authority } = await authorityFor(taskId);
    await authority.appendObservation(taskId, {
      eventId: "coding-mcp-completed",
      occurredAtEpochMs: 202,
      data: {
        type: "coding_mcp_tool_completed",
        role: "reviewer",
        activation: 1,
        sessionId: "coding-session:1:reviewer",
        outcomeId: "coding:1:mcp:outcome",
        server: "github_read_reviewer",
        tool: "github_issue_get",
        outcome: "succeeded",
      },
    });
    await authority.appendObservation(taskId, {
      eventId: "coding-mcp-unavailable",
      occurredAtEpochMs: 203,
      data: {
        type: "coding_mcp_unavailable",
        role: "reviewer",
        activation: 1,
        sessionId: "coding-session:1:reviewer",
        server: "github_read_reviewer",
        reason: "startup_timeout",
      },
    });
    const events = await authority.listEvents(taskId);
    expect(events.slice(-2).map((event) => event.data.type)).toEqual([
      "coding_mcp_tool_completed",
      "coding_mcp_unavailable",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/arguments|result|credential|secret|token/i);
  });

  test("keeps a complete coding activation observation sequence beside its authoritative result", async () => {
    const taskId = `activation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { authority } = await authorityFor(taskId);
    const activation = await authority.reserveActivation(taskId, 2);
    const sessionId = "coding-session:1:implementer";
    const observations: TaskObservationEventInput[] = [
      {
        eventId: "coding:1:session-started",
        occurredAtEpochMs: 10,
        data: { type: "coding_session_started", role: "implementer", activation: 1, sessionId },
      },
      {
        eventId: "coding:1:thread-started",
        occurredAtEpochMs: 11,
        data: { type: "coding_thread_started", role: "implementer", activation: 1, sessionId },
      },
      {
        eventId: "coding:1:turn-started",
        occurredAtEpochMs: 12,
        data: {
          type: "coding_turn_started",
          role: "implementer",
          activation: 1,
          turn: 1,
          sessionId,
        },
      },
      {
        eventId: "coding:1:tool-completed",
        occurredAtEpochMs: 13,
        data: {
          type: "coding_tool_completed",
          role: "implementer",
          activation: 1,
          sessionId,
          outcomeId: "coding:1:tool:outcome",
          tool: "shell",
          outcome: "succeeded",
        },
      },
      {
        eventId: "coding:1:turn-completed",
        occurredAtEpochMs: 14,
        data: {
          type: "coding_turn_completed",
          role: "implementer",
          activation: 1,
          turn: 1,
          sessionId,
          outcomeId: "coding:1:turn:outcome",
          outcome: "succeeded",
        },
      },
      {
        eventId: "coding:1:session-completed",
        occurredAtEpochMs: 15,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          sessionId,
          outcome: "succeeded",
        },
      },
    ];
    for (const observation of observations) await authority.appendObservation(taskId, observation);

    const candidate = await authority.recordCandidate(
      { taskId, revision: activation.result.revision },
      { sha: "b".repeat(40), baseSha: "a".repeat(40), fence: activation.activation },
    );
    const terminal = await authority.block(
      { taskId, revision: candidate.revision },
      "activation evidence test complete",
    );
    const events = await authority.listEvents(taskId);
    expect(events.slice(2).map((event) => event.data.type)).toEqual([
      "coding_session_started",
      "coding_thread_started",
      "coding_turn_started",
      "coding_tool_completed",
      "coding_turn_completed",
      "coding_session_completed",
      "candidate_frozen",
      "task_blocked",
      "task_terminal",
    ]);
    expect(events.at(-1)).toMatchObject({
      data: { type: "task_terminal", state: terminal.state },
    });
    expect(events.find((event) => event.data.type === "candidate_frozen")).toMatchObject({
      data: { type: "candidate_frozen", sha: candidate.candidateSha, fence: 1 },
    });
    expect(candidate.state).toBe("candidate");
    expect(terminal.state).toBe("blocked");
  });
});
