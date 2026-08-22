import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Deferred, Effect, Queue } from "effect";
import { codexMcpConfig, safeObservationLabel } from "./coding-session-policy.js";
import { createCodexLauncher } from "./codex-execution.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
  type CodingSessionFailureClass,
  type CodingSessionPhase,
} from "./coding-session-interruption.js";
import { codexAdapterConfig, normalizeCodexProfileSelection } from "./codex-profile.js";
import type { SessionRequest } from "./coding-session.js";
import { z } from "zod";

interface AppServerRunResult {
  finalResponse: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  sessionId: string;
}

interface AppServerRunOptions {
  request: SessionRequest;
  environment: NodeJS.ProcessEnv;
  executionStateDirectory: string;
  profileSelection: ReturnType<typeof normalizeCodexProfileSelection>;
}

class AppServerCancelled extends Error {}

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
      outputTokens: z.number().int().nonnegative(),
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
    child.once("error", () =>
      this.enqueue({
        type: "failure",
        error: classifiedFailure("app-server process failed", this.stderrClassification()),
      }),
    );
    child.once("close", () =>
      this.enqueue({
        type: "failure",
        error: classifiedFailure("app-server transport closed", this.stderrClassification()),
      }),
    );
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

export async function runCodexAppServer({
  request,
  environment,
  executionStateDirectory,
  profileSelection,
}: AppServerRunOptions): Promise<AppServerRunResult> {
  let launcher: Awaited<ReturnType<typeof createCodexLauncher>>;
  let child: ChildProcessWithoutNullStreams;
  try {
    launcher = await createCodexLauncher(
      executionStateDirectory,
      request.workspace,
      request.execution,
    );
    child = spawn(launcher.launcherPath, ["app-server", "--stdio"], {
      cwd: request.workspace,
      env: {
        ...environment,
        USINE_CODEX_IDENTITY_PATH: launcher.identityPath,
        USINE_CODEX_WORKSPACE: request.workspace,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CodingSessionInterruption("startup", classifyAdapterFailure(error));
  }
  const stderr = new BoundedStderrClassifier();
  child.stderr.on("data", (chunk) => stderr.observe(chunk));
  child.stderr.resume();
  let phase: CodingSessionPhase = "startup";
  let threadId: string | undefined;
  let turnId: string | undefined;
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
          (transport) => Effect.sync(() => transport.closeTransport()),
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
          observation: Parameters<NonNullable<SessionRequest["onObservation"]>>[0],
        ) =>
          Effect.tryPromise({
            try: async () => await request.onObservation?.(observation),
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
                      try: () => emitAppServerItem(item, request.onObservation),
                      catch: asError,
                    });
                    break;
                  }
                  case "thread/tokenUsage/updated": {
                    const event = tokenUsageSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turnId);
                    usage = {
                      input_tokens: event.tokenUsage.last.inputTokens,
                      output_tokens: event.tokenUsage.last.outputTokens,
                    };
                    break;
                  }
                  case "turn/completed": {
                    const event = turnCompletedSchema.parse(incoming.params);
                    assertIdentity(event.threadId, event.turn.id);
                    if (!threadId) throw identityMismatch();
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
                    } else if (event.turn.status === "interrupted" && request.signal?.aborted) {
                      yield* failTerminal(new AppServerCancelled("coding session cancelled"));
                      return;
                    } else {
                      yield* failTerminal(new Error("app-server turn failed"));
                      return;
                    }
                    break;
                  }
                  case "error":
                    throw new Error("app-server stream failed");
                  default:
                    break;
                }
                continue;
              }
              throw new Error("app-server protocol message has no response or method");
            } catch (error) {
              yield* failTerminal(asError(error));
              return;
            }
          }
        });
        yield* processMessages.pipe(Effect.forkScoped);
        if (request.signal)
          yield* Effect.forkScoped(
            appServerCancellation(
              request.signal,
              transport,
              messages,
              terminal,
              () => ({
                threadId,
                turnId,
              }),
              () => currentResponse?.deferred,
            ),
          );

        yield* requestAppServer("initialize", {
          clientInfo: { name: "usine-coding-session", version: "0.1.0" },
          capabilities: null,
        });
        throwIfAborted(request.signal);
        transport.notify("initialized", {});
        phase = "thread";
        const thread = threadStartResponseSchema.parse(
          yield* requestAppServer("thread/start", {
            cwd: request.workspace,
            approvalPolicy: "never",
            sandbox: request.sandbox,
            config: codexAdapterConfig(
              profileSelection,
              request.mcpServer ? codexMcpConfig(request.mcpServer) : {},
            ),
            ephemeral: true,
          }),
        );
        threadId = thread.thread.id;
        throwIfAborted(request.signal);
        phase = "turn";
        const turn = turnStartResponseSchema.parse(
          yield* requestAppServer("turn/start", {
            threadId,
            input: [{ type: "text", text: request.prompt, text_elements: [] }],
            cwd: request.workspace,
            outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
          }),
        );
        turnId = turn.turn.id;
        throwIfAborted(request.signal);
        return yield* Deferred.await(terminal);
      }),
    ),
  ).catch((error) => {
    if (error instanceof CodingSessionInterruption) throw error;
    if (error instanceof AppServerCancelled || request.signal?.aborted)
      throw new CodingSessionInterruption(phase, "cancellation", "coding session cancelled");
    const classification = stderr.classification();
    const failureClass = appServerFailureClass(classification ?? classifyAdapterFailure(error));
    throw new CodingSessionInterruption(
      phase,
      failureClass,
      safeAppServerFailure(error, classification, failureClass),
    );
  });
  return result;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("app-server request failed");
}

function appServerCancellation(
  signal: AbortSignal,
  client: AppServerClient,
  messages: Queue.Queue<AppServerMessage>,
  terminal: Deferred.Deferred<AppServerRunResult, Error>,
  ids: () => { threadId: string | undefined; turnId: string | undefined },
  currentResponse: () => Deferred.Deferred<unknown, Error> | undefined,
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const onAbort = (): void => resume(Effect.void);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  }).pipe(
    Effect.tap(() =>
      Effect.gen(function* () {
        const { threadId, turnId } = ids();
        if (threadId && turnId)
          yield* Effect.sync(() => client.notify("turn/interrupt", { threadId, turnId })).pipe(
            Effect.catch(() => Effect.void),
          );
        const cancellation = new AppServerCancelled("coding session cancelled");
        const response = currentResponse();
        if (response) yield* Deferred.fail(response, cancellation);
        yield* Queue.shutdown(messages);
        yield* Deferred.fail(terminal, cancellation);
      }),
    ),
    Effect.asVoid,
  );
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

async function emitAppServerItem(
  item: Record<string, unknown>,
  onObservation: SessionRequest["onObservation"],
): Promise<void> {
  const status = item.status === "completed" ? "succeeded" : "failed";
  switch (item.type) {
    case "commandExecution":
      await onObservation?.({ type: "tool_completed", tool: "shell", outcome: status });
      break;
    case "fileChange":
      await onObservation?.({ type: "tool_completed", tool: "apply_patch", outcome: status });
      break;
    case "mcpToolCall":
      await onObservation?.({
        type: "mcp_tool_completed",
        server: safeObservationLabel(item.server),
        tool: safeObservationLabel(item.tool),
        outcome: status,
      });
      break;
    case "webSearch":
      await onObservation?.({ type: "tool_completed", tool: "search", outcome: "succeeded" });
      break;
    default:
      break;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppServerCancelled("coding session cancelled");
}

export function isAppServerCancellation(error: unknown): boolean {
  return error instanceof AppServerCancelled;
}
