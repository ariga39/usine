import {
  Codex,
  type CodexOptions,
  type RunResult,
  type Thread,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remainingUntil, type TaskContract } from "@usine/task-authority";
import { z } from "zod";
import { createCodexLauncher, removeCodexExecutionIdentity } from "./codex-execution.js";

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

export class CodexProfileSelectionError extends Error {
  readonly code = "codex_profile_unusable" as const;

  constructor(
    readonly profile: string,
    reason = "must be a non-blank safe profile name",
  ) {
    super(`Codex profile is unusable: ${reason}`);
    this.name = "CodexProfileSelectionError";
  }
}

export function validateCodexProfile(profile: string): string {
  const normalized = profile.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized))
    throw new CodexProfileSelectionError(profile);
  return normalized;
}

async function ensureCodexProfileUsable(
  profile: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const normalized = validateCodexProfile(profile);
  const codexHome = environment.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    const profileFile = await stat(join(codexHome, `${normalized}.config.toml`));
    if (!profileFile.isFile()) throw new Error("profile configuration is not a regular file");
  } catch {
    throw new CodexProfileSelectionError(
      profile,
      `named profile "${normalized}" does not have a usable Codex configuration`,
    );
  }
  return normalized;
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
  profile: string;
  sandbox: SandboxMode;
  deadlineEpochMs: number;
  outputSchema: z.ZodType<Output>;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

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
  roleOutputTransform?: RoleOutputTransform;
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

export type CodingSessionClientFactory = (request: SessionRequest) => Promise<Codex>;

function outputFrom(result: RunResult): unknown {
  try {
    return JSON.parse(result.finalResponse) as unknown;
  } catch {
    return undefined;
  }
}

class RoleOutputTransformCancelled extends Error {}

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
      validateCodexProfile(request.profile);
      const client = await this.createClient(request);
      const threadOptions: ThreadOptions = {
        sandboxMode: request.sandbox,
        workingDirectory: request.workspace,
      };
      const thread: Thread = client.startThread(threadOptions);
      const turnOptions: TurnOptions = {
        signal: abortSignal,
        outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
      };
      const result: RunResult = await thread.run(request.prompt, turnOptions);
      let parsed = request.outputSchema.safeParse(outputFrom(result));
      if (!parsed.success) {
        if (!this.options.roleOutputTransform) {
          return {
            status: "failed",
            sessionId: thread.id,
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
            outputSchema: request.outputSchema,
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
            sessionId: thread.id,
            output: null,
            usage: usageFrom(result.usage),
            summary: "coding session output normalization failed",
            failure: "coding session output normalization failed",
            failureCode: "role_output_transform_failed",
          };
        }
        parsed = request.outputSchema.safeParse(normalized);
        if (!parsed.success) {
          return {
            status: "failed",
            sessionId: thread.id,
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
        failureCode: error instanceof CodexProfileSelectionError ? error.code : null,
      };
    } finally {
      if (this.options.executionStateDirectory) {
        await removeCodexExecutionIdentity(this.options.executionStateDirectory, request.workspace);
      }
    }
  }

  private async createClient(request: SessionRequest): Promise<Codex> {
    if (this.clientFactory) return this.clientFactory(request);
    const profile = await ensureCodexProfileUsable(
      request.profile,
      request.environment ?? this.options.environment,
    );
    const options: CodexOptions = {
      env: explicitWorkerEnvironment(request.environment ?? this.options.environment),
    };
    if (!this.options.executionStateDirectory) return new Codex(options);
    const launcher = await createCodexLauncher(
      this.options.executionStateDirectory,
      request.workspace,
      profile,
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

function usageFrom(usage: Usage | null | undefined): SessionObservation["usage"] {
  return usage == null
    ? null
    : {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      };
}
