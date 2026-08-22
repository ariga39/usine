import {
  Codex,
  type CodexOptions,
  type RunResult,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
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
import { isAppServerCancellation, runCodexAppServer } from "./codex-app-server.js";
import { codexMcpConfig, safeObservationLabel } from "./coding-session-policy.js";
import {
  codexAdapterConfig,
  CodexProfileSelectionError,
  normalizeCodexProfileSelection,
  resolveCodexProfile,
  validateCodexProfile,
  type CodexProfileResolver,
} from "./codex-profile.js";

type ResolvedCodexProfile = ReturnType<typeof normalizeCodexProfileSelection>;

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

export function codexAppServerProfilesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const configured = environment.USINE_CODEX_APP_SERVER_PROFILES?.trim();
  if (!configured) return [];
  const profiles = configured.split(",").map(validateCodexProfile);
  return [...new Set(profiles)];
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

export interface CodingSessionMcpServer {
  name: string;
  url: string;
  enabledTools: readonly string[];
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  required: boolean;
}

export interface SessionRequest<Output = unknown> {
  role: SessionRole;
  workspace: string;
  contract: TaskContract;
  prompt: string;
  profile: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: z.ZodType<Output>;
  mcpServer?: CodingSessionMcpServer;
  execution: ExecutionReference;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onObservation?: (observation: CodingSessionObservation) => Promise<void> | void;
}

export interface CodingSessionMcpServerResolution {
  serverName: string;
  status: "available" | "unavailable";
  server?: CodingSessionMcpServer;
  reason?: "startup_timeout" | "unavailable";
}

export type CodingSessionMcpServerFactory = (
  request: SessionRequest,
) => Promise<CodingSessionMcpServerResolution>;

export type CodingSessionObservation =
  | { type: "thread_started" }
  | { type: "turn_started"; turn: number }
  | {
      type: "tool_completed";
      tool: "shell" | "apply_patch" | "search" | "unknown";
      outcome: "succeeded" | "failed";
    }
  | {
      type: "mcp_tool_completed";
      server: string;
      tool: string;
      outcome: "succeeded" | "failed";
    }
  | { type: "mcp_unavailable"; server: string; reason: "startup_timeout" | "unavailable" }
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
  appServerProfiles?: readonly string[];
  profileResolver?: CodexProfileResolver;
  roleOutputTransform?: RoleOutputTransform;
  mcpServerFactory?: CodingSessionMcpServerFactory;
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

export interface CodingSessionCleanup {
  cleanupTask(stateDirectory: string, taskId: string): Promise<void>;
  cleanupOwned(stateDirectory: string): Promise<void>;
}

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<Codex>;

interface ProviderTurnResult {
  finalResponse: string;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  sessionId: string | null;
}

function outputFrom(result: ProviderTurnResult): unknown {
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

class CodexRuntimeAdapter implements CodingSessionCleanup {
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

  async cleanupTask(stateDirectory: string, taskId: string): Promise<void> {
    const handles = await this.discoverOwned(stateDirectory, taskId);
    const cleanup = await Promise.allSettled(
      handles.flatMap((handle) => [this.interrupt(handle), this.reap(handle)]),
    );
    const failure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  async cleanupOwned(stateDirectory: string): Promise<void> {
    const results = await Promise.allSettled(
      (await listExecutionTaskIds(stateDirectory)).map((taskId) =>
        this.cleanupTask(stateDirectory, taskId),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
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
  private readonly adapter: CodexRuntimeAdapter;
  private readonly appServerProfiles: ReadonlySet<string>;
  private readonly profileResolver: CodexProfileResolver;

  constructor(
    private readonly clientFactory?: CodingSessionClientFactory,
    private readonly options: CodingSessionOptions = { environment: process.env },
  ) {
    this.appServerProfiles = new Set(options.appServerProfiles ?? []);
    this.profileResolver = options.profileResolver ?? resolveCodexProfile;
    this.adapter = new CodexRuntimeAdapter(
      (request) => this.runProvider(request),
      options.executionStateDirectory,
    );
  }

  async run<T = unknown>(request: SessionRequest<T>): Promise<SessionObservation<T>> {
    const handle = await this.adapter.start(request);
    try {
      return await this.adapter.observe<T>(handle);
    } finally {
      await this.adapter.reap(handle);
    }
  }

  cleanupTask(stateDirectory: string, taskId: string): Promise<void> {
    return this.adapter.cleanupTask(stateDirectory, taskId);
  }

  cleanupOwned(stateDirectory: string): Promise<void> {
    return this.adapter.cleanupOwned(stateDirectory);
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
      const profileName = validateCodexProfile(request.profile);
      let profileSelection: ResolvedCodexProfile;
      try {
        profileSelection = normalizeCodexProfileSelection(
          profileName,
          await this.profileResolver(profileName, request.environment ?? this.options.environment),
        );
      } catch (error) {
        if (error instanceof CodexProfileSelectionError) throw error;
        throw new CodexProfileSelectionError(
          profileName,
          `named profile "${profileName}" has an unreadable Codex configuration`,
        );
      }
      let effectiveRequest = request;
      if (!request.mcpServer && this.options.mcpServerFactory) {
        let resolution: CodingSessionMcpServerResolution;
        try {
          resolution = await this.options.mcpServerFactory(request);
        } catch {
          resolution = { serverName: "github_read", status: "unavailable", reason: "unavailable" };
        }
        if (resolution.status === "unavailable") {
          await request.onObservation?.({
            type: "mcp_unavailable",
            server: safeObservationLabel(resolution.serverName),
            reason: resolution.reason ?? "unavailable",
          });
        } else if (resolution.server) {
          effectiveRequest = { ...request, mcpServer: resolution.server };
        } else {
          await request.onObservation?.({
            type: "mcp_unavailable",
            server: safeObservationLabel(resolution.serverName),
            reason: "unavailable",
          });
        }
      }
      let result: ProviderTurnResult;
      if (this.appServerProfiles.has(profileName)) {
        if (!this.options.executionStateDirectory)
          throw new Error("app-server execution state directory is unavailable");
        const environment = effectiveRequest.environment ?? this.options.environment;
        result = await runCodexAppServer({
          request: { ...effectiveRequest, profile: profileName, signal: abortSignal },
          environment: explicitWorkerEnvironment(environment),
          executionStateDirectory: this.options.executionStateDirectory,
          profileSelection,
        });
      } else {
        const client = await this.createClient(effectiveRequest, profileSelection);
        const threadOptions: ThreadOptions = {
          sandboxMode: effectiveRequest.sandbox,
          workingDirectory: effectiveRequest.workspace,
          model: profileSelection.model,
          modelReasoningEffort: profileSelection.modelReasoningEffort,
          approvalPolicy: "never",
        };
        const thread: Thread = client.startThread(threadOptions);
        const turnOptions: TurnOptions = {
          signal: abortSignal,
          outputSchema: z.toJSONSchema(effectiveRequest.outputSchema, { target: "openAi" }),
        };
        const sdkResult = await runStreamedTurn(
          thread,
          effectiveRequest.prompt,
          turnOptions,
          effectiveRequest.onObservation,
        );
        result = { ...sdkResult, sessionId: thread.id };
      }
      let parsed = effectiveRequest.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        if (!this.options.roleOutputTransform) {
          return {
            status: "failed",
            sessionId: result.sessionId,
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
            outputSchema: effectiveRequest.outputSchema,
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
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session output normalization failed",
            failure: "coding session output normalization failed",
            failureCode: "role_output_transform_failed",
          };
        }
        parsed = effectiveRequest.outputSchema.safeParse(normalized);
        if (!parsed.success) {
          return {
            status: "failed",
            sessionId: result.sessionId,
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
        sessionId: result.sessionId,
        output: parsed.data,
        usage: usageFrom(result.usage),
        summary: "coding session completed",
        failure: null,
      };
    } catch (error) {
      const cancelled = abortSignal.aborted || isAppServerCancellation(error);
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

  private async createClient(
    request: SessionRequest,
    profileSelection: ResolvedCodexProfile,
  ): Promise<Codex> {
    if (this.clientFactory) return this.clientFactory(request);
    const options: CodexOptions = {
      env: explicitWorkerEnvironment(request.environment ?? this.options.environment),
      config: codexAdapterConfig(
        profileSelection,
        request.mcpServer ? codexMcpConfig(request.mcpServer) : {},
      ),
    };
    if (!this.options.executionStateDirectory) return new Codex(options);
    const launcher = await createCodexLauncher(
      this.options.executionStateDirectory,
      request.workspace,
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
        type: "mcp_tool_completed",
        server: safeObservationLabel(item.server),
        tool: safeObservationLabel(item.tool),
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

function usageFrom(
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
): SessionObservation["usage"] {
  return usage == null
    ? null
    : {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      };
}

export { codexMcpConfig };
