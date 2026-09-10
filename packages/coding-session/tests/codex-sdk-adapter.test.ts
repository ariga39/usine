import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { CodexSdkAdapter } from "../src/codex-sdk-adapter.js";

test.each([
  "interrupted",
  "final-then-failure",
  "final-then-stream-failure",
  "empty-total",
  "long-line",
] as const)("retains usage and session identity across SDK %s", async (mode) => {
  const codexHome = await mkdtemp(join(tmpdir(), "usine-codex-interrupted-"));
  const executable = join(codexHome, "codex-fixture");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const dateDirectory = join(
  process.env.CODEX_HOME,
  "sessions",
  String(now.getFullYear()),
  pad(now.getMonth() + 1),
  pad(now.getDate()),
);
const threadId = "thread-interrupted-fixture";
const mode = process.env.FIXTURE_MODE;
const writeArtifact = () => {
  mkdirSync(dateDirectory, { recursive: true });
  writeFileSync(
  join(dateDirectory, "rollout-fixture-" + threadId + ".jsonl"),
  [
    JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 20,
            cache_write_input_tokens: 4,
            output_tokens: 8,
            reasoning_output_tokens: 3,
          },
        },
      },
    }),
    ].join("\\n") + "\\n",
  );
};
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
setTimeout(() => {
  writeArtifact();
  if (mode === "empty-total")
    appendFileSync(
      join(dateDirectory, "rollout-fixture-" + threadId + ".jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: {} } },
      }) + "\\n",
    );
  if (mode === "long-line")
    appendFileSync(
      join(dateDirectory, "rollout-fixture-" + threadId + ".jsonl"),
      "x".repeat(300 * 1024) + "\\n",
    );
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  if (mode === "final-then-failure" || mode === "final-then-stream-failure") {
    process.stdout.write(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 130,
        cached_input_tokens: 20,
        cache_write_input_tokens: 4,
        output_tokens: 9,
        reasoning_output_tokens: 3,
      },
    }) + "\\n");
    setTimeout(() => {
      if (mode === "final-then-stream-failure")
        process.stdout.write(JSON.stringify({ type: "error", message: "late stream failure" }) + "\\n");
      process.exit(0);
    }, 10);
  } else {
    setTimeout(() => process.exit(1), 10);
  }
}, 30);
`,
  );
  await chmod(executable, 0o755);

  const observations: Array<{ usage: unknown; semantics: string }> = [];
  const sessionIds: string[] = [];
  const adapter = new CodexSdkAdapter({ codexPathOverride: executable });
  await expect(
    adapter.run({
      role: "implementer",
      workspace: codexHome,
      prompt: "interrupt",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      profile: { model: "fixture-model" },
      outputSchema: {},
      environment: {
        CODEX_HOME: codexHome,
        PATH: process.env.PATH ?? "",
        FIXTURE_MODE: mode,
      },
      signal: new AbortController().signal,
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onUsage: (observation) => {
        observations.push(observation);
      },
      onObservation: (observation) => {
        if (mode === "final-then-failure" && observation.type === "turn_completed")
          throw new Error("observer failure");
      },
    }),
  ).rejects.toMatchObject({ phase: "turn" });

  expect(sessionIds).toEqual(["thread-interrupted-fixture"]);
  expect(observations).toEqual(
    mode === "interrupted" || mode === "empty-total" || mode === "long-line"
      ? [
          {
            semantics: "replacement",
            completeness: "partial",
            usage: {
              inputTokens: 120,
              cachedInputTokens: 20,
              uncachedInputTokens: 96,
              cacheWriteInputTokens: 4,
              outputTokens: 8,
              reasoningOutputTokens: 3,
            },
          },
        ]
      : [
          {
            semantics: "replacement",
            completeness: "partial",
            usage: {
              inputTokens: 120,
              cachedInputTokens: 20,
              uncachedInputTokens: 96,
              cacheWriteInputTokens: 4,
              outputTokens: 8,
              reasoningOutputTokens: 3,
            },
          },
          {
            semantics: "replacement",
            completeness: "complete",
            usage: {
              inputTokens: 130,
              cachedInputTokens: 20,
              uncachedInputTokens: 106,
              cacheWriteInputTokens: 4,
              outputTokens: 9,
              reasoningOutputTokens: 3,
            },
          },
        ],
  );
});
