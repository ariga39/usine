import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { z } from "zod";
import { codexAdapterConfig } from "./codex-adapter-config.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
} from "./coding-session-interruption.js";
import {
  providerNeutralJsonValue,
  type CodingSessionAdapter,
  type CodingSessionAdapterRequest,
  type CodingSessionAdapterResult,
  type ProviderNeutralCompletedEvidence,
  type ProviderNeutralUsageCompleteness,
  type ProviderNeutralUsage,
} from "./coding-session-adapter.js";
import { safeObservationLabel } from "./coding-session-policy.js";

interface CodexSdkAdapterOptions {
  readonly clientFactory?: () => Promise<Codex>;
  readonly codexPathOverride?: string;
}

// Keep artifact acquisition bounded without rejecting a long invocation log.
const CODEX_ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;
// A malformed/pathological JSONL record is skipped without retaining unbounded input.
const CODEX_ARTIFACT_MAX_LINE_BYTES = 256 * 1024;
const codexArtifactUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    cache_write_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    reasoning_output_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const codexArtifactLineSchema = z.object({ type: z.string(), payload: z.unknown() }).passthrough();
const codexSessionMetaSchema = z.object({ id: z.string().min(1) }).passthrough();
const codexTokenCountPayloadSchema = z
  .object({
    type: z.literal("token_count"),
    info: z.object({ total_token_usage: codexArtifactUsageSchema.optional() }).passthrough(),
  })
  .passthrough();

/** The official SDK lifecycle, kept behind the Coding Session port. */
export class CodexSdkAdapter implements CodingSessionAdapter {
  readonly name = "sdk" as const;

  constructor(private readonly options: CodexSdkAdapterOptions = {}) {}

  async run(context: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult> {
    let client: Codex;
    try {
      client = this.options.clientFactory
        ? await this.options.clientFactory()
        : await this.createClient(context);
    } catch (error) {
      throw new CodingSessionInterruption("startup", classifyAdapterFailure(error));
    }

    const threadOptions: ThreadOptions = {
      sandboxMode: context.sandbox,
      workingDirectory: context.workspace,
      model: context.profile.model,
      modelReasoningEffort: context.profile.reasoningEffort,
      approvalPolicy: context.approvalPolicy,
    };
    let thread: Thread;
    const startedAtEpochMs = Date.now();
    try {
      context.onPhase?.("thread");
      thread = client.startThread(threadOptions);
      if (thread.id) context.onSessionId?.(thread.id);
    } catch (error) {
      throw new CodingSessionInterruption("thread", classifyAdapterFailure(error));
    }

    context.onPhase?.("turn");
    const result = await runStreamedTurn(
      thread,
      context.prompt,
      { signal: context.signal, outputSchema: context.outputSchema },
      context.environment.CODEX_HOME?.trim() || join(homedir(), ".codex"),
      startedAtEpochMs,
      context.onObservation,
      context.onItemCompleted,
      context.onSessionId,
      context.onUsage,
    );
    return { ...result, sessionId: thread.id };
  }

  private async createClient(context: CodingSessionAdapterRequest): Promise<Codex> {
    const options: CodexOptions = {
      env: context.environment,
      config: codexAdapterConfig(context.profile, context.role, context.mcpServer),
      ...(this.options.codexPathOverride
        ? { codexPathOverride: this.options.codexPathOverride }
        : {}),
    };
    return new Codex(options);
  }
}

async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  options: TurnOptions,
  codexHome: string,
  startedAtEpochMs: number,
  onObservation: CodingSessionAdapterRequest["onObservation"],
  onItemCompleted: CodingSessionAdapterRequest["onItemCompleted"],
  onSessionId: CodingSessionAdapterRequest["onSessionId"],
  onUsage: CodingSessionAdapterRequest["onUsage"],
): Promise<{ finalResponse: string; usage: CodingSessionAdapterResult["usage"] }> {
  let usage: CodingSessionAdapterResult["usage"] = null;
  let reportedUsage: ProviderNeutralUsage | null = null;
  let reportedCompleteness: ProviderNeutralUsageCompleteness | undefined;
  let turnFinalized = false;
  const artifactReader = new CodexArtifactUsageReader(codexHome, startedAtEpochMs);
  const reportUsage = async (
    next: ProviderNeutralUsage,
    completeness?: ProviderNeutralUsageCompleteness,
  ): Promise<void> => {
    if (sameUsage(reportedUsage, next) && reportedCompleteness === completeness) return;
    reportedUsage = next;
    reportedCompleteness = completeness;
    usage = next;
    await onUsage?.({
      usage: next,
      semantics: "replacement",
      ...(completeness === undefined ? {} : { completeness }),
    });
  };
  try {
    const streamed = await thread.runStreamed(prompt, options);
    let finalResponse = "";
    let turn = 0;
    for await (const event of streamed.events) {
      switch (event.type) {
        case "thread.started":
          onSessionId?.(event.thread_id);
          artifactReader.setThreadId(event.thread_id);
          await onObservation?.({ type: "thread_started" });
          break;
        case "turn.started":
          turn += 1;
          await onObservation?.({ type: "turn_started", turn });
          break;
        case "item.completed": {
          const evidence = sdkCompletedEvidence(event.item);
          await onItemCompleted?.(evidence);
          if (event.item.type === "agent_message") finalResponse = event.item.text;
          break;
        }
        case "item.updated":
          if (event.item.type === "agent_message") finalResponse = event.item.text;
          break;
        case "turn.completed":
          await reportArtifactUsage(artifactReader, reportUsage, () => turnFinalized);
          turnFinalized = true;
          await reportUsage(
            sdkUsage(event.usage),
            reportedCompleteness === "partial" ? "complete" : undefined,
          );
          await onObservation?.({ type: "turn_completed", turn, outcome: "succeeded" });
          break;
        case "turn.failed":
          await reportArtifactUsage(artifactReader, reportUsage, () => turnFinalized);
          await onObservation?.({ type: "turn_completed", turn, outcome: "failed" });
          throw new Error("coding turn failed");
        case "error":
          await reportArtifactUsage(artifactReader, reportUsage, () => turnFinalized);
          throw new Error("coding session stream failed");
        case "item.started":
          break;
      }
      if (event.type !== "turn.completed")
        await reportArtifactUsage(artifactReader, reportUsage, () => turnFinalized);
    }
    return { finalResponse, usage };
  } catch (error) {
    await reportArtifactUsage(artifactReader, reportUsage, () => turnFinalized);
    if (error instanceof CodingSessionInterruption) throw error;
    throw new CodingSessionInterruption("turn", classifyAdapterFailure(error));
  }
}

async function reportArtifactUsage(
  reader: CodexArtifactUsageReader,
  report: (
    usage: ProviderNeutralUsage,
    completeness?: ProviderNeutralUsageCompleteness,
  ) => Promise<void>,
  isFinalized: () => boolean,
): Promise<void> {
  if (isFinalized()) return;
  const usage = await reader.read();
  if (usage !== null) await report(usage, "partial");
}

function codexSessionDayDirectory(codexHome: string, date: Date): string {
  return join(
    resolve(codexHome),
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

async function findCodexArtifact(
  codexHome: string,
  dayDirectory: string,
  threadId: string,
): Promise<string | null> {
  if (!(await isTrustedCodexDayDirectory(codexHome, dayDirectory))) return null;
  let directory;
  try {
    directory = await opendir(dayDirectory);
  } catch {
    return null;
  }
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId))
        continue;
      return join(dayDirectory, entry.name);
    }
  } catch {
    return null;
  } finally {
    await directory.close().catch(() => undefined);
  }
  return null;
}

async function isTrustedCodexDayDirectory(
  codexHome: string,
  dayDirectory: string,
): Promise<boolean> {
  const home = resolve(codexHome);
  const relative = resolve(dayDirectory)
    .slice(home.length + 1)
    .split(sep);
  if (relative.length !== 4 || relative[0] !== "sessions") return false;
  const [_, year, month, day] = relative;
  if (!/^\d{4}$/.test(year!) || !/^\d{2}$/.test(month!) || !/^\d{2}$/.test(day!)) return false;
  try {
    const stats = await Promise.all([
      lstat(home),
      lstat(join(home, "sessions")),
      lstat(join(home, "sessions", year!)),
      lstat(join(home, "sessions", year!, month!)),
      lstat(join(home, "sessions", year!, month!, day!)),
    ]);
    return stats.every((stat) => stat.isDirectory());
  } catch {
    return false;
  }
}

class CodexArtifactUsageReader {
  private threadId: string | null = null;
  private artifactPath: string | null = null;
  private offset = 0;
  private lineBuffer = "";
  private skippingLongLine = false;
  private matchingSession = false;
  private usage: ProviderNeutralUsage | null = null;

  constructor(
    private readonly codexHome: string,
    private readonly startedAtEpochMs: number,
  ) {}

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  async read(): Promise<ProviderNeutralUsage | null> {
    const threadId = this.threadId;
    if (threadId === null || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return null;
    if (this.artifactPath === null) {
      this.artifactPath = await this.findArtifact(threadId);
    }
    if (this.artifactPath === null) return this.matchingSession ? this.usage : null;

    let handle;
    try {
      handle = await open(this.artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile()) return this.usage;
      if (stats.size < this.offset) this.reset();
      while (this.offset < stats.size) {
        const length = Math.min(CODEX_ARTIFACT_READ_CHUNK_BYTES, stats.size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, this.offset);
        if (result.bytesRead === 0) break;
        this.offset += result.bytesRead;
        this.consume(buffer.subarray(0, result.bytesRead).toString("utf8"));
      }
      return this.usage;
    } catch {
      return this.usage;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  private async findArtifact(threadId: string): Promise<string | null> {
    const dayDirectories = new Set([
      codexSessionDayDirectory(this.codexHome, new Date(this.startedAtEpochMs)),
      codexSessionDayDirectory(this.codexHome, new Date()),
    ]);
    for (const dayDirectory of dayDirectories) {
      const artifact = await findCodexArtifact(this.codexHome, dayDirectory, threadId);
      if (artifact !== null) return artifact;
    }
    return null;
  }

  private consume(chunk: string): void {
    if (this.skippingLongLine) {
      const newline = chunk.indexOf("\n");
      if (newline === -1) return;
      this.skippingLongLine = false;
      chunk = chunk.slice(newline + 1);
    }
    while (chunk.length > 0) {
      const newline = chunk.indexOf("\n");
      if (newline === -1) {
        if (this.lineBuffer.length + chunk.length > CODEX_ARTIFACT_MAX_LINE_BYTES) {
          this.lineBuffer = "";
          this.skippingLongLine = true;
        } else {
          this.lineBuffer += chunk;
        }
        return;
      }
      const segment = chunk.slice(0, newline);
      if (this.lineBuffer.length + segment.length <= CODEX_ARTIFACT_MAX_LINE_BYTES) {
        this.consumeLine(this.lineBuffer + segment);
      }
      this.lineBuffer = "";
      chunk = chunk.slice(newline + 1);
    }
  }

  private consumeLine(line: string): void {
    let decoded: z.infer<typeof codexArtifactLineSchema>;
    try {
      decoded = codexArtifactLineSchema.parse(JSON.parse(line));
    } catch {
      return;
    }
    if (decoded.type === "session_meta") {
      const meta = codexSessionMetaSchema.safeParse(decoded.payload);
      if (meta.success && meta.data.id === this.threadId) this.matchingSession = true;
      return;
    }
    if (!this.matchingSession || decoded.type !== "event_msg") return;
    const payload = codexTokenCountPayloadSchema.safeParse(decoded.payload);
    const total = payload.success ? payload.data.info.total_token_usage : undefined;
    if (total) {
      const usage = sdkUsage(total);
      if (Object.keys(usage).length > 0) this.usage = usage;
    }
  }

  private reset(): void {
    this.offset = 0;
    this.lineBuffer = "";
    this.skippingLongLine = false;
    this.matchingSession = false;
  }
}

function sdkUsage(usage: {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}): ProviderNeutralUsage {
  const uncachedInputTokens =
    usage.input_tokens !== undefined &&
    usage.cached_input_tokens !== undefined &&
    usage.cache_write_input_tokens !== undefined
      ? usage.input_tokens >= usage.cached_input_tokens + usage.cache_write_input_tokens
        ? usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens
        : undefined
      : undefined;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.cached_input_tokens === undefined
      ? {}
      : { cachedInputTokens: usage.cached_input_tokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(usage.cache_write_input_tokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cache_write_input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(usage.reasoning_output_tokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoning_output_tokens }),
  };
}

function sameUsage(left: ProviderNeutralUsage | null, right: ProviderNeutralUsage): boolean {
  return (
    left?.inputTokens === right.inputTokens &&
    left?.cachedInputTokens === right.cachedInputTokens &&
    left?.uncachedInputTokens === right.uncachedInputTokens &&
    left?.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left?.outputTokens === right.outputTokens &&
    left?.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

function sdkCompletedEvidence(item: ThreadItem): ProviderNeutralCompletedEvidence {
  const status =
    "status" in item && item.status === "failed" ? ("failed" as const) : ("completed" as const);
  const base = { id: item.id, status } as const;
  switch (item.type) {
    case "command_execution": {
      const command = jsonField(item.command);
      const output = jsonField(item.aggregated_output);
      return {
        ...base,
        type: "command_execution",
        ...(command !== undefined ? { command } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
      };
    }
    case "file_change": {
      const changes = jsonField(item.changes);
      return {
        ...base,
        type: "file_change",
        ...(changes !== undefined ? { changes } : {}),
      };
    }
    case "mcp_tool_call": {
      const argumentsValue = jsonField(item.arguments);
      const output = jsonField(item.result);
      const error = jsonField(item.error);
      return {
        ...base,
        type: "mcp_tool_call",
        server: safeObservationLabel(item.server),
        tool: safeObservationLabel(item.tool),
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    }
    case "agent_message":
      return {
        ...base,
        type: "agent_message",
        ...(typeof item.text === "string" ? { text: item.text } : {}),
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        ...(typeof item.text === "string" ? { text: item.text } : {}),
      };
    case "web_search":
      return {
        ...base,
        type: "web_search",
        ...(typeof item.query === "string" ? { query: item.query } : {}),
      };
    default:
      return { ...base, type: "other" };
  }
}

function jsonField(value: unknown) {
  return providerNeutralJsonValue(value);
}
