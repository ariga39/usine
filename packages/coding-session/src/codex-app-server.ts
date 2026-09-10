import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Deferred, Effect, Queue } from "effect";
import { codexAdapterConfig, type CodexNativeConfig } from "./codex-adapter-config.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
  type CodingSessionFailureClass,
  type CodingSessionPhase,
} from "./coding-session-interruption.js";
import type {
  CodingSessionAdapter,
  CodingSessionAdapterRequest,
  CodingSessionAdapterResult,
  ProviderNeutralCompletedEvidence,
  ProviderNeutralUsage,
  ProviderNeutralUsageObservation,
} from "./coding-session-adapter.js";
import { providerNeutralJsonValue } from "./coding-session-adapter.js";
import { safeObservationLabel } from "./coding-session-policy.js";
import { z } from "zod";

interface AppServerRunResult {
  finalResponse: string;
  usage: ProviderNeutralUsage | null;
  sessionId: string;
}

type AppServerRunOptions = Omit<
  CodingSessionAdapterRequest,
  "onUsage" | "profile" | "mcpServer"
> & {
  config: CodexNativeConfig;
  onUsage?: (observation: ProviderNeutralUsageObservation) => Promise<void> | void;
};

const CHILD_CLOSE_WAIT_MS = 1_000;

/** The bounded local App Server lifecycle, peer to the official SDK adapter. */
export class CodexAppServerAdapter implements CodingSessionAdapter {
  readonly name = "app-server" as const;

  async run(context: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult> {
    const { mcpServer, onUsage, profile, ...adapterContext } = context;
    return runCodexAppServer({
      ...adapterContext,
      config: codexAdapterConfig(profile, context.role, mcpServer),
      onUsage,
    });
  }
}

class AppServerCancelled extends Error {}
class AppServerProtocolError extends Error {}
class AppServerCallbackError extends Error {
  constructor(readonly cause: unknown) {
    super("app-server callback failed");
    this.name = "AppServerCallbackError";
  }
}

const jsonRpcMessageSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const threadStartResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
});

const turnStartResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});

const threadStartedSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
});

const turnStartedSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({ id: z.string().min(1) }),
});

const itemCompletedSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: z
    .object({
      type: z.string().min(1),
      id: z.string().min(1),
    })
    .passthrough(),
});

const itemDeltaSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  delta: z.string(),
});

const turnCompletedSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({
    id: z.string().min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: z.unknown().nullable().optional(),
  }),
});

const tokenUsageSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  tokenUsage: z.object({
    last: z.object({
      inputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheWriteInputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative(),
      reasoningOutputTokens: z.number().int().nonnegative().optional(),
    }),
  }),
});

type JsonRpcId = string | number;

type AppServerMessage = { type: "line"; line: string } | { type: "failure"; error: Error };

type AppServerFailureClass =
  | "authentication"
  | "configuration"
  | "network"
  | "rate_limit"
  | "timeout"
  | "permission"
  | "unsupported"
  | "transport";

class BoundedStderrClassifier {
  private readonly classifications = new Set<AppServerFailureClass>();
  private bytesObserved = 0;

  observe(chunk: Buffer | string): void {
    if (this.bytesObserved >= 4096) return;
    const text = String(chunk)
      .slice(0, 4096 - this.bytesObserved)
      .toLowerCase();
    this.bytesObserved += text.length;
    const classification = classifyStderr(text);
    if (classification) this.classifications.add(classification);
  }

  classification(): AppServerFailureClass | undefined {
    for (const classification of [
      "configuration",
      "authentication",
      "permission",
      "rate_limit",
      "timeout",
      "network",
      "unsupported",
      "transport",
    ] as const) {
      if (this.classifications.has(classification)) return classification;
    }
    return undefined;
  }
}

function classifyStderr(text: string): AppServerFailureClass | undefined {
  if (/(config|profile|invalid option|unknown option|unrecognized option)/.test(text))
    return "configuration";
  if (/(auth|credential|login|api key|unauthorized|forbidden)/.test(text)) return "authentication";
  if (/(permission|denied|sandbox|workspace)/.test(text)) return "permission";
  if (/(rate limit|too many requests|429)/.test(text)) return "rate_limit";
  if (/(timed out|timeout|deadline)/.test(text)) return "timeout";
  if (/(network|connect|dns|socket|timed out|timeout|rate limit)/.test(text)) return "network";
  if (/(unsupported|not implemented|capability)/.test(text)) return "unsupported";
  return undefined;
}

function classifiedFailure(
  prefix: string,
  classification: AppServerFailureClass | undefined,
): Error {
  return new Error(`${prefix}${classification ? ` (${classification})` : ""}`);
}

class AppServerClient {
  private readonly lines;
  private nextId = 1;
  private closed = false;
  private failure: Error | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stderrClassification: () => AppServerFailureClass | undefined,
    private readonly enqueue: (message: AppServerMessage) => void,
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.enqueue({ type: "line", line }));
    child.once("error", () => {
      if (!this.closed)
        this.enqueue({
          type: "failure",
          error: classifiedFailure("app-server process failed", this.stderrClassification()),
        });
    });
    child.once("close", () => {
      if (!this.closed)
        this.enqueue({
          type: "failure",
          error: classifiedFailure("app-server transport closed", this.stderrClassification()),
        });
    });
    child.stdin.on("error", () => {
      if (!this.closed)
        this.enqueue({
          type: "failure",
          error: classifiedFailure(
            "app-server transport write failed",
            this.stderrClassification(),
          ),
        });
    });
  }

  request(method: string, params: unknown): JsonRpcId {
    if (this.closed) throw this.failure ?? new Error("app-server transport closed");
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  write(message: unknown): void {
    if (this.closed) throw this.failure ?? new Error("app-server transport closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  closeTransport(error?: Error): void {
    this.close(error ?? this.failure ?? new Error("app-server transport closed"), false);
  }

  failTransport(error: Error): void {
    this.close(error, true);
  }

  private close(error: Error, destroy: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.lines.close();
    if (destroy) this.child.stdin.destroy();
    else this.child.stdin.end();
  }
}

async function runCodexAppServer({
  workspace,
  prompt,
  sandbox,
  approvalPolicy,
  config,
  outputSchema,
  environment,
  signal,
  onObservation,
  onItemCompleted,
  onSessionId,
  onPhase,
  onUsage,
}: AppServerRunOptions): Promise<AppServerRunResult> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("codex", ["app-server", "--stdio"], {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CodingSessionInterruption("startup", classifyAdapterFailure(error));
  }
  const childSettled = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", settle);
    child.once("close", settle);
  });
  const stderr = new BoundedStderrClassifier();
  child.stderr.on("data", (chunk) => stderr.observe(chunk));
  child.stderr.resume();
  let phase: CodingSessionPhase = "startup";
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnActive = false;
  let finalResponse = "";
  let usage: AppServerRunResult["usage"] = null;
  let turnNumber = 0;
  let client: AppServerClient | undefined;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* Queue.bounded<AppServerMessage>(64);
        const terminal = yield* Deferred.make<AppServerRunResult, Error>();
        let currentResponse:
          | { id: JsonRpcId; deferred: Deferred.Deferred<unknown, Error> }
          | undefined;
        const failTerminal = (error: Error): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (currentResponse) yield* Deferred.fail(currentResponse.deferred, error);
            yield* Deferred.fail(terminal, error);
            yield* Effect.sync(() => client?.failTransport(error));
          });
        const transport = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new AppServerClient(
                child,
                () => stderr.classification(),
                (message) => {
                  if (!Queue.offerUnsafe(messages, message))
                    Effect.runSync(
                      failTerminal(new Error("app-server notification queue is full")),
                    );
                },
              ),
          ),
          (clientTransport) =>
            Effect.sync(() => {
              if (signal?.aborted && turnActive && threadId && turnId) {
                try {
                  clientTransport.notify("turn/interrupt", { threadId, turnId });
                } catch {
                  // Closing the transport still owns process cleanup.
                }
              }
              clientTransport.closeTransport();
            }),
        );
        client = transport;

        const requestAppServer = (method: string, params: unknown) =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<unknown, Error>();
            const id = yield* Effect.sync(() => transport.request(method, params));
            currentResponse = { id, deferred };
            return yield* Deferred.await(deferred).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (currentResponse?.deferred === deferred) currentResponse = undefined;
                }),
              ),
            );
          });

        const observe = (
          observation: Parameters<NonNullable<CodingSessionAdapterRequest["onObservation"]>>[0],
        ) =>
          Effect.tryPromise({
            try: async () => await invokeAppServerCallback(onObservation, observation),
            catch: asError,
          });
        const assertIdentity = (eventThreadId: string, eventTurnId: string): void => {
          if (!threadId || !turnId || eventThreadId !== threadId || eventTurnId !== turnId)
            throw identityMismatch();
        };

        const processMessages = Effect.gen(function* () {
          while (true) {
            const message = yield* Queue.take(messages);
            if (message.type === "failure") {
              yield* failTerminal(message.error);
              return;
            }
            if (!message.line.trim()) continue;
            try {
              const parsed = jsonRpcMessageSchema.safeParse(parseJson(message.line));
              if (!parsed.success) throw new Error("app-server protocol message is malformed");
              const incoming = parsed.data;
              if (incoming.id !== undefined && incoming.method === undefined) {
                const response = currentResponse;
                if (!response || response.id !== incoming.id)
                  throw new Error("app-server response identity is unknown");
                currentResponse = undefined;
                if (incoming.error !== undefined) {
                  yield* Deferred.fail(response.deferred, new Error("app-server request failed"));
                } else if (incoming.result !== undefined) {
                  yield* Deferred.succeed(response.deferred, incoming.result);
                } else {
                  const failure = new Error("app-server response is malformed");
                  yield* Deferred.fail(response.deferred, failure);
                  throw failure;
                }
                continue;
              }
              if (incoming.method !== undefined) {
                if (incoming.id !== undefined) {
                  transport.write({
                    jsonrpc: "2.0",
                    id: incoming.id,
                    error: { code: -32601, message: "unsupported app-server request" },
                  });
                  throw new Error("app-server requested an unsupported capability");
                }
                switch (incoming.method) {
                  case "thread/started": {
                    const event = threadStartedSchema.parse(incoming.params);
                    if (!threadId || event.thread.id !== threadId) throw identityMismatch();
                    yield* observe({ type: "thread_started" });
                    break;
                  }
                  case "turn/started": {
                    const event = turnStartedSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turn.id);
                    turnNumber += 1;
                    if (turnNumber !== 1) throw new Error("app-server started more than one turn");
                    yield* observe({ type: "turn_started", turn: turnNumber });
                    break;
                  }
                  case "item/agentMessage/delta": {
                    const event = itemDeltaSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turnId);
                    finalResponse += event.delta;
                    break;
                  }
                  case "item/completed": {
                    const event = itemCompletedSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turnId);
                    const item = event.item;
                    if (item.type === "agentMessage" && typeof item.text === "string")
                      finalResponse = item.text;
                    yield* Effect.tryPromise({
                      try: async () =>
                        await invokeAppServerCallback(
                          onItemCompleted,
                          appServerCompletedEvidence(item),
                        ),
                      catch: asError,
                    });
                    break;
                  }
                  case "thread/tokenUsage/updated": {
                    const event = tokenUsageSchema.parse(incoming.params);
                    const last = event.tokenUsage.last;
                    const uncachedInputTokens =
                      last.cachedInputTokens !== undefined &&
                      last.cacheWriteInputTokens !== undefined &&
                      last.inputTokens >= last.cachedInputTokens + last.cacheWriteInputTokens
                        ? last.inputTokens - last.cachedInputTokens - last.cacheWriteInputTokens
                        : undefined;
                    assertIdentity(event.threadId, event.turnId);
                    usage = {
                      inputTokens: last.inputTokens,
                      ...(last.cachedInputTokens === undefined
                        ? {}
                        : { cachedInputTokens: last.cachedInputTokens }),
                      ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
                      ...(last.cacheWriteInputTokens === undefined
                        ? {}
                        : { cacheWriteInputTokens: last.cacheWriteInputTokens }),
                      outputTokens: last.outputTokens,
                      ...(last.reasoningOutputTokens === undefined
                        ? {}
                        : { reasoningOutputTokens: last.reasoningOutputTokens }),
                    };
                    if (usage)
                      yield* Effect.tryPromise({
                        try: async () =>
                          await invokeAppServerCallback(onUsage, {
                            usage: usage!,
                            semantics: "replacement",
                          }),
                        catch: asError,
                      });
                    break;
                  }
                  case "turn/completed": {
                    const event = turnCompletedSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turn.id);
                    if (!threadId) throw identityMismatch();
                    turnActive = false;
                    yield* observe({
                      type: "turn_completed",
                      turn: turnNumber,
                      outcome: event.turn.status === "completed" ? "succeeded" : "failed",
                    });
                    if (event.turn.status === "completed") {
                      yield* Deferred.succeed(terminal, {
                        finalResponse,
                        usage,
                        sessionId: threadId,
                      });
                    } else if (event.turn.status === "interrupted" && signal?.aborted) {
                      yield* failTerminal(new AppServerCancelled("coding session cancelled"));
                      return;
                    } else {
                      yield* failTerminal(new Error("app-server turn failed"));
                      return;
                    }
                    break;
                  }
                  case "error":
                    throw new AppServerProtocolError("app-server stream reported an error");
                  default:
                    break;
                }
                continue;
              }
              throw new Error("app-server protocol message has no response or method");
            } catch (error) {
              yield* failTerminal(
                error instanceof AppServerCallbackError
                  ? asError(error.cause)
                  : error instanceof AppServerProtocolError
                    ? error
                    : new AppServerProtocolError(asError(error).message),
              );
              return;
            }
          }
        });
        yield* processMessages.pipe(Effect.forkScoped);
        yield* requestAppServer("initialize", {
          clientInfo: { name: "usine-coding-session", version: "0.1.0" },
          capabilities: null,
        });
        throwIfAborted(signal);
        transport.notify("initialized", {});
        phase = "thread";
        onPhase?.(phase);
        const thread = threadStartResponseSchema.parse(
          yield* requestAppServer("thread/start", {
            cwd: workspace,
            approvalPolicy,
            sandbox,
            config,
            ephemeral: true,
          }),
        );
        threadId = thread.thread.id;
        onSessionId?.(threadId);
        throwIfAborted(signal);
        phase = "turn";
        onPhase?.(phase);
        const turn = turnStartResponseSchema.parse(
          yield* requestAppServer("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            cwd: workspace,
            outputSchema,
          }),
        );
        turnId = turn.turn.id;
        turnActive = true;
        throwIfAborted(signal);
        return yield* Deferred.await(terminal);
      }),
    ),
    { signal },
  )
    .catch((error) => {
      if (error instanceof CodingSessionInterruption) throw error;
      if (error instanceof AppServerCancelled || signal?.aborted)
        throw new CodingSessionInterruption(phase, "cancellation", "coding session cancelled");
      const classification = stderr.classification();
      const failureClass =
        error instanceof AppServerProtocolError
          ? ("transport" as const)
          : appServerFailureClass(classification ?? classifyAdapterFailure(error));
      throw new CodingSessionInterruption(
        phase,
        failureClass,
        safeAppServerFailure(error, classification, failureClass),
      );
    })
    .finally(() => settleChild(child, childSettled));
  return result;
}

async function settleChild(
  child: ChildProcessWithoutNullStreams,
  childSettled: Promise<void>,
): Promise<void> {
  if (await waitForChildSettlement(childSettled, 0)) return;
  try {
    child.stdin.end();
  } catch {
    // The child may already have closed its transport.
  }
  if (await waitForChildSettlement(childSettled, CHILD_CLOSE_WAIT_MS)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The close event or an earlier termination may have won the race.
  }
  if (await waitForChildSettlement(childSettled, CHILD_CLOSE_WAIT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between the bounded waits.
  }
  if (!(await waitForChildSettlement(childSettled, CHILD_CLOSE_WAIT_MS)))
    throw new Error("app-server child did not settle after SIGKILL");
}

function waitForChildSettlement(childSettled: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void childSettled.then(() => finish(true));
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("app-server request failed");
}

async function invokeAppServerCallback<TArgs extends readonly unknown[]>(
  callback: ((...args: TArgs) => Promise<void> | void) | undefined,
  ...args: TArgs
): Promise<void> {
  try {
    await callback?.(...args);
  } catch (error) {
    throw new AppServerCallbackError(error);
  }
}

function appServerFailureClass(
  classification: AppServerFailureClass | CodingSessionFailureClass,
): CodingSessionFailureClass {
  switch (classification) {
    case "authentication":
    case "permission":
      return "authority";
    case "configuration":
    case "unsupported":
      return "configuration";
    case "network":
      return "network";
    case "rate_limit":
      return "rate_limit";
    case "timeout":
      return "timeout";
    case "transport":
      return "transport";
    case "transient_transport":
      return "transient_transport";
    default:
      return classification;
  }
}

function safeAppServerFailure(
  error: unknown,
  classification: AppServerFailureClass | undefined,
  failureClass: CodingSessionFailureClass,
): string {
  const message = error instanceof Error ? error.message : "";
  if (/^app-server [a-z ]+( \([a-z_]+\))?$/.test(message)) return message;
  return `app-server provider interruption (${classification ?? failureClass})`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function identityMismatch(): Error {
  return new Error("app-server event identity mismatch");
}

function appServerCompletedEvidence(
  item: Record<string, unknown>,
): ProviderNeutralCompletedEvidence {
  const status = item.status === "failed" ? "failed" : "completed";
  const id = typeof item.id === "string" ? item.id : "unknown";
  const base = { id, status } as const;
  switch (item.type) {
    case "commandExecution": {
      const command = jsonField(item.command);
      const output = jsonField(item.aggregatedOutput);
      return {
        ...base,
        type: "command_execution",
        ...(command !== undefined ? { command } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
      };
    }
    case "fileChange": {
      const changes = jsonField(item.changes);
      return {
        ...base,
        type: "file_change",
        ...(changes !== undefined ? { changes } : {}),
      };
    }
    case "mcpToolCall": {
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
    case "agentMessage":
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
    case "webSearch":
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppServerCancelled("coding session cancelled");
}
