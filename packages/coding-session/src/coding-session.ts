import { createHash } from "node:crypto";
import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { Effect } from "effect";
import {
  mergeProviderNeutralUsage,
  remainingUntil,
  type TaskContract,
} from "@usine/task-authority";
import { z } from "zod";
import { executionLifecycle, listExecutionTaskIds, reapOwnedExecution } from "./codex-execution.js";
import {
  codingSessionAdapterForProfile,
  codingSessionAdapterProfilesFromEnvironment,
  type CodingSessionAdapterProfiles,
} from "./coding-session-config.js";
import type { ExecutionReference } from "./coding-session-types.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { OpenCode2Adapter } from "./opencode2-adapter.js";
import {
  type CodingSessionAdapter,
  type CodingSessionAdapterRequest,
  type ProviderNeutralCompletedEvidence,
  type ProviderNeutralUsage,
  type ProviderNeutralUsageObservation,
} from "./coding-session-adapter.js";
import { CodexSdkAdapter } from "./codex-sdk-adapter.js";
import { normalizeCodingSessionMcpServer, safeObservationLabel } from "./coding-session-policy.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
  type CodingSessionFailureClass,
  type CodingSessionPhase,
} from "./coding-session-interruption.js";
import {
  codingSessionAdapterProfile,
  CodexProfileSelectionError,
  normalizeCodexProfileSelection,
  resolveCodexProfile,
  validateCodexProfile,
  type CodexProfileResolver,
} from "./codex-profile.js";
import {
  sessionArchiveProfileSnapshot,
  SessionArchiveWriter,
  type SessionArchiveCaptureStatus,
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

export function explicitWorkerEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { CI: "true" };
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

export type SessionRole = "implementer" | "reviewer";
export type SandboxMode = "workspace-write" | "read-only";

export interface EffectiveSessionProfile {
  profileName: string | null;
  configSha256: string | null;
  adapter: "sdk" | "app-server" | "opencode2" | null;
  model: string | null;
  modelProvider: string | null;
  actualModel?: string | null;
  actualModelProvider?: string | null;
  reasoningEffort: ModelReasoningEffort | null;
  developerInstructionsSha256: string | null;
  serviceTier?: string | null;
}

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
  | {
      type: "usage_observed";
      source: "provider" | "role_output_normalizer";
      usage: ProviderNeutralUsage;
      semantics: ProviderNeutralUsageObservation["semantics"];
      actualModel?: ProviderNeutralUsageObservation["actualModel"];
    }
  | {
      type: "sandbox_verified";
      host: "darwin-seatbelt";
      role: SessionRole;
      workspaceRead: "verified";
      workspaceWrite: "verified" | "denied";
      externalRead: "denied";
      externalWrite: "denied";
      subprocess: "inherited";
    }
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
  onUsage?: (observation: ProviderNeutralUsageObservation) => Promise<void> | void;
}

export interface RoleOutputTransform {
  (request: RoleOutputTransformRequest): Promise<unknown>;
  readonly profile?: {
    readonly adapter: "role-output-normalizer";
    readonly model: string | null;
    readonly modelProvider: string | null;
  };
}

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
  const transform: RoleOutputTransform = async ({
    finalResponse,
    outputSchema,
    signal,
    onUsage,
  }) => {
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
    await onUsage?.({
      semantics: "replacement",
      actualModel: { model: result.response.modelId, provider: "openai-compatible" },
      usage: {
        inputTokens: result.usage.inputTokens,
        uncachedInputTokens: result.usage.inputTokenDetails.noCacheTokens,
        cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens,
        cacheWriteInputTokens: result.usage.inputTokenDetails.cacheWriteTokens,
        outputTokens: result.usage.outputTokens,
        reasoningOutputTokens: result.usage.outputTokenDetails.reasoningTokens,
      },
    });
    return result.output;
  };
  Object.defineProperty(transform, "profile", {
    value: { adapter: "role-output-normalizer", model, modelProvider: "openai-compatible" },
    enumerable: true,
  });
  return transform;
}

export interface CodingSessionOptions {
  /** Environment visible to provider adapters and their child processes. */
  environment: NodeJS.ProcessEnv;
  /** Host-private static adapter selection input; never sent to an adapter. */
  adapterSelectionEnvironment?: NodeJS.ProcessEnv;
  /** Host-private SDK executable override for a direct public Codex client. */
  codexPathOverride?: string;
  executionStateDirectory?: string;
  sessionArchive?: SessionArchiveOptions;
  profileResolver?: CodexProfileResolver;
  roleOutputTransform?: RoleOutputTransform;
  mcpServerFactory?: CodingSessionMcpServerFactory;
}

export interface SessionObservation<T = unknown> {
  status: "completed" | "failed" | "cancelled";
  output: T | null;
  usage: ProviderNeutralUsage | null;
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
  archiveStatus?: SessionArchiveCaptureStatus;
  archiveCompleteness?: "complete" | "partial";
  archiveWarnings?: string[];
  /** The requested profile survives even when profile resolution fails. */
  requestedProfile?: string;
  /** Sanitized effective profile facts owned by Coding Session. */
  effectiveProfile?: EffectiveSessionProfile;
  normalizer?: RoleOutputNormalizerObservation;
}

export interface RoleOutputNormalizerObservation {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly usage: ProviderNeutralUsage | null;
  readonly adapter: "role-output-normalizer";
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly actualModel: string | null;
  readonly actualModelProvider: string | null;
}

interface CapturedSessionObservation<T = unknown> extends SessionObservation<T> {
  sessionId: string | null;
}

export interface CodingSessionCleanup {
  cleanupTask(stateDirectory: string, taskId: string): Promise<void>;
  cleanupOwned(stateDirectory: string): Promise<void>;
}

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<Codex>;

type AdapterOverrides = Partial<Record<"sdk" | "app-server" | "opencode2", CodingSessionAdapter>>;
const internalAdapterOverrides = new WeakMap<CodexCodingSession, AdapterOverrides>();

function outputFrom(result: { finalResponse: string }): unknown {
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
  private readonly adapterProfiles: CodingSessionAdapterProfiles;
  private readonly profileResolver: CodexProfileResolver;
  private readonly sdkAdapter: CodingSessionAdapter;
  private readonly appServerAdapter: CodingSessionAdapter;
  private readonly openCode2Adapter: CodingSessionAdapter;

  constructor(
    private readonly clientFactory?: CodingSessionClientFactory,
    private readonly options: CodingSessionOptions = { environment: process.env },
  ) {
    this.adapterProfiles = codingSessionAdapterProfilesFromEnvironment(
      options.adapterSelectionEnvironment ?? {},
    );
    this.profileResolver = options.profileResolver ?? resolveCodexProfile;
    this.sdkAdapter = new CodexSdkAdapter({ codexPathOverride: options.codexPathOverride });
    this.appServerAdapter = new CodexAppServerAdapter();
    this.openCode2Adapter = new OpenCode2Adapter();
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
                  try: () => reapOwnedExecution(executionStateDirectory, execution),
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
    const { sessionId: _sessionId, ...publicObservation } = observation;
    if (!archive)
      return {
        ...publicObservation,
        requestedProfile: publicObservation.requestedProfile ?? request.profile,
        effectiveProfile: publicObservation.effectiveProfile ?? unavailableEffectiveProfile(),
      };
    const archiveResult = await archive.finish({
      status: observation.status,
      sessionId: observation.sessionId,
      usage: observation.usage,
      failure: observation.failure,
      phase: observation.phase,
      failureClass: observation.failureClass,
    });
    return {
      ...publicObservation,
      requestedProfile: publicObservation.requestedProfile ?? request.profile,
      effectiveProfile: publicObservation.effectiveProfile ?? unavailableEffectiveProfile(),
      archiveId: archiveResult.archiveId,
      archiveStatus: archiveResult.archiveStatus,
      archiveCompleteness: archiveResult.completeness,
      archiveWarnings: archiveResult.warnings,
    };
  }

  private async runProviderCaptured<T = unknown>(
    request: SessionRequest<T>,
    archive?: SessionArchiveWriter,
  ): Promise<CapturedSessionObservation<T>> {
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
    let effectiveProfile = unavailableEffectiveProfile();
    let observedUsage: ProviderNeutralUsage | null = null;
    let normalizerUsage: ProviderNeutralUsage | null = null;
    let normalizerActualModel: { model: string; provider: string } | undefined;
    let normalizerAttempted = false;
    try {
      const profileName = validateCodexProfile(request.profile);
      let profileSelection: ResolvedCodexProfile;
      try {
        profileSelection = normalizeCodexProfileSelection(
          profileName,
          await this.profileResolver(profileName, request.environment ?? this.options.environment),
        );
        const snapshot = sessionArchiveProfileSnapshot(profileName, {
          ...profileSelection,
          ...profileSelection.config,
        });
        archive?.setProfile(snapshot);
        effectiveProfile = {
          profileName,
          configSha256: profileSelection.configSha256,
          adapter: null,
          model: safeEvidenceIdentity(snapshot.model),
          modelProvider: safeEvidenceIdentity(snapshot.modelProvider),
          reasoningEffort: snapshot.modelReasoningEffort ?? null,
          developerInstructionsSha256: snapshot.developerInstructions
            ? hashText(snapshot.developerInstructions)
            : null,
          serviceTier: safeEvidenceIdentity(snapshot.serviceTier),
        };
      } catch (error) {
        if (error instanceof CodexProfileSelectionError) throw error;
        throw new CodexProfileSelectionError(
          profileName,
          `named profile "${profileName}" has an unreadable Codex configuration`,
        );
      }
      let effectiveRequest = request;
      let adapterMcpServer: CodingSessionAdapterRequest["mcpServer"];
      const onObservation = request.onObservation
        ? (observation: CodingSessionObservation) =>
            request.onObservation?.(sanitizeSessionObservation(observation))
        : undefined;
      if (!request.mcpServer && this.options.mcpServerFactory) {
        let resolution: CodingSessionMcpServerResolution;
        try {
          resolution = await this.options.mcpServerFactory(request);
        } catch {
          resolution = { serverName: "github_read", status: "unavailable", reason: "unavailable" };
        }
        if (resolution.status === "unavailable") {
          await onObservation?.({
            type: "mcp_unavailable",
            server: safeObservationLabel(resolution.serverName),
            reason: resolution.reason ?? "unavailable",
          });
        } else if (resolution.server) {
          effectiveRequest = { ...request, mcpServer: resolution.server };
        } else {
          await onObservation?.({
            type: "mcp_unavailable",
            server: safeObservationLabel(resolution.serverName),
            reason: "unavailable",
          });
        }
      }
      if (effectiveRequest.mcpServer)
        adapterMcpServer = normalizeCodingSessionMcpServer(effectiveRequest.mcpServer);
      const clientFactory = this.clientFactory;
      const adapterOverrides = internalAdapterOverrides.get(this);
      const adapterName = codingSessionAdapterForProfile(profileName, this.adapterProfiles);
      const adapter =
        adapterName === "opencode2"
          ? (adapterOverrides?.opencode2 ?? this.openCode2Adapter)
          : adapterName === "app-server"
            ? (adapterOverrides?.["app-server"] ?? this.appServerAdapter)
            : (adapterOverrides?.sdk ??
              (clientFactory
                ? new CodexSdkAdapter({ clientFactory: () => clientFactory(effectiveRequest) })
                : this.sdkAdapter));
      effectiveProfile = { ...effectiveProfile, adapter: adapter.name };
      archive?.setAdapter(adapter.name);
      const observeUsage = async (
        source: "provider" | "role_output_normalizer",
        observation: ProviderNeutralUsageObservation,
      ) => {
        if (source === "provider")
          observedUsage =
            observation.semantics === "replacement"
              ? observation.usage
              : mergeProviderNeutralUsage(observedUsage, observation.usage);
        else {
          if (observation.actualModel) normalizerActualModel = observation.actualModel;
          normalizerUsage =
            observation.semantics === "replacement"
              ? observation.usage
              : mergeProviderNeutralUsage(normalizerUsage, observation.usage);
        }
        if (source === "provider") archive?.setUsage(usageFrom(observedUsage));
        await onObservation?.({ type: "usage_observed", source, ...observation });
      };
      const result = await adapter.run({
        workspace: effectiveRequest.workspace,
        prompt: effectiveRequest.prompt,
        sandbox: effectiveRequest.sandbox,
        approvalPolicy: "never",
        profile: codingSessionAdapterProfile(profileSelection),
        mcpServer: adapterMcpServer,
        outputSchema: z.toJSONSchema(effectiveRequest.outputSchema, { target: "openAi" }),
        environment: explicitWorkerEnvironment(
          effectiveRequest.environment ?? this.options.environment,
        ),
        executionStateDirectory: this.options.executionStateDirectory,
        execution: effectiveRequest.execution,
        signal: abortSignal,
        onObservation,
        onItemCompleted: async (item) => {
          archive?.addCompletedItem(item);
          await emitCompletedEvidenceObservation(item, onObservation);
        },
        onSessionId: (sessionId) => archive?.setSessionId(sessionId),
        onPhase: (nextPhase) => {
          phase = nextPhase;
          archive?.setPhase(nextPhase);
        },
        onUsage: (observation) => observeUsage("provider", observation),
      });
      if (result.actualModel)
        effectiveProfile = {
          ...effectiveProfile,
          actualModel: safeModelIdentity(result.actualModel.model),
          actualModelProvider: safeModelIdentity(result.actualModel.provider),
        };
      phase = "output";
      archive?.setPhase("output");
      archive?.setSessionId(result.sessionId);
      const providerUsage = result.usage ?? observedUsage;
      archive?.setProviderResult(result.finalResponse, usageFrom(providerUsage));
      let parsed = effectiveRequest.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        if (!this.options.roleOutputTransform) {
          return {
            requestedProfile: request.profile,
            effectiveProfile,
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(providerUsage),
            summary: "coding session output normalization unavailable",
            failure: "coding session output normalization unavailable",
            phase,
            failureClass: "configuration",
            failureCode: "role_output_transform_unconfigured",
          };
        }
        normalizerAttempted = true;
        let normalized: unknown;
        try {
          normalized = await runRoleOutputTransform(this.options.roleOutputTransform, {
            finalResponse: result.finalResponse,
            outputSchema: effectiveRequest.outputSchema,
            signal: abortSignal,
            onUsage: (observation) => observeUsage("role_output_normalizer", observation),
          });
        } catch (error) {
          if (abortSignal.aborted)
            return {
              requestedProfile: request.profile,
              effectiveProfile,
              status: "cancelled",
              sessionId: null,
              output: null,
              usage: usageFrom(providerUsage),
              normalizer: normalizerObservation(
                this.options.roleOutputTransform,
                normalizerUsage,
                "cancelled",
                normalizerActualModel?.model ?? null,
                normalizerActualModel?.provider ?? null,
              ),
              summary: "coding session cancelled",
              failure: "coding session cancelled",
              phase,
              failureClass: deadlineSignal.aborted ? "timeout" : "cancellation",
            };
          return {
            requestedProfile: request.profile,
            effectiveProfile,
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(providerUsage),
            summary: "coding session output normalization failed",
            failure: "coding session output normalization failed",
            phase,
            failureClass: classifyAdapterFailure(error),
            failureCode: "role_output_transform_failed",
            normalizer: normalizerObservation(
              this.options.roleOutputTransform,
              normalizerUsage,
              "failed",
              normalizerActualModel?.model ?? null,
              normalizerActualModel?.provider ?? null,
            ),
          };
        }
        archive?.setNormalizedOutput(normalized);
        parsed = effectiveRequest.outputSchema.safeParse(normalized);
        if (!parsed.success) {
          return {
            requestedProfile: request.profile,
            effectiveProfile,
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(providerUsage),
            summary: "coding session normalized output did not match role schema",
            failure: "coding session normalized output did not match role schema",
            phase,
            failureClass: "configuration",
            failureCode: "role_output_schema_invalid",
            normalizer: normalizerObservation(
              this.options.roleOutputTransform,
              normalizerUsage,
              "succeeded",
              normalizerActualModel?.model ?? null,
              normalizerActualModel?.provider ?? null,
            ),
          };
        }
      }
      archive?.setNormalizedOutput(parsed.data);
      return {
        requestedProfile: request.profile,
        effectiveProfile,
        status: "completed",
        sessionId: result.sessionId,
        output: parsed.data,
        usage: usageFrom(providerUsage),
        summary: "coding session completed",
        failure: null,
        phase: null,
        failureClass: null,
        ...(normalizerAttempted
          ? {
              normalizer: normalizerObservation(
                this.options.roleOutputTransform,
                normalizerUsage,
                "succeeded",
                normalizerActualModel?.model ?? null,
                normalizerActualModel?.provider ?? null,
              ),
            }
          : {}),
      };
    } catch (error) {
      const deadlineExpired = deadlineSignal.aborted;
      const cancelled = request.signal?.aborted;
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
        requestedProfile: request.profile,
        effectiveProfile,
        status: deadlineExpired || cancelled ? "cancelled" : "failed",
        sessionId: null,
        output: null,
        usage: usageFrom(observedUsage),
        summary: safeFailureMessage(interruption),
        failure: safeFailureMessage(interruption),
        phase: interruption.phase,
        failureClass: interruption.failureClass,
        failureCode: error instanceof CodexProfileSelectionError ? error.code : null,
        ...(normalizerAttempted
          ? {
              normalizer: normalizerObservation(
                this.options.roleOutputTransform,
                normalizerUsage,
                abortSignal.aborted ? "cancelled" : "failed",
                normalizerActualModel?.model ?? null,
                normalizerActualModel?.provider ?? null,
              ),
            }
          : {}),
      };
    }
  }
}

async function emitCompletedEvidenceObservation(
  evidence: ProviderNeutralCompletedEvidence,
  onObservation: SessionRequest["onObservation"],
): Promise<void> {
  const outcome = evidence.status === "completed" ? "succeeded" : "failed";
  switch (evidence.type) {
    case "command_execution":
      await onObservation?.({ type: "tool_completed", tool: "shell", outcome });
      break;
    case "file_change":
      await onObservation?.({ type: "tool_completed", tool: "apply_patch", outcome });
      break;
    case "mcp_tool_call":
      await onObservation?.({
        type: "mcp_tool_completed",
        server: evidence.server,
        tool: evidence.tool,
        outcome,
      });
      break;
    case "web_search":
      await onObservation?.({ type: "tool_completed", tool: "search", outcome });
      break;
    case "agent_message":
    case "reasoning":
    case "other":
      break;
  }
}

function sanitizeSessionObservation(
  observation: CodingSessionObservation,
): CodingSessionObservation {
  if (observation.type !== "mcp_tool_completed") return observation;
  return {
    ...observation,
    server: safeObservationLabel(observation.server),
    tool: safeObservationLabel(observation.tool),
  };
}

/** Source-internal adapter substitution for bounded package tests. */
export function createCodexCodingSessionForTesting(
  clientFactory: CodingSessionClientFactory | undefined,
  options: CodingSessionOptions,
  adapters: AdapterOverrides,
): CodexCodingSession {
  const session = new CodexCodingSession(clientFactory, options);
  internalAdapterOverrides.set(session, adapters);
  return session;
}

function usageFrom(usage: ProviderNeutralUsage | null | undefined): SessionObservation["usage"] {
  if (usage == null) return null;
  const normalized = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: usage.uncachedInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoningOutputTokens }),
  };
  return Object.keys(normalized).length === 0 ? null : normalized;
}

function normalizerObservation(
  transform: RoleOutputTransform | undefined,
  usage: ProviderNeutralUsage | null,
  status: RoleOutputNormalizerObservation["status"],
  actualModel: string | null = null,
  actualModelProvider: string | null = null,
): RoleOutputNormalizerObservation {
  return {
    status,
    usage: usageFrom(usage),
    adapter: "role-output-normalizer",
    model: safeEvidenceIdentity(transform?.profile?.model) ?? null,
    modelProvider: safeEvidenceIdentity(transform?.profile?.modelProvider) ?? null,
    actualModel: safeModelIdentity(actualModel),
    actualModelProvider: safeModelIdentity(actualModelProvider),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEvidenceIdentity(value: unknown): string | null {
  return safeModelIdentity(value);
}

function safeModelIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/.test(value))
    return null;
  if (
    value.includes("://") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    /(?:api[_-]?key|secret|token|password|credential|bearer)/i.test(value)
  )
    return null;
  const firstSegment = value.split("/")[0]!;
  if (
    firstSegment.includes(".") &&
    /^[A-Za-z0-9.-]+$/.test(firstSegment) &&
    /^[A-Za-z]/.test(firstSegment.split(".").at(-1)!)
  )
    return null;
  if (/:[0-9]+(?:\/|$)/.test(value)) return null;
  return value;
}

function unavailableEffectiveProfile(): EffectiveSessionProfile {
  return {
    profileName: null,
    configSha256: null,
    adapter: null,
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    developerInstructionsSha256: null,
    serviceTier: null,
    actualModel: null,
    actualModelProvider: null,
  };
}

function safeFailureMessage(error: CodingSessionInterruption): string {
  const message = error.message;
  if (/^app-server [a-z ]+( \([a-z_]+\))?$/.test(message)) return message;
  if (/^Codex profile is unusable: named profile "[A-Za-z0-9._:-]+" /.test(message)) return message;
  return `coding session provider interruption (${error.failureClass})`;
}
