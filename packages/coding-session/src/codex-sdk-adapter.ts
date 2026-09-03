import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { codexAdapterConfig } from "./codex-adapter-config.js";
import { createCodexLauncher } from "./codex-execution.js";
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
  type ProviderNeutralUsage,
} from "./coding-session-adapter.js";
import { safeObservationLabel } from "./coding-session-policy.js";

/** The official SDK lifecycle, kept behind the Coding Session port. */
export class CodexSdkAdapter implements CodingSessionAdapter {
  readonly name = "sdk" as const;

  constructor(private readonly clientFactory?: () => Promise<Codex>) {}

  async run(context: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult> {
    let client: Codex;
    try {
      client = this.clientFactory ? await this.clientFactory() : await this.createClient(context);
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
      context.onObservation,
      context.onItemCompleted,
      context.onUsage,
    );
    return { ...result, sessionId: thread.id };
  }

  private async createClient(context: CodingSessionAdapterRequest): Promise<Codex> {
    const options: CodexOptions = {
      env: context.environment,
      config: codexAdapterConfig(context.profile, context.mcpServer),
    };
    if (!context.executionStateDirectory) return new Codex(options);
    const launcher = await createCodexLauncher(
      context.executionStateDirectory,
      context.workspace,
      context.execution,
    );
    return new Codex({
      ...options,
      codexPathOverride: launcher.launcherPath,
      env: {
        ...options.env,
        USINE_CODING_SESSION_IDENTITY_PATH: launcher.identityPath,
        USINE_CODING_SESSION_WORKSPACE: context.workspace,
      },
    });
  }
}

async function runStreamedTurn(
  thread: Thread,
  prompt: string,
  options: TurnOptions,
  onObservation: CodingSessionAdapterRequest["onObservation"],
  onItemCompleted: CodingSessionAdapterRequest["onItemCompleted"],
  onUsage: CodingSessionAdapterRequest["onUsage"],
): Promise<{ finalResponse: string; usage: CodingSessionAdapterResult["usage"] }> {
  try {
    const streamed = await thread.runStreamed(prompt, options);
    let finalResponse = "";
    let usage: CodingSessionAdapterResult["usage"] = null;
    let turn = 0;
    for await (const event of streamed.events) {
      switch (event.type) {
        case "thread.started":
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
          usage = sdkUsage(event.usage);
          await onUsage?.(usage);
          await onObservation?.({ type: "turn_completed", turn, outcome: "succeeded" });
          break;
        case "turn.failed":
          await onObservation?.({ type: "turn_completed", turn, outcome: "failed" });
          throw new Error("coding turn failed");
        case "error":
          throw new Error("coding session stream failed");
        case "item.started":
          break;
      }
    }
    return { finalResponse, usage };
  } catch (error) {
    if (error instanceof CodingSessionInterruption) throw error;
    throw new CodingSessionInterruption("turn", classifyAdapterFailure(error));
  }
}

function sdkUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): ProviderNeutralUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    ...(usage.input_tokens >= usage.cached_input_tokens
      ? { uncachedInputTokens: usage.input_tokens - usage.cached_input_tokens }
      : {}),
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
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
