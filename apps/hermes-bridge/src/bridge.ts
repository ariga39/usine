import { createHash, createHmac } from "node:crypto";
import { Effect } from "effect";
import {
  decodeApiEventEnvelope,
  makeUsineApiClient,
  type ApiEventEnvelope,
  type ApiTaskResource,
  type ServerSnapshot,
  type TaskEventPage,
  type TaskListPage,
  type TaskSubmission,
} from "@usine/runtime";

const defaultTaskLimit = 100;

export interface HermesBridgeUpstream {
  serverSnapshot(limit?: number): Promise<ServerSnapshot>;
  listTasks(limit?: number): Promise<TaskListPage>;
  getTask(taskId: string): Promise<ApiTaskResource | null>;
  taskHistory(taskId: string, after?: number, limit?: number): Promise<TaskEventPage>;
  submitTask(submission: TaskSubmission): Promise<ApiTaskResource>;
  retryTask(taskId: string): Promise<ApiTaskResource>;
  subscribe(signal: AbortSignal): AsyncIterable<ApiEventEnvelope>;
}

export interface HermesBridgeOptions {
  upstream: HermesBridgeUpstream;
  sourceId: string;
  webhookUrl: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  taskLimit?: number;
  maxWebhookAttempts?: number;
  webhookRetryDelayMs?: number;
  maxPendingWebhookSignals?: number;
}

export interface HermesAttentionPayload {
  event: "usine_attention";
  sourceId: string;
  taskId: string;
  repositoryId: string;
  revision: number;
  eventSequence?: number;
  state: "waiting" | "blocked" | "reviewed_pr" | "merged";
}

export interface HermesInstancePayload {
  event: "usine_instance_unavailable" | "usine_instance_reconnected" | "usine_instance_reconciled";
  sourceId: string;
}

export interface HermesBridge {
  readonly upstream: HermesBridgeUpstream;
  handleEvent(envelope: ApiEventEnvelope): Promise<void>;
  reconcile(mode?: "startup" | "reconnect"): Promise<void>;
  notifyUnavailable(): Promise<void>;
  notifyReconnected(): Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
  close(): void;
}

export function signHermesWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function stableWebhookRequestId(key: string): string {
  return `usine-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

function runEffectRequest<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect);
}

export function createHermesBridge(options: HermesBridgeOptions): HermesBridge {
  if (options.sourceId.trim() === "") throw new Error("Hermes source ID is required");
  const upstream = options.upstream;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const taskLimit = options.taskLimit ?? defaultTaskLimit;
  const dispatcher = new HermesWebhookDispatcher({
    url: options.webhookUrl,
    secret: options.webhookSecret,
    fetch: fetchImpl,
    now,
    sleep,
    maxAttempts: options.maxWebhookAttempts ?? 3,
    retryDelayMs: options.webhookRetryDelayMs ?? 250,
    maxPendingSignals: options.maxPendingWebhookSignals ?? 128,
  });
  const taskStates = new Map<
    string,
    { classification: HermesAttentionPayload["state"]; revision: number } | undefined
  >();
  const controller = new AbortController();
  let unavailable = false;
  let initialReconciliationNotified = false;
  let running: Promise<void> | undefined;

  const enqueueBestEffort = (payload: HermesAttentionPayload | HermesInstancePayload): void => {
    void dispatcher.enqueue(payload).catch(() => undefined);
  };

  const observeTask = async (
    resource: ApiTaskResource | null,
    mode: "event" | "startup" | "reconnect",
    eventSequence?: number,
  ): Promise<void> => {
    if (!resource) return;
    const previous = taskStates.get(resource.taskId);
    const actionable = actionableState(resource);
    const current = actionable
      ? { classification: actionable, revision: resource.revision }
      : undefined;
    if (mode === "startup" || mode === "reconnect") {
      taskStates.set(resource.taskId, current);
      if (
        resource.state === "waiting" &&
        resource.retryable === true &&
        previous?.classification !== "waiting"
      ) {
        enqueueBestEffort(attentionPayload(resource, options.sourceId));
      }
      return;
    }
    taskStates.set(resource.taskId, current);
    if (
      current &&
      (previous?.classification !== current.classification ||
        previous.revision !== current.revision)
    ) {
      enqueueBestEffort(attentionPayload(resource, options.sourceId, eventSequence));
    }
  };

  const bridge: HermesBridge = {
    upstream,
    async handleEvent(envelope) {
      await observeTask(await upstream.getTask(envelope.taskId), "event", envelope.event.sequence);
    },
    async reconcile(mode = "startup") {
      const tasks = await upstream.listTasks(taskLimit);
      await Promise.all(
        tasks.tasks.map(async (item) => observeTask(await upstream.getTask(item.taskId), mode)),
      );
      if (mode === "startup" && !initialReconciliationNotified) {
        initialReconciliationNotified = true;
        enqueueBestEffort({
          event: "usine_instance_reconciled",
          sourceId: options.sourceId,
        });
      }
    },
    notifyUnavailable: () => {
      if (unavailable) return Promise.resolve();
      unavailable = true;
      return dispatcher.enqueue({
        event: "usine_instance_unavailable",
        sourceId: options.sourceId,
      });
    },
    async notifyReconnected() {
      if (!unavailable) return Promise.resolve();
      try {
        await bridge.reconcile("reconnect");
      } catch {
        return;
      }
      unavailable = false;
      enqueueBestEffort({
        event: "usine_instance_reconnected",
        sourceId: options.sourceId,
      });
    },
    async start(signal = controller.signal) {
      try {
        await bridge.reconcile("startup");
      } catch {
        await bridge.notifyUnavailable().catch(() => undefined);
      }
      if (running) return running;
      running = consumeEvents(bridge, signal);
      return running;
    },
    close() {
      controller.abort();
      dispatcher.close();
    },
  };

  return bridge;
}

function actionableState(resource: ApiTaskResource): HermesAttentionPayload["state"] | undefined {
  if (resource.state === "waiting" && resource.retryable === true) return "waiting";
  if (
    resource.state === "blocked" ||
    resource.state === "reviewed_pr" ||
    resource.state === "merged"
  )
    return resource.state;
  return undefined;
}

function attentionPayload(
  resource: ApiTaskResource,
  sourceId: string,
  eventSequence?: number,
): HermesAttentionPayload {
  const state = actionableState(resource);
  if (!state) throw new Error("cannot create attention payload for a non-actionable Task");
  return {
    event: "usine_attention",
    sourceId,
    taskId: resource.taskId,
    repositoryId: resource.repository?.id ?? resource.writer.repositoryIdentity,
    revision: resource.revision,
    ...(eventSequence === undefined ? {} : { eventSequence }),
    state,
  };
}

async function consumeEvents(bridge: HermesBridge, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      for await (const envelope of bridge.upstream.subscribe(signal)) {
        if (signal.aborted) return;
        void bridge.handleEvent(envelope).catch(() => undefined);
      }
      if (!signal.aborted) await bridge.notifyUnavailable();
    } catch {
      if (signal.aborted) return;
      await bridge.notifyUnavailable();
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    try {
      await bridge.notifyReconnected();
    } catch {
      // The next event-loop pass will retry reconciliation after another connection attempt.
    }
  }
}

interface HermesWebhookDispatcherOptions {
  url: string;
  secret: string;
  fetch: typeof fetch;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  maxAttempts: number;
  retryDelayMs: number;
  maxPendingSignals: number;
}

class HermesWebhookDispatcher {
  private readonly pending = new Map<string, PendingWebhookSignal>();
  private active: PendingWebhookSignal | undefined;
  private draining = false;

  constructor(private readonly options: HermesWebhookDispatcherOptions) {}

  enqueue(payload: HermesAttentionPayload | HermesInstancePayload): Promise<void> {
    const key = webhookDeliveryKey(payload);
    const existing = this.active?.key === key ? this.active : this.pending.get(key);
    if (existing) return existing.promise;
    if (this.pending.size >= this.options.maxPendingSignals) return Promise.resolve();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const signal = { key, payload, promise, resolve, reject };
    this.pending.set(key, signal);
    void this.drain();
    return promise;
  }

  close(): void {
    // In-flight requests are intentionally allowed to finish; no durable queue is created.
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size > 0) {
        const next = this.pending.values().next().value;
        if (!next) return;
        this.pending.delete(next.key);
        this.active = next;
        try {
          await this.sendWithRetry(next.payload, next.key);
          next.resolve();
        } catch (error) {
          next.reject(error);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.draining = false;
      if (this.pending.size > 0) void this.drain();
    }
  }

  private async sendWithRetry(
    payload: HermesAttentionPayload | HermesInstancePayload,
    key: string,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const requestId = stableWebhookRequestId(key);
    let lastError: unknown;
    for (let attempt = 0; attempt < this.options.maxAttempts; attempt += 1) {
      const timestamp = Math.floor(this.options.now() / 1_000);
      try {
        const response = await this.options.fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Webhook-Signature-V2": signHermesWebhook(this.options.secret, timestamp, body),
            "X-Webhook-Timestamp": String(timestamp),
            "X-Request-ID": requestId,
          },
          body,
        });
        if (!response.ok) {
          if (!isTransientWebhookStatus(response.status))
            throw new PermanentWebhookError(`Hermes webhook returned ${response.status}`);
          throw new Error(`Hermes webhook returned ${response.status}`);
        }
        return;
      } catch (error) {
        if (error instanceof PermanentWebhookError) throw error;
        lastError = error;
        if (attempt + 1 < this.options.maxAttempts)
          await this.options.sleep(this.options.retryDelayMs * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Hermes webhook delivery failed");
  }
}

interface PendingWebhookSignal {
  key: string;
  payload: HermesAttentionPayload | HermesInstancePayload;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

class PermanentWebhookError extends Error {}

function webhookDeliveryKey(payload: HermesAttentionPayload | HermesInstancePayload): string {
  if (payload.event === "usine_attention") {
    return [
      payload.sourceId,
      "attention",
      payload.taskId,
      payload.revision,
      payload.eventSequence ?? "reconciliation",
      payload.state,
    ].join(":");
  }
  return [payload.sourceId, "instance", payload.event].join(":");
}

function isTransientWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function createUsineBridgeUpstream(baseUrl: string): HermesBridgeUpstream {
  const client = Effect.runSync(makeUsineApiClient(baseUrl));
  return {
    serverSnapshot: (limit = defaultTaskLimit) =>
      runEffectRequest(client.snapshot({ query: { limit } })),
    listTasks: (limit = defaultTaskLimit) =>
      runEffectRequest(client.tasks.list({ query: { limit } })),
    getTask: async (taskId) => {
      try {
        return await runEffectRequest(client.tasks.get({ params: { taskId } }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    taskHistory: (taskId, after = 0, limit = 200) =>
      runEffectRequest(client.tasks.history({ params: { taskId }, query: { after, limit } })),
    submitTask: (submission) => runEffectRequest(client.tasks.submit({ payload: submission })),
    retryTask: (taskId) => runEffectRequest(client.tasks.retry({ params: { taskId } })),
    subscribe: (signal) => subscribeEvents(baseUrl, signal),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

async function* subscribeEvents(
  baseUrl: string,
  signal: AbortSignal,
): AsyncIterable<ApiEventEnvelope> {
  const url = new URL("/v1/events/subscribe", baseUrl);
  const response = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
  if (!response.ok || !response.body) throw new Error("Usine event stream unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffer += next.value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed === "object" && parsed !== null && "kind" in parsed) continue;
        yield decodeApiEventEnvelope(parsed);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
