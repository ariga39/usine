import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type RunResult, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import { describe, expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  createOpenAICompatibleRoleOutputTransform,
  createCodexLauncher,
  discoverOwnedExecutions,
  executionLifecycle,
  explicitWorkerEnvironment,
  implementerOutputSchema,
  codexExecutionIdentityPath,
  removeCodexExecutionIdentity,
  reviewerOutputSchema,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "session-test" } as TaskContract;
const implementerExecution = { taskId: contract.id, role: "implementer" as const, attempt: "1" };
const reviewerExecution = { taskId: contract.id, role: "reviewer" as const, attempt: "1-a" };

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
  test("retains starting and live execution identities and removes a confirmed-stopped identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-identity-"));
    const workspace = join(stateDirectory, "workspace");
    const identityPath = codexExecutionIdentityPath(stateDirectory, implementerExecution);
    await mkdir(join(stateDirectory, "codex-executions"), { recursive: true });

    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "starting",
        reference: implementerExecution,
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(false);
    await expect(access(identityPath)).resolves.toBeUndefined();

    const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!liveChild.pid) throw new Error("live child has no PID");
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(liveChild.pid)], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "running",
        reference: implementerExecution,
        pid: liveChild.pid,
        startedAt,
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(false);
    await expect(readFile(identityPath, "utf8")).resolves.toContain('"state":"running"');
    process.kill(-liveChild.pid, "SIGKILL");
    await new Promise<void>((resolve) => liveChild.once("exit", () => resolve()));

    const stoppedChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (!stoppedChild.pid) throw new Error("stopped child has no PID");
    await new Promise<void>((resolve, reject) => {
      stoppedChild.once("error", reject);
      stoppedChild.once("exit", () => resolve());
    });
    await writeFile(
      identityPath,
      JSON.stringify({
        version: 2,
        state: "running",
        reference: implementerExecution,
        pid: stoppedChild.pid,
        startedAt: "confirmed-stopped",
        workspace,
      }) + "\n",
    );
    expect(await removeCodexExecutionIdentity(stateDirectory, implementerExecution)).toBe(true);
    await expect(access(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("discovers valid implementer and reviewer launcher identities by task ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-discovery-"));
    const implementer = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "writer"),
      "writer-profile",
      implementerExecution,
    );
    const reviewerReference = {
      taskId: "review-task",
      role: "reviewer" as const,
      attempt: "1-a" + sha,
    };
    const reviewer = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "reviewer"),
      "reviewer-profile",
      reviewerReference,
    );

    await expect(discoverOwnedExecutions(stateDirectory, contract.id)).resolves.toEqual([
      { reference: implementerExecution, workspace: join(stateDirectory, "writer") },
    ]);
    await expect(
      discoverOwnedExecutions(stateDirectory, reviewerReference.taskId),
    ).resolves.toEqual([
      { reference: reviewerReference, workspace: join(stateDirectory, "reviewer") },
    ]);
    await expect(readFile(implementer.launcherPath, "utf8")).resolves.toContain(
      'reference: {"taskId":"session-test","role":"implementer","attempt":"1"}',
    );
    await expect(readFile(reviewer.identityPath, "utf8")).resolves.toContain('"role":"reviewer"');
  });

  test("fails closed when a launcher has no companion identity", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-incomplete-"));
    const launcher = await createCodexLauncher(
      stateDirectory,
      join(stateDirectory, "workspace"),
      "profile",
      implementerExecution,
    );
    await unlink(launcher.identityPath);
    await expect(discoverOwnedExecutions(stateDirectory, contract.id)).rejects.toThrow(
      "Codex execution launcher has no durable identity",
    );
  });

  test("converges concurrent reviewer interrupt and reap on one owned execution", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-race-"));
    const workspace = join(stateDirectory, "reviewer");
    const reference = {
      taskId: "review-race",
      role: "reviewer" as const,
      attempt: `1-${sha}`,
    };
    const launcher = await createCodexLauncher(
      stateDirectory,
      workspace,
      "reviewer-profile",
      reference,
    );
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (!child.pid) throw new Error("reviewer child has no PID");
    try {
      const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
        encoding: "utf8",
      }).trim();
      await writeFile(
        launcher.identityPath,
        JSON.stringify({
          version: 2,
          state: "running",
          reference,
          pid: child.pid,
          startedAt,
          workspace,
        }) + "\n",
      );
      const handle = { reference, workspace };
      const results = await Promise.allSettled([
        executionLifecycle.interrupt(stateDirectory, handle),
        executionLifecycle.reap(stateDirectory, handle),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      await expect(discoverOwnedExecutions(stateDirectory, reference.taskId)).resolves.toEqual([]);
      await expect(access(launcher.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(launcher.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
      let states: string[] = [];
      try {
        states = execFileSync("ps", ["-o", "stat=", "-g", String(child.pid)], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean);
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 1)) throw error;
      }
      expect(states.every((state) => /^[ZX]/.test(state.trim()))).toBe(true);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The shared termination transition may already have removed the group.
      }
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  test("routes each selected profile through the Codex launcher and keeps role sandboxes local", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-codex-profile-"));
    const implementer = await createCodexLauncher(
      stateDirectory,
      "/writer",
      "writer-profile",
      implementerExecution,
    );
    const reviewer = await createCodexLauncher(
      stateDirectory,
      "/reviewer",
      "reviewer-profile",
      reviewerExecution,
    );
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
      execution: implementerExecution,
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
      execution: reviewerExecution,
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
      execution: implementerExecution,
    });
    expect(created).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "codex_profile_unusable",
    });
  });

  test("rejects a well-formed named profile that is absent from the Codex home", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "usine-codex-home-"));
    const session = new CodexCodingSession(undefined, { environment: { CODEX_HOME: codexHome } });
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "missing-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
    });
    expect(observation).toMatchObject({
      status: "failed",
      failureCode: "codex_profile_unusable",
    });
    expect(observation.failure).toContain("missing-profile");
  });

  test("passes only the portable worker environment", () => {
    const env = explicitWorkerEnvironment({
      OPENAI_API_KEY: "secret",
      USINE_ROLE_OUTPUT_API_KEY: "coordinator-secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      NPM_TOKEN: "package-secret",
      PATH: "/portable/bin",
      LANG: "C",
      CODEX_HOME: "codex-home-sentinel",
    });
    expect(env).toEqual({
      CI: "true",
      PATH: "/portable/bin",
      LANG: "C",
      CODEX_HOME: "codex-home-sentinel",
    });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("USINE_ROLE_OUTPUT_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("NPM_TOKEN");
  });

  test("maps SDK terminal output through the task-oriented port", async () => {
    let requestOptions: TurnOptions | undefined;
    let transformCalls = 0;
    const session = new CodexCodingSession(
      async () =>
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
      {
        environment: { CI: "true" },
        roleOutputTransform: async () => {
          transformCalls += 1;
          return { status: "blocked", summary: "unexpected normalization" };
        },
      },
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
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "opaque-thread",
      output: { status: "proposed" },
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(transformCalls).toBe(0);
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

  test("normalizes one prose-wrapped reviewer response through the coordinator transform", async () => {
    const reviewer = {
      sha: "29122cf5c32a160d5ed6c6a7f68d61fc2c0c9117",
      verdict: "approved",
      summary: "The candidate satisfies the task contract.",
      findings: [],
    } as const;
    const finalResponse = [
      "The fresh review is complete.",
      "",
      "```json",
      JSON.stringify(reviewer),
      "```",
      "",
      "No further findings.",
    ].join("\n");
    let transformCalls = 0;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn(finalResponse)),
      {
        environment: { CI: "true" },
        roleOutputTransform: async ({ finalResponse: response, outputSchema, signal }) => {
          transformCalls += 1;
          expect(response).toBe(finalResponse);
          expect(signal.aborted).toBe(false);
          return outputSchema.parse(reviewer);
        },
      },
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
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(transformCalls).toBe(1);
    expect(observation).toMatchObject({
      status: "completed",
      output: reviewer,
      failure: null,
    });
  });

  test("uses chat completions for the schema-constrained production transform", async () => {
    const reviewer = {
      sha,
      verdict: "approved",
      summary: "ok",
      findings: [],
    } as const;
    const apiKey = "fixture-only-key";
    const model = "fixture-model";
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transform = createOpenAICompatibleRoleOutputTransform({
      apiKey,
      baseURL: "https://fixture.invalid/v1",
      model,
      fetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, init });
        return new Response(
          JSON.stringify({
            id: "fixture-completion",
            object: "chat.completion",
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(reviewer) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const output = await transform({
      finalResponse: "The review is wrapped in harmless prose.",
      outputSchema: reviewerOutputSchema,
      signal: new AbortController().signal,
    });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe("/v1/chat/completions");
    if (typeof requests[0].init?.body !== "string") throw new Error("expected JSON request body");
    const body = JSON.parse(requests[0].init.body) as Record<string, unknown>;
    expect(body.model).toBe(model);
    expect(body).toHaveProperty("response_format");
    expect(JSON.stringify(body)).toContain("findings");
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(output).toEqual(reviewer);
    expect(JSON.stringify(output)).not.toContain(apiKey);
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
      execution: implementerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const observation = await pending;
    expect(sdkSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({ status: "cancelled", output: null });
  });

  test("propagates caller cancellation to the bounded output transform", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let transformSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        roleOutputTransform: async ({ signal }) => {
          transformSignal = signal;
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("transform aborted")), {
              once: true,
            });
          });
        },
      },
    );
    const pending = session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const observation = await pending;
    expect(transformSignal?.aborted).toBe(true);
    expect(observation).toMatchObject({ status: "cancelled", output: null });
  });

  test("bounds the output transform by the remaining deadline", async () => {
    const started = deferred<void>();
    let transformSignal: AbortSignal | undefined;
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        roleOutputTransform: async ({ signal }) => {
          transformSignal = signal;
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("transform timed out")), {
              once: true,
            });
          });
        },
      },
    );
    const pending = session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      profile: "reviewer-profile",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 250,
      outputSchema: reviewerOutputSchema,
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    await started.promise;
    const observation = await pending;
    expect(transformSignal?.aborted).toBe(true);
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
      execution: implementerExecution,
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
      execution: implementerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
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
      execution: reviewerExecution,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test("fails explicitly when normalization is needed but unconfigured", async () => {
    const session = new CodexCodingSession(async () =>
      testClient(async () => sdkTurn("The review could not be represented directly.")),
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
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization unavailable",
      failureCode: "role_output_transform_unconfigured",
    });
  });

  test("fails closed when the transform returns a schema-invalid result", async () => {
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        roleOutputTransform: async () => ({ verdict: "approved" }),
      },
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
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session normalized output did not match role schema",
      failureCode: "role_output_schema_invalid",
    });
  });

  test("fails closed and bounds transform failures without exposing their details", async () => {
    const secretDetail = "coordinator-transform-detail";
    const session = new CodexCodingSession(
      async () => testClient(async () => sdkTurn("The review is wrapped.")),
      {
        environment: { CI: "true" },
        roleOutputTransform: async () => {
          throw new Error(secretDetail);
        },
      },
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
      execution: reviewerExecution,
      environment: { CI: "true" },
    });

    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output normalization failed",
      failureCode: "role_output_transform_failed",
    });
    expect(JSON.stringify(observation)).not.toContain(secretDetail);
  });
});
