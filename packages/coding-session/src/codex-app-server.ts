import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { codexMcpConfig, safeObservationLabel } from "./coding-session-policy.js";
import { createCodexLauncher } from "./codex-execution.js";
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

type AppServerFailureClass =
  | "authentication"
  | "configuration"
  | "network"
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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class AppServerClient {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly lines;
  private nextId = 1;
  private closed = false;
  private failure: Error | null = null;
  private onFailure: ((error: Error) => void) | undefined;
  private onNotification: ((method: string, params: unknown) => void) | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stderrClassification: () => AppServerFailureClass | undefined,
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    child.once("error", () =>
      this.fail(classifiedFailure("app-server process failed", this.stderrClassification())),
    );
    child.once("close", () =>
      this.fail(classifiedFailure("app-server transport closed", this.stderrClassification())),
    );
  }

  setFailureHandler(handler: (error: Error) => void): void {
    this.onFailure = handler;
    if (this.failure) handler(this.failure);
  }

  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.onNotification = handler;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(this.failure ?? new Error("app-server transport closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.closed) throw this.failure ?? new Error("app-server transport closed");
    this.write({ jsonrpc: "2.0", method, params });
  }

  rejectServerRequest(id: JsonRpcId): void {
    if (this.closed) return;
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "unsupported app-server request" },
    });
    this.fail(new Error("app-server requested an unsupported capability"));
  }

  closeTransport(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error ?? this.failure;
    this.lines.close();
    this.child.stdin.end();
    if (error) this.rejectPending(error);
  }

  failTransport(error: Error): void {
    this.fail(error);
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    const parsed = jsonRpcMessageSchema.safeParse(parseJson(line));
    if (!parsed.success) {
      this.fail(new Error("app-server protocol message is malformed"));
      return;
    }
    const message = parsed.data;
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.fail(new Error("app-server response identity is unknown"));
        return;
      }
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error("app-server request failed"));
      else if (message.result !== undefined) pending.resolve(message.result);
      else {
        const failure = new Error("app-server response is malformed");
        pending.reject(failure);
        this.fail(failure);
      }
      return;
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) this.rejectServerRequest(message.id);
      else this.onNotification?.(message.method, message.params);
      return;
    }
    this.fail(new Error("app-server protocol message has no response or method"));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.lines.close();
    this.child.stdin.destroy();
    this.rejectPending(error);
    this.onFailure?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function runCodexAppServer({
  request,
  environment,
  executionStateDirectory,
  profileSelection,
}: AppServerRunOptions): Promise<AppServerRunResult> {
  const launcher = await createCodexLauncher(
    executionStateDirectory,
    request.workspace,
    request.execution,
  );
  const child = spawn(launcher.launcherPath, ["app-server", "--stdio"], {
    cwd: request.workspace,
    env: {
      ...environment,
      USINE_CODEX_IDENTITY_PATH: launcher.identityPath,
      USINE_CODEX_WORKSPACE: request.workspace,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = new BoundedStderrClassifier();
  child.stderr.on("data", (chunk) => stderr.observe(chunk));
  child.stderr.resume();
  const client = new AppServerClient(child, () => stderr.classification());
  let threadId: string | undefined;
  let turnId: string | undefined;
  let finalResponse = "";
  let usage: AppServerRunResult["usage"] = null;
  let turnNumber = 0;
  let eventChain = Promise.resolve();
  let completeTurn: ((result: AppServerRunResult) => void) | undefined;
  let failTurn: ((error: Error) => void) | undefined;
  const turnCompletion = new Promise<AppServerRunResult>((resolve, reject) => {
    completeTurn = resolve;
    failTurn = reject;
  });
  void turnCompletion.catch(() => undefined);
  client.setFailureHandler((error) => failTurn?.(error));
  let interruptPromise: Promise<void> | undefined;
  const abort = (): void => {
    const cancellation = new AppServerCancelled("coding session cancelled");
    failTurn?.(cancellation);
    if (!threadId || !turnId) {
      client.closeTransport(cancellation);
      return;
    }
    interruptPromise ??= (async () => {
      try {
        await client.request("turn/interrupt", { threadId, turnId });
      } catch {
        // The process is still reaped by the owning execution lifecycle.
      }
    })();
    void interruptPromise;
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();

  client.setNotificationHandler((method, params) => {
    eventChain = eventChain.then(async () => {
      try {
        switch (method) {
          case "thread/started": {
            const event = threadStartedSchema.parse(params);
            if (!threadId || event.thread.id !== threadId) throw identityMismatch();
            await request.onObservation?.({ type: "thread_started" });
            break;
          }
          case "turn/started": {
            const event = turnStartedSchema.parse(params);
            if (!threadId || !turnId || event.threadId !== threadId || event.turn.id !== turnId)
              throw identityMismatch();
            turnNumber += 1;
            if (turnNumber !== 1) throw new Error("app-server started more than one turn");
            await request.onObservation?.({ type: "turn_started", turn: turnNumber });
            break;
          }
          case "item/agentMessage/delta": {
            const event = itemDeltaSchema.parse(params);
            if (!threadId || !turnId || event.threadId !== threadId || event.turnId !== turnId)
              throw identityMismatch();
            finalResponse += event.delta;
            break;
          }
          case "item/completed": {
            const event = itemCompletedSchema.parse(params);
            if (!threadId || !turnId || event.threadId !== threadId || event.turnId !== turnId)
              throw identityMismatch();
            const item = event.item;
            if (item.type === "agentMessage" && typeof item.text === "string")
              finalResponse = item.text;
            await emitAppServerItem(item, request.onObservation);
            break;
          }
          case "thread/tokenUsage/updated": {
            const event = tokenUsageSchema.parse(params);
            if (!threadId || !turnId || event.threadId !== threadId || event.turnId !== turnId)
              throw identityMismatch();
            usage = {
              input_tokens: event.tokenUsage.last.inputTokens,
              output_tokens: event.tokenUsage.last.outputTokens,
            };
            break;
          }
          case "turn/completed": {
            const event = turnCompletedSchema.parse(params);
            if (!threadId || !turnId || event.threadId !== threadId || event.turn.id !== turnId)
              throw identityMismatch();
            if (event.turn.status === "completed") {
              await request.onObservation?.({
                type: "turn_completed",
                turn: turnNumber,
                outcome: "succeeded",
              });
              completeTurn?.({ finalResponse, usage, sessionId: threadId });
            } else if (event.turn.status === "interrupted" && request.signal?.aborted) {
              await request.onObservation?.({
                type: "turn_completed",
                turn: turnNumber,
                outcome: "failed",
              });
              failTurn?.(new AppServerCancelled("coding session cancelled"));
            } else {
              await request.onObservation?.({
                type: "turn_completed",
                turn: turnNumber,
                outcome: "failed",
              });
              failTurn?.(new Error("app-server turn failed"));
            }
            break;
          }
          case "error":
            throw new Error("app-server stream failed");
          default:
            break;
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("app-server event is malformed");
        failTurn?.(failure);
        client.failTransport(failure);
      }
    });
  });

  try {
    await client.request("initialize", {
      clientInfo: { name: "usine-coding-session", version: "0.1.0" },
      capabilities: null,
    });
    throwIfAborted(request.signal);
    client.notify("initialized", {});
    const thread = threadStartResponseSchema.parse(
      await client.request("thread/start", {
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
    const turn = turnStartResponseSchema.parse(
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.workspace,
        outputSchema: z.toJSONSchema(request.outputSchema, { target: "openAi" }),
      }),
    );
    turnId = turn.turn.id;
    throwIfAborted(request.signal);
    return await turnCompletion;
  } catch (error) {
    if (error instanceof AppServerCancelled || request.signal?.aborted)
      throw new AppServerCancelled("coding session cancelled");
    throw error instanceof Error ? error : new Error("app-server request failed");
  } finally {
    request.signal?.removeEventListener("abort", abort);
    client.closeTransport();
  }
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
