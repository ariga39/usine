import type { TaskContract } from "./contract.js";

export type SessionRole = "implementer" | "reviewer";
export type SandboxMode = "workspace-write" | "read-only";

export interface SessionRequest {
  role: SessionRole;
  workspace: string;
  contract: TaskContract;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: Record<string, unknown>;
  continuation?: string | null;
  environment?: NodeJS.ProcessEnv;
}

export interface SessionObservation<T = unknown> {
  status: "completed" | "failed" | "cancelled";
  sessionId: string | null;
  output: T | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  summary: string;
  failure: string | null;
}

interface Thread {
  id?: string | null;
  run(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface CodexClient {
  startThread(options?: Record<string, unknown>): Thread;
  resumeThread?(id: string, options?: Record<string, unknown>): Thread;
}

function environmentFor(request: SessionRequest): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CI: "true", ...(request.environment ?? {}) };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined && result[key] === undefined) result[key] = process.env[key];
  }
  // Delivery and coordinator credentials never enter a coding worker.
  for (const key of ["USINE_DATABASE_URL", "USINE_STATE_DIR", "USINE_GITHUB_TEST_TOKEN", "USINE_GITHUB_APP_ID", "USINE_GITHUB_INSTALLATION_ID", "USINE_GITHUB_PRIVATE_KEY_PATH", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"]) delete result[key];
  return result;
}

function outputFrom(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as { finalResponse?: unknown; output?: unknown; text?: unknown };
  if (value.output !== undefined) return value.output;
  if (value.finalResponse !== undefined) return value.finalResponse;
  return value.text !== undefined ? value.text : result;
}

function sessionIdFrom(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as { threadId?: unknown; thread_id?: unknown; sessionId?: unknown };
  for (const candidate of [value.threadId, value.thread_id, value.sessionId]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export class CodexCodingSession {
  async run<T = unknown>(request: SessionRequest): Promise<SessionObservation<T>> {
    const remaining = request.deadlineEpochMs - Date.now() - 100;
    if (remaining <= 0) return { status: "failed", sessionId: null, output: null, usage: null, summary: "elapsed budget exhausted", failure: "elapsed budget exhausted" };
    const abortSignal = AbortSignal.timeout(remaining);
    try {
      const sdk = (await import("@openai/codex-sdk")) as unknown as { Codex: new (options?: Record<string, unknown>) => CodexClient };
      const client = new sdk.Codex({
        env: environmentFor(request),
        config: { model_reasoning_effort: request.reasoningEffort ?? "high", service_tier: "default" },
      });
      const thread = request.continuation && client.resumeThread
        ? client.resumeThread(request.continuation, { model: request.model, sandboxMode: request.sandbox, workingDirectory: request.workspace })
        : client.startThread({ model: request.model, sandboxMode: request.sandbox, workingDirectory: request.workspace });
      const result = await thread.run(request.prompt, {
        signal: abortSignal,
        outputSchema: request.outputSchema,
        env: environmentFor(request),
      });
      const output = outputFrom(result) as T;
      return {
        status: "completed",
        sessionId: thread.id ?? sessionIdFrom(result),
        output,
        usage: usageFrom(result),
        summary: "coding session completed",
        failure: null,
      };
    } catch (error) {
      const cancelled = abortSignal.aborted;
      const failure = error instanceof Error ? error.message : String(error);
      return { status: cancelled ? "cancelled" : "failed", sessionId: null, output: null, usage: null, summary: failure, failure };
    }
  }
}

function usageFrom(result: unknown): SessionObservation["usage"] {
  if (!result || typeof result !== "object") return null;
  const usage = (result as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const value = usage as { input_tokens?: unknown; output_tokens?: unknown; inputTokens?: unknown; outputTokens?: unknown };
  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : typeof value.inputTokens === "number" ? value.inputTokens : undefined;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : typeof value.outputTokens === "number" ? value.outputTokens : undefined;
  return inputTokens === undefined && outputTokens === undefined ? null : { inputTokens, outputTokens };
}
