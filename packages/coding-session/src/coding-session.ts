import {
  Codex,
  type CodexOptions,
  type RunResult,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remainingUntil, type TaskContract } from "@usine/task-authority";
import { z } from "zod";
import {
  createCodexLauncher,
  executionLifecycle,
  listExecutionTaskIds,
  reapCodexExecution,
  type ExecutionHandle,
  type ExecutionReference,
} from "./codex-execution.js";

const PORTABLE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "CODEX_HOME",
] as const;

export interface RolePolicy {
  role: "implementer" | "reviewer";
  profile: string;
  sandbox: "workspace-write" | "read-only";
}

export class CodexProfileSelectionError extends Error {
  readonly code = "codex_profile_unusable" as const;

  constructor(
    readonly profile: string,
    reason = "must be a non-blank safe profile name",
  ) {
    super(`Codex profile is unusable: ${reason}`);
    this.name = "CodexProfileSelectionError";
  }
}

export function validateCodexProfile(profile: string): string {
  const normalized = profile.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized))
    throw new CodexProfileSelectionError(profile);
  return normalized;
}

async function ensureCodexProfileUsable(
  profile: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const normalized = validateCodexProfile(profile);
  const codexHome = environment.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    const profileFile = await stat(join(codexHome, `${normalized}.config.toml`));
    if (!profileFile.isFile()) throw new Error("profile configuration is not a regular file");
  } catch {
    throw new CodexProfileSelectionError(
      profile,
      `named profile "${normalized}" does not have a usable Codex configuration`,
    );
  }
  return normalized;
}

export function explicitWorkerEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { CI: "true" };
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

export {
  implementerOutputSchema,
  reviewerOutputSchema,
  type ImplementerOutput,
  type ReviewerOutput,
} from "./role-output.js";

export type SessionRole = "implementer" | "reviewer";
export type SandboxMode = "workspace-write" | "read-only";

export interface SessionRequest<Output = unknown> {
  role: SessionRole;
  workspace: string;
  contract: TaskContract;
  prompt: string;
  profile: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: z.ZodType<Output>;
  execution: ExecutionReference;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onObservation?: (observation: CodingSessionObservation) => Promise<void> | void;
}

export type CodingSessionObservation =
  | { type: "thread_started" }
  | { type: "turn_started"; turn: number }
  | {
      type: "tool_completed";
      tool: "shell" | "apply_patch" | "search" | "unknown";
      outcome: "succeeded" | "failed";
    }
  | { type: "turn_completed"; turn: number; outcome: "succeeded" | "failed" };

export interface RoleOutputTransformRequest {
  finalResponse: string;
  outputSchema: z.ZodTypeAny;
  signal: AbortSignal;
}

export type RoleOutputTransform = (request: RoleOutputTransformRequest) => Promise<unknown>;

export interface OpenAICompatibleRoleOutputTransformConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  fetch?: typeof fetch;
}

export function createOpenAICompatibleRoleOutputTransform(
  config: OpenAICompatibleRoleOutputTransformConfig,
): RoleOutputTransform {
  const apiKey = config.apiKey.trim();
  const baseURL = config.baseURL.trim();
  const model = config.model.trim();
  if (!apiKey || !baseURL || !model) throw new Error("role output transform is not configured");
  const openai = createOpenAI({ apiKey, baseURL, fetch: config.fetch });
  return async ({ finalResponse, outputSchema, signal }) => {
    const result = await generateText({
      model: openai.chat(model),
      output: Output.object({ schema: outputSchema }),
      prompt: [
        "Extract the single role result from the provider response.",
        "Return only the object matching the supplied schema.",
        "Provider response:",
        finalResponse,
      ].join("\n"),
      maxOutputTokens: 512,
      maxRetries: 0,
      abortSignal: signal,
    });
    return result.output;
  };
}

export interface CodingSessionOptions {
  environment: NodeJS.ProcessEnv;
  executionStateDirectory?: string;
  roleOutputTransform?: RoleOutputTransform;
}

export interface SessionObservation<T = unknown> {
  status: "completed" | "failed" | "cancelled";
  sessionId: string | null;
  output: T | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  summary: string;
  failure: string | null;
  failureCode?:
    | "codex_profile_unusable"
    | "role_output_transform_unconfigured"
    | "role_output_transform_failed"
    | "role_output_schema_invalid"
    | null;
}

export interface CodingSessionRuntimeAdapter {
  start<T>(request: SessionRequest<T>): Promise<unknown>;
  observe<T>(handle: unknown): Promise<SessionObservation<T>>;
  interrupt(handle: unknown): Promise<void>;
  reap(handle: unknown): Promise<void>;
  discoverOwned(stateDirectory: string, taskId: string): Promise<readonly unknown[]>;
  reapOwned(stateDirectory: string, taskId: string): Promise<void>;
  listOwnedTaskIds(stateDirectory: string): Promise<readonly string[]>;
}

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<Codex>;

function outputFrom(result: RunResult): unknown {
  try {
    return JSON.parse(result.finalResponse) as unknown;
  } catch {
    return undefined;
  }
}

class RoleOutputTransformCancelled extends Error {}

interface CodexSessionHandle<T> {
  kind: "session";
  controller: AbortController;
  execution: ExecutionHandle;
  promise: Promise<SessionObservation<T>>;
  executionStateDirectory?: string;
}

interface CodexOwnedHandle {
  kind: "owned";
  stateDirectory: string;
  execution: ExecutionHandle;
}

class CodexRuntimeAdapter implements CodingSessionRuntimeAdapter {
  constructor(
    private readonly runProvider: <T>(request: SessionRequest<T>) => Promise<SessionObservation<T>>,
    private readonly executionStateDirectory?: string,
  ) {}

  async start<T>(request: SessionRequest<T>): Promise<unknown> {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    return {
      kind: "session",
      controller,
      execution: { reference: request.execution, workspace: request.workspace },
      promise: this.runProvider({ ...request, signal }),
      executionStateDirectory: this.executionStateDirectory,
    } satisfies CodexSessionHandle<T>;
  }

  observe<T>(handle: unknown): Promise<SessionObservation<T>> {
    if (!isCodexSessionHandle<T>(handle)) throw new Error("coding session handle is invalid");
    return handle.promise;
  }

  async interrupt(handle: unknown): Promise<void> {
    if (isCodexSessionHandle(handle)) {
      handle.controller.abort();
      return;
    }
    if (!isCodexOwnedHandle(handle)) throw new Error("coding session handle is invalid");
    await executionLifecycle.interrupt(handle.stateDirectory, handle.execution);
  }

  async reap(handle: unknown): Promise<void> {
    if (isCodexSessionHandle(handle)) {
      try {
        await handle.promise;
      } finally {
        if (handle.executionStateDirectory)
          await reapCodexExecution(handle.executionStateDirectory, handle.execution);
      }
      return;
    }
    if (!isCodexOwnedHandle(handle)) throw new Error("coding session handle is invalid");
    await executionLifecycle.reap(handle.stateDirectory, handle.execution);
  }

  async discoverOwned(stateDirectory: string, taskId: string): Promise<readonly unknown[]> {
    return (await executionLifecycle.discover(stateDirectory, taskId)).map(
      (execution) =>
        ({
          kind: "owned",
          stateDirectory,
          execution,
        }) satisfies CodexOwnedHandle,
    );
  }

  async reapOwned(stateDirectory: string, taskId: string): Promise<void> {
    const handles = await this.discoverOwned(stateDirectory, taskId);
    const results = await Promise.allSettled(handles.map((handle) => this.reap(handle)));
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  listOwnedTaskIds(stateDirectory: string): Promise<readonly string[]> {
    return listExecutionTaskIds(stateDirectory);
  }
}

function isCodexSessionHandle<T>(value: unknown): value is CodexSessionHandle<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "session" &&
    "promise" in value &&
    value.promise instanceof Promise
  );
}

function isCodexOwnedHandle(value: unknown): value is CodexOwnedHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "owned" &&
    "stateDirectory" in value &&
    typeof value.stateDirectory === "string" &&
    "execution" in value
  );
}

async function runRoleOutputTransform(
  transform: RoleOutputTransform,
  request: RoleOutputTransformRequest,
): Promise<unknown> {
  if (request.signal.aborted) throw new RoleOutputTransformCancelled();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new RoleOutputTransformCancelled());
    request.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => transform(request))
      .then(resolve, reject)
      .finally(() => request.signal.removeEventListener("abort", onAbort));
  });
}

export class CodexCodingSession {
  private readonly adapter: CodingSessionRuntimeAdapter;

  constructor(
    private readonly clientFactory?: CodingSessionClientFactory,
    private readonly options: CodingSessionOptions = { environment: process.env },
  ) {
    this.adapter = new CodexRuntimeAdapter(
      (request) => this.runProvider(request),
      options.executionStateDirectory,
    );
  }

  get runtimeAdapter(): CodingSessionRuntimeAdapter {
    return this.adapter;
  }

  async run<T = unknown>(request: SessionRequest<T>): Promise<SessionObservation<T>> {
    const handle = await this.adapter.start(request);
    try {
      return await this.adapter.observe<T>(handle);
    } finally {
      await this.adapter.reap(handle);
    }
  }

  private async runProvider<T = unknown>(
    request: SessionRequest<T>,
  ): Promise<SessionObservation<T>> {
    let remaining: number;
    try {
      remaining = remainingUntil(request.deadlineEpochMs);
    } catch {
      return {
        status: "failed",
        sessionId: null,
        output: null,
        usage: null,
        summary: "elapsed budget exhausted",
        failure: "elapsed budget exhausted",
      };
    }
    const deadlineSignal = AbortSignal.timeout(remaining);
    const abortSignal = request.signal
      ? AbortSignal.any([request.signal, deadlineSignal])
      : deadlineSignal;
    if (abortSignal.aborted) {
      return {
        status: "cancelled",
        sessionId: null,
        output: null,
        usage: null,
        summary: "coding session cancelled",
        failure: "coding session cancelled",
      };
    }
    try {
      validateCodexProfile(request.profile);
      const client = await this.createClient(request);
      const threadOptions: ThreadOptions = {
        sandboxMode: request.sandbox,
        workingDirectory: request.workspace,
      };
      const thread: Thread = client.startThread(threadOptions);
      const turnOptions: TurnOptions = {
        signal: abortSignal,
        outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
      };
      const result = await runStreamedTurn(
        thread,
        request.prompt,
        turnOptions,
        request.onObservation,
      );
      let parsed = request.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        if (!this.options.roleOutputTransform) {
          return {
            status: "failed",
            sessionId: thread.id,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session output normalization unavailable",
            failure: "coding session output normalization unavailable",
            failureCode: "role_output_transform_unconfigured",
          };
        }
        let normalized: unknown;
        try {
          normalized = await runRoleOutputTransform(this.options.roleOutputTransform, {
            finalResponse: result.finalResponse,
            outputSchema: request.outputSchema,
            signal: abortSignal,
          });
        } catch (error) {
          if (error instanceof RoleOutputTransformCancelled && abortSignal.aborted)
            return {
              status: "cancelled",
              sessionId: null,
              output: null,
              usage: null,
              summary: "coding session cancelled",
              failure: "coding session cancelled",
            };
          return {
            status: "failed",
            sessionId: thread.id,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session output normalization failed",
            failure: "coding session output normalization failed",
            failureCode: "role_output_transform_failed",
          };
        }
        parsed = request.outputSchema.safeParse(normalized);
        if (!parsed.success) {
          return {
            status: "failed",
            sessionId: thread.id,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session normalized output did not match role schema",
            failure: "coding session normalized output did not match role schema",
            failureCode: "role_output_schema_invalid",
          };
        }
      }
      return {
        status: "completed",
        sessionId: thread.id,
        output: parsed.data,
        usage: usageFrom(result.usage),
        summary: "coding session completed",
        failure: null,
      };
    } catch (error) {
      const cancelled = abortSignal.aborted;
      const failure = error instanceof Error ? error.message : String(error);
      return {
        status: cancelled ? "cancelled" : "failed",
        sessionId: null,
        output: null,
        usage: null,
        summary: failure,
        failure,
        failureCode: error instanceof CodexProfileSelectionError ? error.code : null,
      };
    }
  }

  private async createClient(request: SessionRequest): Promise<Codex> {
    if (this.clientFactory) return this.clientFactory(request);
    const profile = await ensureCodexProfileUsable(
      request.profile,
      request.environment ?? this.options.environment,
    );
    const options: CodexOptions = {
      env: explicitWorkerEnvironment(request.environment ?? this.options.environment),
    };
    if (!this.options.executionStateDirectory) return new Codex(options);
    const launcher = await createCodexLauncher(
      this.options.executionStateDirectory,
      request.workspace,
      profile,
      request.execution,
    );
    return new Codex({
      ...options,
      codexPathOverride: launcher.launcherPath,
      env: {
        ...options.env,
        USINE_CODEX_IDENTITY_PATH: launcher.identityPath,
        USINE_CODEX_WORKSPACE: request.workspace,
      },
    });
  }
}

async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  options: TurnOptions,
  onObservation?: SessionRequest["onObservation"],
): Promise<RunResult> {
  const streamed = await thread.runStreamed(prompt, options);
  const items: ThreadItem[] = [];
  let finalResponse = "";
  let usage: RunResult["usage"] = null;
  let turn = 0;
  for await (const event of streamed.events) {
    switch (event.type) {
      case "thread.started":
        await onObservation?.({ type: "thread_started" });
        break;
      case "turn.started":
        turn += 1;
        await onObservation?.({ type: "turn_started", turn });
        break;
      case "item.completed":
        items.push(event.item);
        if (event.item.type === "agent_message") finalResponse = event.item.text;
        await emitCompletedItem(event.item, onObservation);
        break;
      case "item.updated":
        if (event.item.type === "agent_message") finalResponse = event.item.text;
        break;
      case "turn.completed":
        usage = event.usage;
        await onObservation?.({ type: "turn_completed", turn, outcome: "succeeded" });
        break;
      case "turn.failed":
        await onObservation?.({ type: "turn_completed", turn, outcome: "failed" });
        throw new Error("coding turn failed");
      case "error":
        throw new Error("coding session stream failed");
      case "item.started":
        break;
    }
  }
  return { items, finalResponse, usage };
}

async function emitCompletedItem(
  item: ThreadItem,
  onObservation?: SessionRequest["onObservation"],
): Promise<void> {
  switch (item.type) {
    case "command_execution":
      await onObservation?.({
        type: "tool_completed",
        tool: "shell",
        outcome: item.status === "completed" ? "succeeded" : "failed",
      });
      break;
    case "file_change":
      await onObservation?.({
        type: "tool_completed",
        tool: "apply_patch",
        outcome: item.status === "completed" ? "succeeded" : "failed",
      });
      break;
    case "mcp_tool_call":
      await onObservation?.({
        type: "tool_completed",
        tool: "unknown",
        outcome: item.status === "completed" ? "succeeded" : "failed",
      });
      break;
    case "web_search":
      await onObservation?.({ type: "tool_completed", tool: "search", outcome: "succeeded" });
      break;
    default:
      break;
  }
}

function usageFrom(usage: Usage | null | undefined): SessionObservation["usage"] {
  return usage == null
    ? null
    : {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      };
}
