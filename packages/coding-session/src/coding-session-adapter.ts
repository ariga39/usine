import type { CodingSessionObservation } from "./coding-session.js";
import type { CodingSessionPhase } from "./coding-session-interruption.js";

export type ProviderNeutralJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderNeutralJsonValue[]
  | { readonly [key: string]: ProviderNeutralJsonValue };

type CompletedEvidenceBase = {
  readonly id: string;
  readonly status: "completed" | "failed";
};

export interface ProviderNeutralUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface ProviderNeutralUsageObservation {
  readonly usage: ProviderNeutralUsage;
  readonly semantics: "delta" | "replacement";
  readonly actualModel?: { readonly model: string; readonly provider: string };
}

export interface CodingSessionAdapterProfile {
  readonly model: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly developerInstructions?: string;
  readonly modelCatalogJson?: string;
  readonly modelProvider?: string;
  readonly modelProviders?: ProviderNeutralJsonValue;
  readonly reasoningSummary?: string;
  readonly verbosity?: string;
  readonly personality?: string;
  readonly serviceTier?: string;
}

export interface CodingSessionAdapterMcpServer {
  readonly name: string;
  readonly url: string;
  readonly enabledTools: readonly string[];
  readonly startupTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly required: boolean;
}

/** Evidence normalized by an adapter before it crosses the provider seam. */
export type ProviderNeutralCompletedEvidence =
  | (CompletedEvidenceBase & {
      readonly type: "command_execution";
      readonly command?: ProviderNeutralJsonValue;
      readonly output?: ProviderNeutralJsonValue;
      readonly exitCode?: number;
    })
  | (CompletedEvidenceBase & {
      readonly type: "file_change";
      readonly changes?: ProviderNeutralJsonValue;
    })
  | (CompletedEvidenceBase & {
      readonly type: "mcp_tool_call";
      readonly server: string;
      readonly tool: string;
      readonly arguments?: ProviderNeutralJsonValue;
      readonly output?: ProviderNeutralJsonValue;
      readonly error?: ProviderNeutralJsonValue;
    })
  | (CompletedEvidenceBase & {
      readonly type: "agent_message" | "reasoning";
      readonly text?: string;
    })
  | (CompletedEvidenceBase & {
      readonly type: "web_search";
      readonly query?: string;
    })
  | (CompletedEvidenceBase & { readonly type: "other" });

export type PreparedOutputSchema = object;

/**
 * The only provider-facing seam in Coding Session. The facade has already
 * applied profile, MCP, deadline, environment, and cancellation policy.
 */
export interface CodingSessionAdapterRequest {
  readonly role: "implementer" | "reviewer";
  readonly workspace: string;
  readonly prompt: string;
  readonly sandbox: "workspace-write" | "read-only";
  readonly approvalPolicy: "never";
  readonly profile: CodingSessionAdapterProfile;
  readonly mcpServer?: CodingSessionAdapterMcpServer;
  readonly outputSchema: PreparedOutputSchema;
  readonly environment: Record<string, string>;
  readonly signal: AbortSignal;
  readonly onObservation?: (observation: CodingSessionObservation) => Promise<void> | void;
  readonly onItemCompleted?: (item: ProviderNeutralCompletedEvidence) => Promise<void> | void;
  readonly onSessionId?: (sessionId: string) => void;
  readonly onPhase?: (phase: CodingSessionPhase) => void;
  readonly onUsage?: (observation: ProviderNeutralUsageObservation) => Promise<void> | void;
}

export interface CodingSessionAdapterResult {
  readonly finalResponse: string;
  readonly usage: ProviderNeutralUsage | null;
  readonly sessionId: string | null;
  readonly actualModel?: { readonly model: string; readonly provider: string };
}

export interface CodingSessionAdapter {
  readonly name: "sdk" | "app-server" | "opencode2";
  run(request: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult>;
}

export function providerNeutralJsonValue(value: unknown): ProviderNeutralJsonValue | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : (JSON.parse(encoded) as ProviderNeutralJsonValue);
  } catch {
    return undefined;
  }
}
