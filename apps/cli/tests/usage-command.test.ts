import { Option } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { runUsageCommand } from "../src/usage-command.js";

describe("usage command", () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write.bind(process.stdout);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  test("uses the persisted usage endpoint and emits machine-readable rows", async () => {
    const output: string[] = [];
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = new URL(input instanceof Request ? input.url : String(input));
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          scope: { taskId: null, repositoryId: "repo-1", fromEpochMs: 100, toEpochMs: 200 },
          cursor: null,
          nextCursor: null,
          coverage: "complete",
          invocations: [],
          aggregates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    await runUsageCommand(
      {
        taskId: Option.none(),
        repositoryId: Option.some("repo-1"),
        fromEpochMs: Option.some(100),
        toEpochMs: Option.some(200),
        json: true,
      },
      "http://server.test",
    );

    expect(requested?.pathname).toBe("/v1/usage");
    expect(requested?.searchParams.get("repositoryId")).toBe("repo-1");
    expect(requested?.searchParams.get("fromEpochMs")).toBe("100");
    expect(requested?.searchParams.get("limit")).toBe("200");
    expect(JSON.parse(output.join(""))).toMatchObject({ coverage: "complete" });
  });

  test("drains every bounded usage page without repeating or omitting rows", async () => {
    const output: string[] = [];
    const requests: URL[] = [];
    const row = (taskId: string, coverage: "complete" | "unavailable" = "complete") => ({
      invocationId: `${taskId}:implementer:1:session`,
      taskId,
      pullRequest: null,
      repositoryId: "repo-1",
      repository: "owner/repository",
      role: "implementer",
      activation: 1,
      reviewCycle: null,
      profile: "profile-1",
      configuredModel: "alias-1",
      configuredProvider: "provider-configured",
      provider: "provider-reported",
      adapter: "sdk",
      model: "provider/gpt-5",
      serviceTier: "unavailable",
      reasoningEffort: "minimal",
      outcome: "succeeded",
      occurredAtEpochMs: 100,
      elapsedMs: 1,
      usage: {
        inputTokens: coverage === "complete" ? 10 : null,
        cachedInputTokens: coverage === "complete" ? 2 : null,
        uncachedInputTokens: coverage === "complete" ? 8 : null,
        cacheWriteInputTokens: null,
        outputTokens: coverage === "complete" ? 1 : null,
        reasoningOutputTokens: null,
        coverage,
      },
    });
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      const cursor = url.searchParams.get("cursor");
      const invocations =
        cursor === null ? [row("task-001", "unavailable"), row("task-002")] : [row("task-003")];
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          scope: { taskId: null, repositoryId: "repo-1", fromEpochMs: null, toEpochMs: null },
          cursor,
          nextCursor: cursor === null ? "page-1" : null,
          coverage: "complete",
          invocations,
          aggregates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    await runUsageCommand(
      {
        taskId: Option.none(),
        repositoryId: Option.some("repo-1"),
        fromEpochMs: Option.none(),
        toEpochMs: Option.none(),
        json: true,
      },
      "http://server.test",
    );

    const report = JSON.parse(output.join("")) as {
      invocations: Array<{ taskId: string }>;
      aggregates: Array<{ taskId: string }>;
    };
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "page-1"]);
    expect(requests.every((url) => url.searchParams.get("limit") === "200")).toBe(true);
    expect(report.invocations.map(({ taskId }) => taskId)).toEqual([
      "task-001",
      "task-002",
      "task-003",
    ]);
    expect(report.aggregates.map(({ taskId }) => taskId)).toEqual([
      "task-001",
      "task-002",
      "task-003",
    ]);
    expect(JSON.parse(output.join("")).coverage).toBe("partial");
  });
});
