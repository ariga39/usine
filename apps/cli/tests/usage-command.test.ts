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
    expect(JSON.parse(output.join(""))).toMatchObject({ coverage: "complete" });
  });
});
