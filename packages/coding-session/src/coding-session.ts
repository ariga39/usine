import {
  Codex,
  type CodexOptions,
  type RunResult,
  type Thread,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
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
  model: string;
  reasoningEffort: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: z.ZodType<Output>;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
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

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<Codex>;

function outputFrom(result: RunResult): unknown {
  return parseJson(result.finalResponse);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
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
      const client = await this.createClient(request);
      const threadOptions: ThreadOptions = {
        model: request.model,
        sandboxMode: request.sandbox,
        workingDirectory: request.workspace,
      };
      const thread: Thread = client.startThread(threadOptions);
      const turnOptions: TurnOptions = {
        signal: abortSignal,
        outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
      };
      const result: RunResult = await thread.run(request.prompt, turnOptions);
      const parsed = request.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        return {
          status: "failed",
          sessionId: thread.id,
          output: null,
          usage: usageFrom(result.usage),
          summary: "coding session output did not match role schema",
          failure: "coding session output did not match role schema",
        };
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
      };
    }
  }

  private async createClient(request: SessionRequest): Promise<Codex> {
    if (this.clientFactory) return this.clientFactory(request);
    const options: CodexOptions = {
      env: explicitWorkerEnvironment(request.environment ?? this.options.environment),
      config: {
        model_reasoning_effort: request.reasoningEffort,
        service_tier: "default",
      },
    };
    return new Codex(options);
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
