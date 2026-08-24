import { createHmac, randomUUID } from "node:crypto";
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
  Stream,
} from "effect";
import {
  makeUsineApiClient,
  type ApiEventEnvelope,
  type ApiEventStreamValue,
  type ApiTaskResource,
  type ServerSnapshot,
  type TaskEventPage,
  type TaskListPage,
  type TaskSubmission,
} from "@usine/runtime";
import { assertLoopbackHttpUrl } from "./loopback.js";

const defaultTaskLimit = 100;

export interface HermesBridgeUpstream {
  serverSnapshot(limit?: number, signal?: AbortSignal): Promise<ServerSnapshot>;
  listTasks(limit?: number, signal?: AbortSignal): Promise<TaskListPage>;
  getTask(taskId: string, signal?: AbortSignal): Promise<ApiTaskResource | null>;
  taskHistory(
    taskId: string,
    after?: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<TaskEventPage>;
  submitTask(submission: TaskSubmission, signal?: AbortSignal): Promise<ApiTaskResource>;
  retryTask(taskId: string, signal?: AbortSignal): Promise<ApiTaskResource>;
  subscribe(): Effect.Effect<Stream.Stream<ApiEventStreamValue, unknown>, unknown>;
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
  repositoryId?: string;
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

function newWebhookRequestId(): string {
  return `usine-${randomUUID().replaceAll("-", "")}`;
}

function runEffectRequest<A>(effect: Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect, signal === undefined ? undefined : { signal });
}

export function createHermesBridge(options: HermesBridgeOptions): HermesBridge {
  if (options.sourceId.trim() === "") throw new Error("Hermes source ID is required");
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
  const sourceUpstream = options.upstream;
  const trackedTaskIds = new Set<string>();
  const trackedRepositoryIds = new Map<string, string>();
  const trackTask = (taskId: string, repositoryId?: string): void => {
    trackedTaskIds.add(taskId);
    if (repositoryId !== undefined) trackedRepositoryIds.set(taskId, repositoryId);
  };
  const upstream: HermesBridgeUpstream = {
    serverSnapshot: async (limit, signal) => {
      const snapshot = await sourceUpstream.serverSnapshot(limit, signal);
      for (const resource of snapshot.tasks) trackTask(resource.taskId);
      return snapshot;
    },
    listTasks: async (limit, signal) => {
      const page = await sourceUpstream.listTasks(limit, signal);
      for (const resource of page.tasks) trackTask(resource.taskId);
      return page;
    },
    getTask: async (taskId, signal) => {
      trackTask(taskId);
      const resource = await sourceUpstream.getTask(taskId, signal);
      if (resource) trackTask(resource.taskId, resource.repository?.id);
      return resource;
    },
    taskHistory: async (taskId, after, limit, signal) => {
      trackTask(taskId);
      return sourceUpstream.taskHistory(taskId, after, limit, signal);
    },
    submitTask: async (submission, signal) => {
      const resource = await sourceUpstream.submitTask(submission, signal);
      trackTask(resource.taskId, resource.repository?.id ?? submission.repositoryId);
      return resource;
    },
    retryTask: async (taskId, signal) => {
      trackTask(taskId);
      const resource = await sourceUpstream.retryTask(taskId, signal);
      trackTask(resource.taskId, resource.repository?.id);
      return resource;
    },
    subscribe: () => sourceUpstream.subscribe(),
  };
  const taskStates = new Map<
    string,
    { classification: HermesAttentionPayload["state"]; revision: number } | undefined
  >();
  let unavailable = false;
  let initialReconciliationNotified = false;
  let running: Promise<void> | undefined;
  let closed = false;

  const enqueueBestEffort = (payload: HermesAttentionPayload | HermesInstancePayload): void => {
    void dispatcher.enqueue(payload).catch(() => undefined);
  };

  const observeTask = async (
    resource: ObservableTask | null,
    mode: "event" | "startup" | "reconnect",
    eventSequence?: number,
    eventRepositoryId?: string,
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
        enqueueBestEffort(
          attentionPayload(resource, options.sourceId, undefined, eventRepositoryId),
        );
      }
      return;
    }
    taskStates.set(resource.taskId, current);
    if (
      current &&
      (previous?.classification !== current.classification ||
        previous.revision !== current.revision)
    ) {
      enqueueBestEffort(
        attentionPayload(resource, options.sourceId, eventSequence, eventRepositoryId),
      );
    }
  };

  const handleEventEffect = (envelope: ApiEventEnvelope): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      try: (signal) => {
        trackTask(envelope.taskId, envelope.repositoryId);
        return upstream
          .getTask(envelope.taskId, signal)
          .then((resource) =>
            observeTask(resource, "event", envelope.event.sequence, envelope.repositoryId),
          );
      },
      catch: (error) => error,
    });

  const reconcileEffect = (mode: "startup" | "reconnect"): Effect.Effect<void, unknown> =>
    Effect.tryPromise({
      try: async (signal) => {
        const tasks = await upstream.listTasks(taskLimit, signal);
        const listedTaskIds = new Set(tasks.tasks.map((resource) => resource.taskId));
        await Promise.all(
          tasks.tasks.map((resource) =>
            observeTask(resource, mode, undefined, trackedRepositoryIds.get(resource.taskId)),
          ),
        );
        await Promise.all(
          [...trackedTaskIds]
            .filter((taskId) => !listedTaskIds.has(taskId))
            .map(async (taskId) => {
              const resource = await upstream.getTask(taskId, signal);
              await observeTask(resource, mode, undefined, trackedRepositoryIds.get(taskId));
            }),
        );
        if (mode === "startup" && !initialReconciliationNotified) {
          initialReconciliationNotified = true;
          enqueueBestEffort({
            event: "usine_instance_reconciled",
            sourceId: options.sourceId,
          });
        }
      },
      catch: (error) => error,
    });

  const notifyUnavailableEffect = Effect.suspend(() => {
    if (unavailable) return Effect.void;
    unavailable = true;
    return Effect.tryPromise(() =>
      dispatcher.enqueue(
        {
          event: "usine_instance_unavailable",
          sourceId: options.sourceId,
        },
        true,
      ),
    );
  });

  const notifyReconnectedEffect = Effect.gen(function* () {
    if (!unavailable) return;
    const reconciliation = yield* Effect.exit(reconcileEffect("reconnect"));
    if (reconciliation._tag === "Failure") return;
    unavailable = false;
    yield* Effect.tryPromise(() =>
      dispatcher.enqueue(
        {
          event: "usine_instance_reconnected",
          sourceId: options.sourceId,
        },
        true,
      ),
    );
  });

  const bridge: HermesBridge = {
    upstream,
    async handleEvent(envelope) {
      await runtime.runPromise(handleEventEffect(envelope));
    },
    async reconcile(mode = "startup") {
      await runtime.runPromise(reconcileEffect(mode));
    },
    notifyUnavailable: () => runtime.runPromise(notifyUnavailableEffect),
    notifyReconnected: () => runtime.runPromise(notifyReconnectedEffect),
    start(signal?: AbortSignal) {
      return startBridge(signal);
    },
    close() {
      closed = true;
      return dispatcher.close();
    },
  };

  function startBridge(signal?: AbortSignal): Promise<void> {
    if (running) return running;
    const started = runtime.runPromise(
      Effect.gen(function* () {
        const reconciliation = yield* Effect.exit(reconcileEffect("startup"));
        if (reconciliation._tag === "Failure") {
          if (Cause.hasInterruptsOnly(reconciliation.cause)) return;
          yield* notifyUnavailableEffect.pipe(Effect.catchCause(() => Effect.void));
        }
        yield* consumeEvents(
          upstream,
          handleEventEffect,
          notifyUnavailableEffect,
          notifyReconnectedEffect,
        );
      }).pipe(Effect.catchCause(() => Effect.void)),
      signal === undefined ? undefined : { signal },
    );
    running = started.catch((error: unknown) => {
      if (closed) return;
      throw error;
    });
    return running;
  }

  return bridge;
}

type ObservableTask = ApiTaskResource | TaskListPage["tasks"][number];

function actionableState(resource: ObservableTask): HermesAttentionPayload["state"] | undefined {
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
  resource: ObservableTask,
  sourceId: string,
  eventSequence?: number,
  eventRepositoryId?: string,
): HermesAttentionPayload {
  const state = actionableState(resource);
  if (!state) throw new Error("cannot create attention payload for a non-actionable Task");
  return {
    event: "usine_attention",
    sourceId,
    taskId: resource.taskId,
    revision: resource.revision,
    ...(eventSequence === undefined ? {} : { eventSequence }),
    state,
    ...(eventRepositoryId !== undefined
      ? { repositoryId: eventRepositoryId }
      : "repository" in resource && resource.repository
        ? { repositoryId: resource.repository.id }
        : {}),
  };
}

function consumeEvents(
  upstream: HermesBridgeUpstream,
  handleEvent: (envelope: ApiEventEnvelope) => Effect.Effect<void, unknown>,
  notifyUnavailable: Effect.Effect<void, unknown>,
  notifyReconnected: Effect.Effect<void, unknown>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const subscription = yield* Effect.exit(
        Effect.gen(function* () {
          const stream = yield* upstream.subscribe();
          yield* Stream.runForEach(stream, (observation) => {
            if ("kind" in observation) {
              return observation.kind === "ready"
                ? notifyReconnected.pipe(Effect.catchCause(() => Effect.void))
                : Effect.void;
            }
            return handleEvent(observation);
          });
        }),
      );
      if (subscription._tag === "Failure") {
        if (Cause.hasInterruptsOnly(subscription.cause)) return;
      }
      yield* notifyUnavailable.pipe(Effect.catchCause(() => Effect.void));
      yield* Effect.sleep(250);
      yield* notifyReconnected.pipe(Effect.catchCause(() => Effect.void));
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
        Queue.offer(this.queue, { payload: signal, requestId: newWebhookRequestId(), done }),
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
          return Effect.exit(this.sendWithRetry(signal)).pipe(
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
    signal: WebhookSignal,
  ): Effect.Effect<void, PermanentWebhookError | TransientWebhookError> {
    const payload = signal.payload;
    const body = JSON.stringify(payload);
    const attempt = Effect.tryPromise({
      try: (abortSignal) => {
        const timestamp = Math.floor(this.options.now() / 1_000);
        return this.options.fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Webhook-Signature-V2": signHermesWebhook(this.options.secret, timestamp, body),
            "X-Webhook-Timestamp": String(timestamp),
            "X-Request-ID": signal.requestId,
          },
          body,
          signal: abortSignal,
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
  readonly requestId: string;
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

function isTransientWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function createUsineBridgeUpstream(baseUrl: string): HermesBridgeUpstream {
  assertLoopbackHttpUrl(baseUrl);
  const client = Effect.runSync(makeUsineApiClient(baseUrl));
  return {
    serverSnapshot: (limit = defaultTaskLimit, signal) =>
      runEffectRequest(client.snapshot({ query: { limit } }), signal),
    listTasks: (limit = defaultTaskLimit, signal) =>
      runEffectRequest(client.tasks.list({ query: { limit } }), signal),
    getTask: async (taskId, signal) => {
      try {
        return await runEffectRequest(client.tasks.get({ params: { taskId } }), signal);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    taskHistory: (taskId, after = 0, limit = 200, signal) =>
      runEffectRequest(
        client.tasks.history({ params: { taskId }, query: { after, limit } }),
        signal,
      ),
    submitTask: (submission, signal) =>
      runEffectRequest(client.tasks.submit({ payload: submission }), signal),
    retryTask: (taskId, signal) =>
      runEffectRequest(client.tasks.retry({ params: { taskId } }), signal),
    subscribe: () => client.events.subscribe({ query: {} }),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "not_found") ||
      ("error" in error && error.error === "not_found"))
  );
}
