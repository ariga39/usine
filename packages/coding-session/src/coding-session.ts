import { createHash } from "node:crypto";
import { Codex } from "@openai/codex-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { Effect } from "effect";
import {
  mergeProviderNeutralUsage,
  ElapsedBudgetError,
  remainingUntil,
  safeEvidenceIdentity,
  type GoalContract,
  type TaskContract,
  type NormalizedAcceptanceCriterion,
} from "@usine/task-authority";
import type { CampaignAssessmentEvidence, CampaignAssessmentFact } from "@usine/task-authority";
import { z } from "zod";
import {
  codingSessionAdapterForProfile,
  codingSessionAdapterProfilesFromEnvironment,
  type CodingSessionAdapterProfiles,
} from "./coding-session-config.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { OpenCode2Adapter } from "./opencode2-adapter.js";
import {
  type CodingSessionAdapter,
  type CodingSessionAdapterProfile,
  type CodingSessionAdapterRequest,
  type ProviderNeutralCompletedEvidence,
  type ProviderNeutralUsage,
  type ProviderNeutralUsageCompleteness,
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
  withCodexProfileDeveloperInstructions,
  type CodexProfileResolver,
} from "./codex-profile.js";
import {
  sessionArchiveProfileSnapshot,
  SessionArchiveWriter,
  type SessionArchiveCaptureStatus,
  type SessionArchiveOptions,
} from "./session-archive.js";
import { recoverReviewerOutput } from "./role-output.js";
import { composeRoleQualityPrompt, ROLE_QUALITY_INSTRUCTIONS } from "./role-quality-contract.js";

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

export type SessionRole = "implementer" | "reviewer" | "assessor" | "replacement-planner";
export type TaskSessionRole = "implementer" | "reviewer";
export type SandboxMode = "workspace-write" | "read-only";

export interface EffectiveSessionProfile {
  profileName: string | null;
  configSha256: string | null;
  adapter: "sdk" | "app-server" | "opencode2" | null;
  /** Canonical configured identity; the legacy aliases remain for compatibility. */
  configuredModel?: string | null;
  configuredProvider?: string | null;
  model: string | null;
  modelProvider: string | null;
  actualModel?: string | null;
  /** Provider-attested identity; it is never inferred from configured identity. */
  actualProvider?: string | null;
  actualModelProvider?: string | null;
  reasoningEffort: NonNullable<CodingSessionAdapterProfile["reasoningEffort"]> | null;
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

interface SessionRequestBase<Output = unknown> {
  attempt: string;
  workspace: string;
  prompt: string;
  profile: string;
  sandbox: SandboxMode;
  deadlineEpochMs?: number;
  outputSchema: z.ZodType<Output>;
  mcpServer?: CodingSessionMcpServer;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onObservation?: (observation: CodingSessionObservation) => Promise<void> | void;
}

export interface TaskSessionRequest<Output = unknown> extends SessionRequestBase<Output> {
  role: TaskSessionRole;
  contract: TaskContract;
}

export interface CampaignAssessmentSessionContext {
  readonly invocationId: string;
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly goal: {
    readonly id: GoalContract["id"];
    readonly version: GoalContract["version"];
    readonly objective: GoalContract["objective"];
    readonly authority: GoalContract["authority"];
    readonly warningThresholdMs?: GoalContract["warningThresholdMs"];
  };
  readonly outcome: {
    readonly id: string;
    readonly title: string;
    readonly acceptance: readonly string[];
    readonly criteria: readonly NormalizedAcceptanceCriterion[];
  };
  readonly evidence: readonly CampaignAssessmentFact[];
}

export interface CampaignAssessorSessionRequest<
  Output = unknown,
> extends SessionRequestBase<Output> {
  role: "assessor";
  assessment: CampaignAssessmentSessionContext;
}

export interface CampaignReplacementPlannerSessionContext {
  readonly invocationId: string;
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly goal: CampaignAssessmentSessionContext["goal"];
  readonly outcome: CampaignAssessmentSessionContext["outcome"];
  readonly assessment: {
    readonly assessmentId: string;
    readonly evidenceHash: string;
    readonly verdict: "gaps";
    readonly summary: string;
    readonly gaps: readonly string[];
    readonly evidence: readonly CampaignAssessmentEvidence[];
  };
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly rejectionFeedback?: {
    readonly status: "invalid" | "duplicate";
    readonly reason: string;
  };
  readonly priorProposals: readonly {
    readonly proposalId: string;
    readonly outcomeId: string;
    readonly repositoryId: string;
    readonly instructions: string;
    readonly acceptance: readonly string[];
    readonly effects: readonly string[];
    readonly merge: boolean;
  }[];
  readonly supersedableProposalIds: readonly string[];
  readonly repositories: readonly {
    readonly id: string;
    readonly owner: string;
    readonly name: string;
    readonly baseBranch: string;
    readonly headSha: string | null;
  }[];
}

export interface CampaignReplacementPlannerSessionRequest<
  Output = unknown,
> extends SessionRequestBase<Output> {
  role: "replacement-planner";
  replacement: CampaignReplacementPlannerSessionContext;
}

/** The existing Task-shaped port used by implementer and reviewer callers. */
export type SessionRequest<Output = unknown> = TaskSessionRequest<Output>;

/** The provider-neutral port accepted by the concrete Coding Session facade. */
export type CodingSessionRequest<Output = unknown> =
  | TaskSessionRequest<Output>
  | CampaignAssessorSessionRequest<Output>
  | CampaignReplacementPlannerSessionRequest<Output>;

export interface CodingSessionMcpServerResolution {
  serverName: string;
  status: "available" | "unavailable";
  server?: CodingSessionMcpServer;
  reason?: "startup_timeout" | "unavailable";
}

export type CodingSessionMcpServerFactory = (
  request: CodingSessionRequest,
) => Promise<CodingSessionMcpServerResolution>;

export type CodingSessionObservation =
  | { type: "thread_started" }
  | {
      type: "usage_observed";
      source: "provider" | "role_output_normalizer";
      usage: ProviderNeutralUsage;
      semantics: ProviderNeutralUsageObservation["semantics"];
      completeness?: ProviderNeutralUsageCompleteness;
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

const normalizerTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish();
const normalizerResponseUsage = z.object({
  usage: z
    .object({
      prompt_tokens: normalizerTokenCount,
      completion_tokens: normalizerTokenCount,
      prompt_cache_hit_tokens: normalizerTokenCount,
      prompt_cache_miss_tokens: normalizerTokenCount,
      prompt_tokens_details: z
        .object({
          cached_tokens: normalizerTokenCount,
          cache_write_tokens: normalizerTokenCount,
        })
        .nullish(),
      completion_tokens_details: z.object({ reasoning_tokens: normalizerTokenCount }).nullish(),
    })
    .nullish(),
});

function roleNormalizerUsage(body: unknown): ProviderNeutralUsage {
  const decoded = normalizerResponseUsage.safeParse(body);
  if (!decoded.success || !decoded.data.usage) return {};
  const raw = decoded.data.usage;
  const inputTokens = raw.prompt_tokens ?? undefined;
  const outputTokens = raw.completion_tokens ?? undefined;
  const nestedRead = raw.prompt_tokens_details?.cached_tokens ?? undefined;
  const alternateRead = raw.prompt_cache_hit_tokens ?? undefined;
  const read = nestedRead ?? alternateRead;
  const miss = raw.prompt_cache_miss_tokens ?? undefined;
  const write = raw.prompt_tokens_details?.cache_write_tokens ?? undefined;
  const contradictory =
    (nestedRead !== undefined && alternateRead !== undefined && nestedRead !== alternateRead) ||
    (inputTokens !== undefined &&
      ((read !== undefined && read > inputTokens) ||
        (miss !== undefined && miss > inputTokens) ||
        (write !== undefined && write > inputTokens) ||
        (read !== undefined && miss !== undefined && read + miss !== inputTokens) ||
        (read !== undefined && write !== undefined && read + write > inputTokens))) ||
    (miss !== undefined && write !== undefined && write > miss);
  // Reported misses include separately reported writes; subtract writes only once.
  const uncached =
    miss !== undefined
      ? miss - (write ?? 0)
      : inputTokens !== undefined && read !== undefined
        ? inputTokens - read - (write ?? 0)
        : undefined;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: contradictory ? undefined : read,
    uncachedInputTokens: contradictory ? undefined : uncached,
    cacheWriteInputTokens: contradictory ? undefined : write,
    reasoningOutputTokens:
      reasoning !== undefined && outputTokens !== undefined && reasoning > outputTokens
        ? undefined
        : reasoning,
  };
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
    const observeResponse = async (body: unknown, actualModel: string | undefined) => {
      await onUsage?.({
        semantics: "replacement",
        ...(actualModel
          ? { actualModel: { model: actualModel, provider: "openai-compatible" } }
          : {}),
        usage: roleNormalizerUsage(body),
      });
    };
    const result = await generateText({
      model: openai.chat(model),
      include: { responseBody: true },
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
    }).catch(async (error: unknown) => {
      if (NoObjectGeneratedError.isInstance(error) && error.response)
        await observeResponse(error.response.body, error.response.modelId);
      throw error;
    });
    await observeResponse(result.response.body, result.response.modelId);
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
  /** Host-private storage configured only for the concrete OpenCode2 adapter. */
  openCode2StateDirectory?: string;
  sessionArchive?: SessionArchiveOptions;
  profileResolver?: CodexProfileResolver;
  roleOutputTransform?: RoleOutputTransform;
  mcpServerFactory?: CodingSessionMcpServerFactory;
}

export interface SessionObservation<T = unknown> {
  status: "completed" | "failed" | "cancelled";
  output: T | null;
  usage: ProviderNeutralUsage | null;
  usageCompleteness?: ProviderNeutralUsageCompleteness;
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
  readonly configuredModel?: string | null;
  readonly configuredProvider?: string | null;
  readonly actualModel: string | null;
  readonly actualProvider?: string | null;
  readonly actualModelProvider: string | null;
}

interface CapturedSessionObservation<T = unknown> extends SessionObservation<T> {
  sessionId: string | null;
}

export type CodingSessionClientFactory = (request: CodingSessionRequest) => Promise<Codex>;

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
    this.openCode2Adapter = new OpenCode2Adapter(options.openCode2StateDirectory);
  }

  async run<T = unknown>(request: CodingSessionRequest<T>): Promise<SessionObservation<T>> {
    return Effect.runPromise(
      Effect.tryPromise({ try: () => this.runProvider(request), catch: identityError }),
    );
  }

  private async runProvider<T = unknown>(
    request: CodingSessionRequest<T>,
  ): Promise<SessionObservation<T>> {
    const roleRequest = {
      ...request,
      prompt: composeRoleQualityPrompt(request.role, request.prompt),
    };
    const archiveDirectory = this.options.sessionArchive?.stateDirectory;
    const archive = archiveDirectory
      ? new SessionArchiveWriter(
          this.options.sessionArchive ?? { stateDirectory: archiveDirectory },
          request.role === "assessor"
            ? {
                taskId: request.assessment.invocationId,
                role: request.role,
                attempt: request.attempt,
                contract: request.assessment,
                prompt: roleRequest.prompt,
              }
            : request.role === "replacement-planner"
              ? {
                  taskId: request.replacement.invocationId,
                  role: request.role,
                  attempt: request.attempt,
                  contract: request.replacement,
                  prompt: roleRequest.prompt,
                }
              : {
                  taskId: request.contract.id,
                  role: request.role,
                  attempt: request.attempt,
                  contract: request.contract,
                  prompt: roleRequest.prompt,
                },
        )
      : undefined;
    await archive?.begin();
    const observation = await this.runProviderCaptured(roleRequest, archive);
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
      usageCompleteness: observation.usageCompleteness,
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
    request: CodingSessionRequest<T>,
    archive?: SessionArchiveWriter,
  ): Promise<CapturedSessionObservation<T>> {
    let phase: CodingSessionPhase = "startup";
    const deadlineEpochMs = request.deadlineEpochMs;
    let deadlineSignal: AbortSignal | undefined;
    try {
      deadlineSignal =
        deadlineEpochMs === undefined
          ? undefined
          : AbortSignal.timeout(remainingUntil(deadlineEpochMs));
    } catch (error) {
      if (!(error instanceof ElapsedBudgetError)) throw error;
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
    const abortSignal =
      request.signal && deadlineSignal
        ? AbortSignal.any([request.signal, deadlineSignal])
        : (request.signal ?? deadlineSignal ?? new AbortController().signal);
    if (abortSignal.aborted) {
      const failureClass = deadlineSignal?.aborted ? "timeout" : "cancellation";
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
    let providerUsageCompleteness: ProviderNeutralUsageCompleteness | undefined;
    let normalizerUsage: ProviderNeutralUsage | null = null;
    let normalizerActualModel: { model: string; provider: string } | undefined;
    let normalizerAttempted = false;
    try {
      const profileName = validateCodexProfile(request.profile);
      let profileSelection: ResolvedCodexProfile;
      let effectiveProfileSelection: ResolvedCodexProfile;
      try {
        profileSelection = normalizeCodexProfileSelection(
          profileName,
          await this.profileResolver(profileName, request.environment ?? this.options.environment),
        );
        effectiveProfileSelection =
          request.role === "assessor" || request.role === "replacement-planner"
            ? withCodexProfileDeveloperInstructions(
                profileSelection,
                ROLE_QUALITY_INSTRUCTIONS[request.role],
              )
            : profileSelection;
        const snapshot = sessionArchiveProfileSnapshot(profileName, {
          ...effectiveProfileSelection,
          ...effectiveProfileSelection.config,
        });
        archive?.setProfile(snapshot);
        effectiveProfile = {
          profileName,
          configSha256: effectiveProfileSelection.configSha256,
          adapter: null,
          configuredModel: safeEvidenceIdentity(snapshot.model),
          configuredProvider: safeEvidenceIdentity(snapshot.modelProvider),
          model: safeEvidenceIdentity(snapshot.model),
          modelProvider: safeEvidenceIdentity(snapshot.modelProvider),
          actualModel: null,
          actualProvider: null,
          actualModelProvider: null,
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
        if (source === "provider") {
          if (observation.completeness !== undefined)
            providerUsageCompleteness = observation.completeness;
        } else {
          if (observation.actualModel) normalizerActualModel = observation.actualModel;
          normalizerUsage =
            observation.semantics === "replacement"
              ? observation.usage
              : mergeProviderNeutralUsage(normalizerUsage, observation.usage);
        }
        if (source === "provider")
          archive?.setUsage(usageFrom(observedUsage), observation.completeness);
        await onObservation?.({ type: "usage_observed", source, ...observation });
      };
      const result = await adapter.run({
        role: effectiveRequest.role,
        workspace: effectiveRequest.workspace,
        prompt: effectiveRequest.prompt,
        sandbox: effectiveRequest.sandbox,
        approvalPolicy: "never",
        profile: codingSessionAdapterProfile(effectiveProfileSelection),
        mcpServer: adapterMcpServer,
        outputSchema: z.toJSONSchema(effectiveRequest.outputSchema, { target: "openAi" }),
        environment: explicitWorkerEnvironment(
          effectiveRequest.environment ?? this.options.environment,
        ),
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
          actualModel: safeEvidenceIdentity(result.actualModel.model),
          actualProvider: safeEvidenceIdentity(result.actualModel.provider),
          actualModelProvider: safeEvidenceIdentity(result.actualModel.provider),
        };
      phase = "output";
      archive?.setPhase("output");
      archive?.setSessionId(result.sessionId);
      const providerUsage = result.usage ?? observedUsage;
      archive?.setProviderResult(
        result.finalResponse,
        usageFrom(providerUsage),
        providerUsageCompleteness,
      );
      let parsed = effectiveRequest.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success && effectiveRequest.role === "reviewer") {
        const recovered = recoverReviewerOutput(result.finalResponse);
        if (recovered !== undefined) parsed = effectiveRequest.outputSchema.safeParse(recovered);
      }
      if (!parsed.success) {
        if (!this.options.roleOutputTransform) {
          return {
            requestedProfile: request.profile,
            effectiveProfile,
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(providerUsage),
            ...usageCompletenessFrom(providerUsageCompleteness),
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
              ...usageCompletenessFrom(providerUsageCompleteness),
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
              failureClass: deadlineSignal?.aborted ? "timeout" : "cancellation",
            };
          return {
            requestedProfile: request.profile,
            effectiveProfile,
            status: "failed",
            sessionId: result.sessionId,
            output: null,
            usage: usageFrom(providerUsage),
            ...usageCompletenessFrom(providerUsageCompleteness),
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
            ...usageCompletenessFrom(providerUsageCompleteness),
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
        ...usageCompletenessFrom(providerUsageCompleteness),
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
      const deadlineExpired = deadlineSignal?.aborted === true;
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
        ...usageCompletenessFrom(providerUsageCompleteness),
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
  onObservation: CodingSessionRequest["onObservation"],
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

function usageCompletenessFrom(
  completeness: ProviderNeutralUsageCompleteness | undefined,
): Pick<SessionObservation, "usageCompleteness"> {
  return completeness === undefined ? {} : { usageCompleteness: completeness };
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
    configuredModel: safeEvidenceIdentity(transform?.profile?.model) ?? null,
    configuredProvider: safeEvidenceIdentity(transform?.profile?.modelProvider) ?? null,
    actualModel: safeEvidenceIdentity(actualModel),
    actualProvider: safeEvidenceIdentity(actualModelProvider),
    actualModelProvider: safeEvidenceIdentity(actualModelProvider),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unavailableEffectiveProfile(): EffectiveSessionProfile {
  return {
    profileName: null,
    configSha256: null,
    adapter: null,
    configuredModel: null,
    configuredProvider: null,
    model: null,
    modelProvider: null,
    reasoningEffort: null,
    developerInstructionsSha256: null,
    serviceTier: null,
    actualModel: null,
    actualProvider: null,
    actualModelProvider: null,
  };
}

function safeFailureMessage(error: CodingSessionInterruption): string {
  const message = error.message;
  if (/^app-server [a-z ]+( \([a-z_]+\))?$/.test(message)) return message;
  if (/^Codex profile is unusable: named profile "[A-Za-z0-9._:-]+" /.test(message)) return message;
  return `coding session provider interruption (${error.failureClass})`;
}
