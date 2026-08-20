import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type RunResult, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { describe, expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  createCodexLauncher,
  explicitWorkerEnvironment,
  implementerOutputSchema,
  reviewerOutputSchema,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "session-test" } as TaskContract;

function sdkTurn(finalResponse: string, usage: RunResult["usage"] = null): RunResult {
  return { items: [], finalResponse, usage };
}

function testClient(
  run: (prompt: string, options?: TurnOptions) => Promise<RunResult>,
  id: string | null = null,
  onStart?: (options: ThreadOptions) => void,
): Codex {
  const client = new Codex();
  const thread = client.startThread();
  Object.defineProperty(thread, "id", { configurable: true, value: id });
  thread.run = run;
  client.startThread = (options: ThreadOptions = {}) => {
    onStart?.(options);
    return thread;
  };
  return client;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

describe("Coding Session", () => {
  test("routes each selected profile through the Codex launcher and keeps role sandboxes local", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-profile-"));
    const implementer = await createCodexLauncher(stateDirectory, "/writer", "writer-profile");
    const reviewer = await createCodexLauncher(stateDirectory, "/reviewer", "reviewer-profile");
    expect(await readFile(implementer.launcherPath, "utf8")).toContain(
      '["--profile", "writer-profile", ...process.argv.slice(2)]',
    );
    expect(await readFile(reviewer.launcherPath, "utf8")).toContain(
      '["--profile", "reviewer-profile", ...process.argv.slice(2)]',
    );

    const sandboxes: string[] = [];
    const session = new CodexCodingSession(async (request) =>
      testClient(
        async () => sdkTurn(JSON.stringify({ status: "proposed", summary: request.profile })),
        request.profile,
        (options) => sandboxes.push(String(options.sandboxMode)),
      ),
    );
    await session.run({
      role: "implementer",
      workspace: "/writer",
      contract,
      prompt: "work",
      profile: "writer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
    });
    await session.run({
      role: "reviewer",
      workspace: "/reviewer",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
    });
    expect(sandboxes).toEqual(["workspace-write", "read-only"]);
  });

  test("rejects an unusable profile before creating a Codex client", async () => {
    let created = false;
    const session = new CodexCodingSession(async () => {
      created = true;
      return testClient(async () => sdkTurn("{}"));
    });
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: " ",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
    });
    expect(created).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "codex_profile_unusable",
    });
  });

  test("passes only the portable worker environment", () => {
    const env = explicitWorkerEnvironment({
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      NPM_TOKEN: "package-secret",
      PATH: "/portable/bin",
      LANG: "C",
    });
    expect(env).toEqual({ CI: "true", PATH: "/portable/bin", LANG: "C" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });

  test("maps SDK terminal output through the task-oriented port", async () => {
    let requestOptions: TurnOptions | undefined;
    const session = new CodexCodingSession(async () =>
      testClient(async (_prompt, options) => {
        requestOptions = options;
        return sdkTurn(JSON.stringify({ status: "proposed", summary: "done" }), {
          input_tokens: 12,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        });
      }, "opaque-thread"),
    );
    const observation = await session.run<{ status: string; summary: string }>({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "opaque-thread",
      output: { status: "proposed" },
      usage: { inputTokens: 12, outputTokens: 7 },
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

  test("propagates caller cancellation to the SDK turn", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let sdkSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(async () =>
      testClient(async (_prompt, options) => {
        sdkSignal = options?.signal;
        started.resolve();
        return new Promise<RunResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("SDK turn aborted")), {
            once: true,
          });
        });
      }),
    );
    const pending = session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const observation = await pending;
    expect(sdkSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({ status: "cancelled", output: null });
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
      profile: "implementer-profile",
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
    const session = new CodexCodingSession(async () =>
      testClient(async () => sdkTurn(finalResponse)),
    );
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      profile: "implementer-profile",
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
    const session = new CodexCodingSession(async () =>
      testClient(async () => sdkTurn(finalResponse)),
    );
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
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
