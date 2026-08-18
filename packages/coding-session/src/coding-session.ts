import { remainingUntil, type TaskContract } from "@usine/task-authority";
import { z } from "zod";

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
] as const;

export interface RolePolicy {
  role: "implementer" | "reviewer";
  model: string;
  reasoningEffort: string;
  sandbox: "workspace-write" | "read-only";
}

export function explicitWorkerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CI: "true" };
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
  model: string;
  reasoningEffort: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: z.ZodType<Output>;
  environment?: NodeJS.ProcessEnv;
}

export interface CodingSessionOptions {
  environment: NodeJS.ProcessEnv;
}

export interface SessionObservation<T = unknown> {
  status: "completed" | "failed" | "cancelled";
  sessionId: string | null;
  output: T | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  summary: string;
  failure: string | null;
}

export interface CodingThread {
  id?: string | null;
  run(prompt: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface CodingSessionClient {
  startThread(options?: Record<string, unknown>): CodingThread;
}

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<CodingSessionClient>;

function outputFrom(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as { finalResponse?: unknown; output?: unknown; text?: unknown };
  if (value.output !== undefined) return parseJson(value.output);
  if (typeof value.finalResponse === "string") {
    return parseJson(value.finalResponse);
  }
  if (value.finalResponse !== undefined) return parseJson(value.finalResponse);
  return value.text !== undefined ? parseJson(value.text) : result;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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
  constructor(
    private readonly clientFactory?: CodingSessionClientFactory,
    private readonly options: CodingSessionOptions = { environment: process.env },
  ) {}

  async run<T = unknown>(request: SessionRequest<T>): Promise<SessionObservation<T>> {
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
    const abortSignal = AbortSignal.timeout(remaining);
    try {
      const client = await this.createClient(request);
      const thread = client.startThread({
        model: request.model,
        sandboxMode: request.sandbox,
        workingDirectory: request.workspace,
      });
      const result = await thread.run(request.prompt, {
        signal: abortSignal,
        outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
      });
      const parsed = request.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        return {
          status: "failed",
          sessionId: thread.id ?? sessionIdFrom(result),
          output: null,
          usage: usageFrom(result),
          summary: "coding session output did not match role schema",
          failure: "coding session output did not match role schema",
        };
      }
      return {
        status: "completed",
        sessionId: thread.id ?? sessionIdFrom(result),
        output: parsed.data,
        usage: usageFrom(result),
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
      };
    }
  }

  private async createClient(request: SessionRequest): Promise<CodingSessionClient> {
    if (this.clientFactory) return this.clientFactory(request);
    const sdk = (await import("@openai/codex-sdk")) as unknown as {
      Codex: new (options?: Record<string, unknown>) => CodingSessionClient;
    };
    return new sdk.Codex({
      env: explicitWorkerEnvironment(request.environment ?? this.options.environment),
      config: {
        model_reasoning_effort: request.reasoningEffort,
        service_tier: "default",
      },
    });
  }
}

function usageFrom(result: unknown): SessionObservation["usage"] {
  if (!result || typeof result !== "object") return null;
  const usage = (result as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const value = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  const inputTokens =
    typeof value.input_tokens === "number"
      ? value.input_tokens
      : typeof value.inputTokens === "number"
        ? value.inputTokens
        : undefined;
  const outputTokens =
    typeof value.output_tokens === "number"
      ? value.output_tokens
      : typeof value.outputTokens === "number"
        ? value.outputTokens
        : undefined;
  return inputTokens === undefined && outputTokens === undefined
    ? null
    : { inputTokens, outputTokens };
}
