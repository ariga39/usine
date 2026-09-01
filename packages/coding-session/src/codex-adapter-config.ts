import type { CodexOptions } from "@openai/codex-sdk";
import type {
  CodingSessionAdapterMcpServer,
  CodingSessionAdapterProfile,
  ProviderNeutralJsonValue,
} from "./coding-session-adapter.js";

export type CodexNativeConfig = NonNullable<CodexOptions["config"]>;

/** Codex's native config projection is private to its peer adapters. */
export function codexAdapterConfig(
  profile: CodingSessionAdapterProfile,
  mcpServer?: CodingSessionAdapterMcpServer,
): CodexNativeConfig {
  return {
    ...(profile.modelCatalogJson ? { model_catalog_json: profile.modelCatalogJson } : {}),
    ...(profile.modelProvider ? { model_provider: profile.modelProvider } : {}),
    ...(profile.modelProviders !== undefined
      ? { model_providers: toCodexConfigValue(profile.modelProviders) }
      : {}),
    ...(profile.reasoningSummary ? { model_reasoning_summary: profile.reasoningSummary } : {}),
    ...(profile.verbosity ? { model_verbosity: profile.verbosity } : {}),
    ...(profile.personality ? { personality: profile.personality } : {}),
    ...(profile.serviceTier ? { service_tier: profile.serviceTier } : {}),
    ...(profile.developerInstructions
      ? { developer_instructions: profile.developerInstructions }
      : {}),
    model: profile.model,
    ...(profile.reasoningEffort ? { model_reasoning_effort: profile.reasoningEffort } : {}),
    approval_policy: "never",
    mcp_servers: {},
    ...(mcpServer ? codexMcpServerConfig(mcpServer) : {}),
  };
}

function toCodexConfigValue(value: ProviderNeutralJsonValue): CodexNativeConfig[string] {
  if (Array.isArray(value))
    return value.map(toCodexConfigValue) as unknown as CodexNativeConfig[string];
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toCodexConfigValue(child)]),
    );
  return value as unknown as CodexNativeConfig[string];
}

function codexMcpServerConfig(
  server: CodingSessionAdapterMcpServer,
): Pick<CodexNativeConfig, "approval_policy" | "mcp_servers"> {
  return {
    approval_policy: "never",
    mcp_servers: {
      [server.name]: {
        url: server.url,
        enabled_tools: [...server.enabledTools],
        tools: Object.fromEntries(
          server.enabledTools.map((tool) => [tool, { approval_mode: "approve" }]),
        ),
        startup_timeout_sec: server.startupTimeoutMs / 1_000,
        tool_timeout_sec: server.toolTimeoutMs / 1_000,
        required: server.required,
      },
    },
  };
}
