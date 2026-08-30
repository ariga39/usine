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
import { Effect } from "effect";
import { remainingUntil, type TaskContract } from "@usine/task-authority";
import { z } from "zod";
import {
  createCodexLauncher,
  executionLifecycle,
  listExecutionTaskIds,
  reapCodexExecution,
  type ExecutionReference,
} from "./codex-execution.js";
import { isAppServerCancellation, runCodexAppServer } from "./codex-app-server.js";
import { codexMcpConfig, safeObservationLabel } from "./coding-session-policy.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
  type CodingSessionFailureClass,
  type CodingSessionPhase,
} from "./coding-session-interruption.js";
import {
  codexAdapterConfig,
  CodexProfileSelectionError,
  normalizeCodexProfileSelection,
  resolveCodexProfile,
  validateCodexProfile,
  type CodexProfileResolver,
} from "./codex-profile.js";
import {
  sessionArchiveProfileSnapshot,
  SessionArchiveWriter,
  type SessionArchiveOptions,
} from "./session-archive.js";

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
  sessionArchive?: SessionArchiveOptions;
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
  phase: CodingSessionPhase | null;
  failureClass: CodingSessionFailureClass | null;
  failureCode?:
    | "codex_profile_unusable"
    | "role_output_transform_unconfigured"
    | "role_output_transform_failed"
    | "role_output_schema_invalid"
    | null;
  archiveId?: string;
  archiveStatus?: "stored" | "truncated" | "failed";
  archiveWarnings?: string[];
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

function identityError(error: unknown): unknown {
  return error;
}

async function runRoleOutputTransform(
  transform: RoleOutputTransform,
  request: RoleOutputTransformRequest,
): Promise<unknown> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: (signal) => transform({ ...request, signal }),
      catch: identityError,
    }),
    { signal: request.signal },
  );
}

export class CodexCodingSession {
  private readonly appServerProfiles: ReadonlySet<string>;
  private readonly profileResolver: CodexProfileResolver;

  constructor(
    private readonly clientFactory?: CodingSessionClientFactory,
    private readonly options: CodingSessionOptions = { environment: process.env },
  ) {
    this.appServerProfiles = new Set(options.appServerProfiles ?? []);
    this.profileResolver = options.profileResolver ?? resolveCodexProfile;
  }

  async run<T = unknown>(request: SessionRequest<T>): Promise<SessionObservation<T>> {
    const executionStateDirectory = this.options.executionStateDirectory;
    const execution = { reference: request.execution, workspace: request.workspace };
    return Effect.runPromise(
      Effect.scoped(
        Effect.acquireUseRelease(
          Effect.void,
          () => Effect.tryPromise({ try: () => this.runProvider(request), catch: identityError }),
          () =>
            executionStateDirectory
              ? Effect.tryPromise({
                  try: () => reapCodexExecution(executionStateDirectory, execution),
                  catch: identityError,
                }).pipe(Effect.asVoid)
              : Effect.void,
        ),
      ),
    );
  }

  async cleanupTask(stateDirectory: string, taskId: string): Promise<void> {
    const handles = await executionLifecycle.discover(stateDirectory, taskId);
    const cleanup = await Promise.allSettled(
      handles.flatMap((handle) => [
        executionLifecycle.interrupt(stateDirectory, handle),
        executionLifecycle.reap(stateDirectory, handle),
      ]),
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

  private async runProvider<T = unknown>(
    request: SessionRequest<T>,
  ): Promise<SessionObservation<T>> {
    const archiveDirectory =
      this.options.sessionArchive?.stateDirectory ?? this.options.executionStateDirectory;
    const archive = archiveDirectory
      ? new SessionArchiveWriter(
          this.options.sessionArchive ?? { stateDirectory: archiveDirectory },
          {
            taskId: request.contract.id,
            role: request.role,
            attempt: request.execution.attempt,
            contract: request.contract,
            prompt: request.prompt,
          },
        )
      : undefined;
    await archive?.begin();
    const observation = await this.runProviderCaptured(request, archive);
    if (!archive) return observation;
    const archiveResult = await archive.finish({
      status: observation.status,
      sessionId: observation.sessionId,
      usage: observation.usage,
      failure: observation.failure,
      phase: observation.phase,
      failureClass: observation.failureClass,
    });
    return {
      ...observation,
      archiveId: archiveResult.archiveId,
      archiveStatus: archiveResult.archiveStatus,
      archiveWarnings: archiveResult.warnings,
    };
  }

  private async runProviderCaptured<T = unknown>(
    request: SessionRequest<T>,
    archive?: SessionArchiveWriter,
  ): Promise<SessionObservation<T>> {
    let phase: CodingSessionPhase = "startup";
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
        phase,
        failureClass: "timeout",
      };
    }
    const deadlineSignal = AbortSignal.timeout(remaining);
    const abortSignal = request.signal
      ? AbortSignal.any([request.signal, deadlineSignal])
      : deadlineSignal;
    if (abortSignal.aborted) {
      const failureClass = deadlineSignal.aborted ? "timeout" : "cancellation";
      return {
        status: "cancelled",
        sessionId: null,
        output: null,
        usage: null,
        summary: "coding session cancelled",
        failure: "coding session cancelled",
        phase,
        failureClass,
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
        archive?.setProfile(
          sessionArchiveProfileSnapshot(profileName, {
            ...profileSelection,
            ...profileSelection.config,
          }),
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
        archive?.setAdapter("app-server");
        if (!this.options.executionStateDirectory)
          throw new Error("app-server execution state directory is unavailable");
        const environment = effectiveRequest.environment ?? this.options.environment;
        result = await runCodexAppServer({
          request: { ...effectiveRequest, profile: profileName, signal: abortSignal },
          environment: explicitWorkerEnvironment(environment),
          executionStateDirectory: this.options.executionStateDirectory,
          profileSelection,
          onItemCompleted: (item) => archive?.addCompletedItem(item),
          onSessionId: (sessionId) => archive?.setSessionId(sessionId),
          onPhase: (nextPhase) => archive?.setPhase(nextPhase),
          onUsage: (usage) => archive?.setUsage(usageFrom(usage)),
        });
      } else {
        archive?.setAdapter("sdk");
        let client: Codex;
        try {
          client = await this.createClient(effectiveRequest, profileSelection);
        } catch (error) {
          throw new CodingSessionInterruption("startup", classifyAdapterFailure(error));
        }
        const threadOptions: ThreadOptions = {
          sandboxMode: effectiveRequest.sandbox,
          workingDirectory: effectiveRequest.workspace,
          model: profileSelection.model,
          modelReasoningEffort: profileSelection.modelReasoningEffort,
          approvalPolicy: "never",
        };
        let thread: Thread;
        try {
          thread = client.startThread(threadOptions);
          archive?.setSessionId(thread.id);
        } catch (error) {
          throw new CodingSessionInterruption("thread", classifyAdapterFailure(error));
        }
        phase = "turn";
        archive?.setPhase("turn");
        const turnOptions: TurnOptions = {
          signal: abortSignal,
          outputSchema: z.toJSONSchema(effectiveRequest.outputSchema, { target: "openAi" }),
        };
        const sdkResult = await runStreamedTurn(
          thread,
          effectiveRequest.prompt,
          turnOptions,
          effectiveRequest.onObservation,
          (item) => archive?.addCompletedItem(item),
        );
        result = { ...sdkResult, sessionId: thread.id };
      }
      phase = "output";
      archive?.setPhase("output");
      archive?.setSessionId(result.sessionId);
      archive?.setProviderResult(result.finalResponse, usageFrom(result.usage));
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
            phase,
            failureClass: "configuration",
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
          if (abortSignal.aborted)
            return {
              status: "cancelled",
              sessionId: null,
              output: null,
              usage: null,
              summary: "coding session cancelled",
              failure: "coding session cancelled",
              phase,
              failureClass: deadlineSignal.aborted ? "timeout" : "cancellation",
            };
          return {
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session output normalization failed",
            failure: "coding session output normalization failed",
            phase,
            failureClass: classifyAdapterFailure(error),
            failureCode: "role_output_transform_failed",
          };
        }
        archive?.setNormalizedOutput(normalized);
        parsed = effectiveRequest.outputSchema.safeParse(normalized);
        if (!parsed.success) {
          return {
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session normalized output did not match role schema",
            failure: "coding session normalized output did not match role schema",
            phase,
            failureClass: "configuration",
            failureCode: "role_output_schema_invalid",
          };
        }
      }
      archive?.setNormalizedOutput(parsed.data);
      return {
        status: "completed",
        sessionId: result.sessionId,
        output: parsed.data,
        usage: usageFrom(result.usage),
        summary: "coding session completed",
        failure: null,
        phase: null,
        failureClass: null,
      };
    } catch (error) {
      const deadlineExpired = deadlineSignal.aborted;
      const cancelled = request.signal?.aborted || isAppServerCancellation(error);
      const typedInterruption = error instanceof CodingSessionInterruption ? error : undefined;
      const interruption = deadlineExpired
        ? new CodingSessionInterruption(typedInterruption?.phase ?? phase, "timeout")
        : cancelled
          ? new CodingSessionInterruption(typedInterruption?.phase ?? phase, "cancellation")
          : error instanceof CodingSessionInterruption
            ? error
            : error instanceof CodexProfileSelectionError
              ? new CodingSessionInterruption(phase, "configuration", error.message)
              : new CodingSessionInterruption(phase, classifyAdapterFailure(error));
      return {
        status: deadlineExpired || cancelled ? "cancelled" : "failed",
        sessionId: null,
        output: null,
        usage: null,
        summary: safeFailureMessage(interruption),
        failure: safeFailureMessage(interruption),
        phase: interruption.phase,
        failureClass: interruption.failureClass,
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
  onItemCompleted?: (item: ThreadItem) => void,
): Promise<RunResult> {
  try {
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
          onItemCompleted?.(event.item);
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
  } catch (error) {
    if (error instanceof CodingSessionInterruption) throw error;
    throw new CodingSessionInterruption("turn", classifyAdapterFailure(error));
  }
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

function safeFailureMessage(error: CodingSessionInterruption): string {
  const message = error.message;
  if (/^app-server [a-z ]+( \([a-z_]+\))?$/.test(message)) return message;
  if (/^Codex profile is unusable: named profile "[A-Za-z0-9._:-]+" /.test(message)) return message;
  return `coding session provider interruption (${error.failureClass})`;
}
