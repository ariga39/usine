import { describe, expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  explicitWorkerEnvironment,
  implementerOutputSchema,
  reviewerOutputSchema,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "session-test" } as TaskContract;

describe("Coding Session", () => {
  test("strips coordinator and delivery credentials", () => {
    const env = explicitWorkerEnvironment({
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      SAFE: "yes",
      SAFE_TOKEN: "yes-too",
    });
    expect(env).toMatchObject({ CI: "true", SAFE: "yes", SAFE_TOKEN: "yes-too" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("maps SDK terminal output through the task-oriented port", async () => {
    let requestOptions: Record<string, unknown> | undefined;
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        id: "opaque-thread",
        run: async (_prompt, options) => {
          requestOptions = options;
          return { finalResponse: JSON.stringify({ status: "proposed", summary: "done" }) };
        },
      }),
    }));
    const observation = await session.run<{ status: string; summary: string }>({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "opaque-thread",
      output: { status: "proposed" },
    });
    expect(requestOptions).toMatchObject({
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["proposed", "blocked"] },
          summary: { type: "string" },
        },
        required: ["status", "summary"],
        additionalProperties: false,
      },
    });
    expect(requestOptions).not.toHaveProperty("env");
  });

  test("preserves the deadline reserve before starting a provider", async () => {
    let started = false;
    const session = new CodexCodingSession(async () => {
      started = true;
      throw new Error("provider should not start");
    });
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 50,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(started).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failure: "elapsed budget exhausted",
    });
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong status", JSON.stringify({ status: "finished", summary: "done" })],
    ["missing summary", JSON.stringify({ status: "proposed" })],
  ])("fails closed on implementer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        run: async () => ({ finalResponse }),
      }),
    }));
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output did not match role schema",
    });
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong verdict", JSON.stringify({ sha, verdict: "wrong", summary: "ok", findings: [] })],
    ["missing summary", JSON.stringify({ sha, verdict: "approved", findings: [] })],
    [
      "non-string finding",
      JSON.stringify({ sha, verdict: "approved", summary: "ok", findings: [7] }),
    ],
  ])("fails closed on reviewer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        run: async () => ({ finalResponse }),
      }),
    }));
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      model: "test-model",
      reasoningEffort: "low",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output did not match role schema",
    });
  });
});
