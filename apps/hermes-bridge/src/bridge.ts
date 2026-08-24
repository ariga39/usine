import { createHash, createHmac } from "node:crypto";
import {
  Clock,
  Cause,
  Deferred,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Queue,
  Schedule,
} from "effect";
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
  close(): Promise<void>;
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
  const clock = makeBridgeClock(now, sleep);
  const runtime: ManagedRuntime.ManagedRuntime<Clock.Clock, never> = ManagedRuntime.make(
    Layer.succeed<Clock.Clock, Clock.Clock>(Clock.Clock, clock),
  );
  const dispatcher = new HermesWebhookDispatcher({
    runtime,
    url: options.webhookUrl,
    secret: options.webhookSecret,
    fetch: fetchImpl,
    now,
    maxAttempts: options.maxWebhookAttempts ?? 3,
    retryDelayMs: options.webhookRetryDelayMs ?? 250,
  });
  const taskStates = new Map<
    string,
    { classification: HermesAttentionPayload["state"]; revision: number } | undefined
  >();
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
      return dispatcher.enqueue(
        {
          event: "usine_instance_unavailable",
          sourceId: options.sourceId,
        },
        true,
      );
    },
    async notifyReconnected() {
      if (!unavailable) return Promise.resolve();
      try {
        await bridge.reconcile("reconnect");
      } catch {
        return;
      }
      unavailable = false;
      return dispatcher.enqueue(
        {
          event: "usine_instance_reconnected",
          sourceId: options.sourceId,
        },
        true,
      );
    },
    start(signal?: AbortSignal) {
      return startBridge(bridge, signal);
    },
    close() {
      return dispatcher.close();
    },
  };

  async function startBridge(bridgeInstance: HermesBridge, signal?: AbortSignal): Promise<void> {
    try {
      await bridgeInstance.reconcile("startup");
    } catch {
      await bridgeInstance.notifyUnavailable().catch(() => undefined);
    }
    if (running) return running;
    running = runtime.runPromise(
      consumeEvents(bridgeInstance, runtime),
      signal === undefined ? undefined : { signal },
    );
    return running;
  }

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

function consumeEvents(
  bridge: HermesBridge,
  runtime: ManagedRuntime.ManagedRuntime<Clock.Clock, never>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const subscription = yield* Effect.exit(
        Effect.tryPromise({
          try: async (signal) => {
            for await (const envelope of bridge.upstream.subscribe(signal)) {
              runtime
                .runPromise(Effect.tryPromise(() => bridge.handleEvent(envelope)))
                .catch(() => undefined);
            }
            return !signal.aborted;
          },
          catch: (error) => error,
        }),
      );
      if (subscription._tag === "Failure") {
        if (Cause.hasInterruptsOnly(subscription.cause)) return;
      } else if (!subscription.value) {
        return;
      }
      yield* Effect.tryPromise(() => bridge.notifyUnavailable()).pipe(
        Effect.catchCause(() => Effect.void),
      );
      yield* Effect.sleep(250);
      yield* Effect.tryPromise(() => bridge.notifyReconnected()).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }
  }).pipe(Effect.catchCause(() => Effect.void));
}

interface HermesWebhookDispatcherOptions {
  runtime: ManagedRuntime.ManagedRuntime<Clock.Clock, never>;
  url: string;
  secret: string;
  fetch: typeof fetch;
  now: () => number;
  maxAttempts: number;
  retryDelayMs: number;
}

class HermesWebhookDispatcher {
  private readonly queue: Queue.Queue<WebhookSignal>;
  private active = false;
  private reconciliationPending = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: HermesWebhookDispatcherOptions) {
    this.queue = options.runtime.runSync(Queue.dropping(2));
    options.runtime.runFork(this.consume());
  }

  enqueue(
    payload: HermesAttentionPayload | HermesInstancePayload,
    awaitDelivery = false,
  ): Promise<void> {
    const reconciliation = this.active || this.reconciliationPending;
    if (reconciliation && this.reconciliationPending) return Promise.resolve();
    const signal = reconciliation ? reconciliationPayload(payload.sourceId) : payload;
    const complete = awaitDelivery && signal.event !== "usine_instance_reconciled";
    try {
      const done = complete
        ? this.options.runtime.runSync(Deferred.make<void, unknown>())
        : undefined;
      const offered = this.options.runtime.runSync(
        Queue.offer(this.queue, { payload: signal, done }),
      );
      if (!offered) return Promise.resolve();
      this.active = true;
      if (signal.event === "usine_instance_reconciled") this.reconciliationPending = true;
      return complete && done
        ? this.options.runtime.runPromise(Deferred.await(done))
        : Promise.resolve();
    } catch {
      // The managed runtime is closed; best-effort notifications have no caller to fail.
      return Promise.resolve();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.options.runtime.dispose();
    return this.closePromise;
  }

  private consume(): Effect.Effect<never, unknown> {
    return Effect.forever(
      Queue.take(this.queue).pipe(
        Effect.flatMap((signal) => {
          if (signal.payload.event === "usine_instance_reconciled") {
            this.reconciliationPending = false;
          }
          this.active = true;
          return Effect.exit(this.sendWithRetry(signal.payload)).pipe(
            Effect.flatMap((exit) =>
              signal.done ? Deferred.done(signal.done, exit) : Effect.void,
            ),
            Effect.ensuring(
              Effect.sync(() => {
                this.active = false;
              }),
            ),
          );
        }),
      ),
    );
  }

  private sendWithRetry(
    payload: HermesAttentionPayload | HermesInstancePayload,
  ): Effect.Effect<void, PermanentWebhookError | TransientWebhookError> {
    const body = JSON.stringify(payload);
    const key = webhookDeliveryKey(payload);
    const requestId = stableWebhookRequestId(key);
    const attempt = Effect.tryPromise({
      try: (signal) => {
        const timestamp = Math.floor(this.options.now() / 1_000);
        return this.options.fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Webhook-Signature-V2": signHermesWebhook(this.options.secret, timestamp, body),
            "X-Webhook-Timestamp": String(timestamp),
            "X-Request-ID": requestId,
          },
          body,
          signal,
        });
      },
      catch: (error) => new TransientWebhookError(error),
    }).pipe(
      Effect.flatMap((response) => {
        if (response.ok) return Effect.void;
        if (!isTransientWebhookStatus(response.status))
          return Effect.fail(
            new PermanentWebhookError(`Hermes webhook returned ${response.status}`),
          );
        return Effect.fail(new TransientWebhookError(`Hermes webhook returned ${response.status}`));
      }),
    );
    return Effect.retry(attempt, {
      schedule: Schedule.recurs(Math.max(0, this.options.maxAttempts - 1)).pipe(
        Schedule.addDelay(({ attempt: retryAttempt }) =>
          Effect.succeed(Duration.millis(this.options.retryDelayMs * 2 ** (retryAttempt - 1))),
        ),
      ),
      while: (error) => error instanceof TransientWebhookError,
    });
  }
}

interface WebhookSignal {
  readonly payload: HermesAttentionPayload | HermesInstancePayload;
  readonly done: Deferred.Deferred<void, unknown> | undefined;
}

class PermanentWebhookError extends Error {}

class TransientWebhookError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function reconciliationPayload(sourceId: string): HermesInstancePayload {
  return { event: "usine_instance_reconciled", sourceId };
}

function makeBridgeClock(
  now: () => number,
  sleep: (delayMs: number) => Promise<void>,
): Clock.Clock {
  const currentTimeMillisUnsafe = () => now();
  const currentTimeNanosUnsafe = () => BigInt(Math.floor(currentTimeMillisUnsafe() * 1_000_000));
  return {
    currentTimeMillisUnsafe,
    currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
    currentTimeNanosUnsafe,
    currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
    monotonicTimeNanosUnsafe: currentTimeNanosUnsafe,
    monotonicTimeNanos: Effect.sync(currentTimeNanosUnsafe),
    sleep: (duration) =>
      Effect.tryPromise({
        try: () => sleep(Duration.toMillis(duration)),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie),
  };
}

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
