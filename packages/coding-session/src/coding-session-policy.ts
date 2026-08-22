import type { CodexOptions } from "@openai/codex-sdk";
import type { CodingSessionMcpServer } from "./coding-session.js";

type CodexConfig = NonNullable<CodexOptions["config"]>;

export function codexMcpConfig(server: CodingSessionMcpServer): CodexConfig {
  const name = server.name.trim();
  const url = new URL(server.url);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error("MCP server name is unusable");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("MCP server URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("MCP server URL must not contain credentials");
  if (server.enabledTools.length === 0 || server.enabledTools.some((tool) => !tool.trim()))
    throw new Error("MCP server must allow at least one named tool");
  if (
    !Number.isFinite(server.startupTimeoutMs) ||
    server.startupTimeoutMs <= 0 ||
    !Number.isFinite(server.toolTimeoutMs) ||
    server.toolTimeoutMs <= 0
  )
    throw new Error("MCP server timeouts must be positive finite numbers");
  return {
    approval_policy: "never",
    mcp_servers: {
      [name]: {
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

export function safeObservationLabel(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value)
    ? value
    : "unknown";
}
