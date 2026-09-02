import { readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Duration, Effect, Exit, FiberMap, Layer, Option, PubSub, Scope, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  applyMigrations,
  contractIssues,
  openSqliteDatabase,
  TaskAuthority,
  TaskCapacityError,
  TaskRetryConflictError,
  isTaskStateQuarantinedError,
  taskContractSchema,
  repositoryRegistrationSchema,
  type RepositorySnapshot,
  type TaskContract,
  type TaskExecutionInput,
  type TaskEvent,
  type TaskResult,
  taskResourceFromResult,
  isTerminalState,
} from "@usine/task-authority";
import type { CodingSessionCleanup } from "@usine/coding-session";
import {
  admitTask,
  executeAdmittedTask,
  inspectRepository,
  inspectRepositoryResource,
  lookupRepositories,
  registerRepositoryResource,
  lookupRestartableTasks,
  lookupTaskExecution,
  retryTask,
  lookupTaskStatus,
  lookupTaskEvents,
  lookupTasks,
  lookupServerHealth,
  lookupServerSnapshot,
  recordRecoveryObservation,
  runtimePolicyFromEnvironment,
  stateDirectoryFromEnvironment,
  ForgeProfileResolutionError,
  type RuntimePolicy,
} from "./runtime.js";
import {
  UsineApi,
  type ApiError,
  type ApiEventEnvelope,
  type ApiEventQuery,
  type ApiEventScope,
  type ApiEventStreamValue,
  type ApiTaskSubmission,
  type ApiTaskResource,
  encodeApiWaitResponse,
} from "./http-api.js";
import { ensurePrivateStateDatabase } from "./private-state.js";
type TaskEventEnvelope = ApiEventEnvelope;
type LaunchMode = "deduplicated" | "replace";

export type TaskSubmission = ApiTaskSubmission;

export interface ServerExecutionContext {
  input: TaskExecutionInput;
  contract: TaskContract;
  result: TaskResult;
  authority: TaskAuthority;
  policy: RuntimePolicy;
  signal: AbortSignal;
}

export type ServerExecution = (context: ServerExecutionContext) => Promise<TaskResult>;

export interface UsineServerOptions {
  environment: NodeJS.ProcessEnv;
  execute?: ServerExecution;
  codingSession?: CodingSessionCleanup;
  host?: string;
  port?: number;
}

export interface RunningUsineServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export class TaskCapacityStartupError extends Error {
  readonly code = "active_task_capacity_startup";

  constructor(
    readonly capacity: number,
    readonly active: number,
  ) {
    super("durable nonterminal Tasks exceed active Task capacity");
    this.name = "TaskCapacityStartupError";
  }
}

class ServerValidationError extends Error {
  readonly code = "validation";

  constructor(message: string) {
    super(message);
    this.name = "ServerValidationError";
  }
}

class ServerNotFoundError extends Error {
  readonly code = "not_found";

  constructor(message: string) {
    super(message);
    this.name = "ServerNotFoundError";
  }
}

interface AdmittedTask {
  input: TaskExecutionInput;
  contract: TaskContract;
  result: TaskResult;
}

type EventScope = ApiEventScope;

interface TransientEventListener {
  readonly scope: EventScope;
  readonly take: () => Promise<TaskEventEnvelope>;
  readonly takeWithTimeout: (timeoutMs: number) => Promise<Option.Option<TaskEventEnvelope>>;
  readonly publish: (envelope: TaskEventEnvelope) => boolean;
  readonly close: () => void;
}

class TransientEventHub {
  private readonly listeners = new Set<TransientEventListener>();
  private closed = false;

  subscribe(scope: EventScope, onClosed: () => void = () => undefined): TransientEventListener {
    if (this.closed) throw new Error("event hub is closed");
    const pubsub = Effect.runSync(PubSub.dropping<TaskEventEnvelope>(64));
    const listenerScope = Scope.makeUnsafe();
    const subscription = Effect.runSync(
      PubSub.subscribe(pubsub).pipe(Effect.provideService(Scope.Scope, listenerScope)),
    );
    let closed = false;
    const listener: TransientEventListener = {
      scope,
      take: () => Effect.runPromise(PubSub.take(subscription)),
      takeWithTimeout: (timeoutMs) =>
        Effect.runPromise(
          PubSub.take(subscription).pipe(Effect.timeoutOption(Duration.millis(timeoutMs))),
        ),
      publish: (envelope) => Effect.runSync(PubSub.publish(pubsub, envelope)),
      close: () => {
        if (closed) return;
        closed = true;
        this.listeners.delete(listener);
        void Effect.runPromise(Scope.close(listenerScope, Exit.void)).catch(() => undefined);
        onClosed();
      },
    };
    this.listeners.add(listener);
    return listener;
  }

  publish(envelope: TaskEventEnvelope): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      if (
        (listener.scope.taskId !== undefined && listener.scope.taskId !== envelope.taskId) ||
        (listener.scope.repositoryId !== undefined &&
          listener.scope.repositoryId !== envelope.repositoryId)
      )
        continue;
      let accepted = false;
      try {
        accepted = listener.publish(envelope);
      } catch {
        accepted = false;
      }
      if (!accepted) listener.close();
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener.close();
  }
}

const DEFAULT_EVENT_WAIT_TIMEOUT_MS = 30_000;
const MAX_EVENT_WAIT_TIMEOUT_MS = 60_000;
export async function startUsineServer(options: UsineServerOptions): Promise<RunningUsineServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!isLoopbackHost(host)) throw new Error("server host must be loopback");
  const urlHost = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  const stateDirectory = stateDirectoryFromEnvironment(options.environment);
  const activeTaskCapacity = activeTaskCapacityFromEnvironment(options.environment);
  const eventHub = new TransientEventHub();
  let eventDispatch = Promise.resolve();
  const onEvent = (event: TaskEvent): void => {
    eventDispatch = eventDispatch
      .then(async () => {
        const result = await lookupTaskStatus(stateDirectory, event.taskId);
        const repositoryId = result?.repository?.id;
        if (repositoryId) eventHub.publish({ taskId: event.taskId, repositoryId, event });
      })
      .catch(() => undefined);
  };
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  const restartState = await lookupRestartableTasks(stateDirectory);
  const restartable: typeof restartState.restartable = [];
  let activeTaskCount = restartState.activeTaskCount;
  for (const task of restartState.restartable) {
    try {
      parseContract(task.input.rawContract);
      restartable.push(task);
    } catch (error) {
      await blockPersistedTask(stateDirectory, task.result.taskId, error, onEvent);
      activeTaskCount -= 1;
    }
  }
  if (activeTaskCount > activeTaskCapacity)
    throw new TaskCapacityStartupError(activeTaskCapacity, activeTaskCount);

  const scope = await Effect.runPromise(Scope.make("sequential"));
  const program = Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () =>
      options.codingSession
        ? Effect.tryPromise({
            try: () => options.codingSession!.cleanupOwned(stateDirectory),
            catch: (cause) => new Error(`server execution cleanup failed: ${String(cause)}`),
          }).pipe(Effect.orDie)
        : Effect.void,
    );

    const runTask = yield* FiberMap.makeRuntime<never, string>();
    let launchTask: (task: AdmittedTask, mode?: LaunchMode) => void = () => undefined;
    const api = yield* HttpRouter.toHttpEffect(
      createApiLayer({
        environment: options.environment,
        launch: (task, mode) => launchTask(task, mode),
        activeTaskCapacity,
        onEvent,
        eventHub,
      }).pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
    );
    const server = yield* NodeHttpServer.make(createServer, { host, port }).pipe(
      Effect.mapError((cause) => new Error(`server failed to listen: ${String(cause.cause)}`)),
    );
    yield* server.serve(api);
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => eventHub.shutdown()));

    launchTask = (task, mode = "deduplicated") => {
      runTask(
        task.result.taskId,
        Effect.tryPromise({
          try: (signal) =>
            executeServerTask(
              task,
              options.environment,
              stateDirectory,
              options.execute,
              signal,
              onEvent,
            ),
          catch: (cause) => cause,
        }).pipe(Effect.asVoid),
        mode === "deduplicated" ? { onlyIfMissing: true } : undefined,
      );
    };

    for (const task of restartable) {
      yield* Effect.tryPromise({
        try: async () => {
          if (options.codingSession)
            await options.codingSession.cleanupTask(stateDirectory, task.result.taskId);
          await recordRecoveryObservation(
            stateDirectory,
            task.result.taskId,
            "server_restart",
            onEvent,
          );
          await recordRecoveryObservation(
            stateDirectory,
            task.result.taskId,
            "execution_owner_changed",
            onEvent,
          );
          const contract = parseContract(task.input.rawContract);
          launchTask({ input: task.input, contract, result: task.result });
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((error) =>
          Effect.tryPromise({
            try: () => blockPersistedTask(stateDirectory, task.result.taskId, error, onEvent),
            catch: (cause) => cause,
          }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        ),
      );
    }

    const serverPort = server.address._tag === "TcpAddress" ? server.address.port : port;
    return {
      host,
      port: serverPort,
      url: `http://${urlHost}:${serverPort}`,
    };
  });

  try {
    const running = await Effect.runPromise(Effect.provideService(program, Scope.Scope, scope));
    let closePromise: Promise<void> | undefined;
    return {
      ...running,
      close: () =>
        (closePromise ??= Effect.runPromise(Scope.close(scope, Exit.void)).then(() => undefined)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.fail(error))).catch(() => undefined);
    throw error;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function activeTaskCapacityFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const configured = environment.USINE_ACTIVE_TASK_CAPACITY?.trim();
  if (!configured) return 1;
  if (!/^\d+$/.test(configured))
    throw new Error("USINE_ACTIVE_TASK_CAPACITY must be a positive finite integer");
  const capacity = Number(configured);
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error("USINE_ACTIVE_TASK_CAPACITY must be a positive finite integer");
  return capacity;
}

async function executeServerTask(
  task: AdmittedTask,
  environment: NodeJS.ProcessEnv,
  stateDirectory: string,
  execute: ServerExecution | undefined,
  signal: AbortSignal,
  onEvent: (event: TaskEvent) => void,
): Promise<TaskResult> {
  let policy: RuntimePolicy;
  try {
    if (!task.result.repository) throw new Error("admitted task has no repository snapshot");
    const repository = await inspectRepository(stateDirectory, task.result.repository.id);
    if (!repository) throw new Error("registered repository is missing");
    policy = runtimePolicyFromEnvironment(environment, repository);
  } catch (error) {
    return blockPersistedTask(stateDirectory, task.result.taskId, error, onEvent);
  }
  if (!execute) {
    return executeAdmittedTask(task.input, task.contract, policy, signal, onEvent);
  }

  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  const authority = new TaskAuthority(handle.database, { onEvent });
  try {
    const current = await authority.lookup(task.result.taskId);
    if (!current || isTerminalState(current.state)) {
      return current ?? task.result;
    }
    try {
      return await execute({
        input: task.input,
        contract: task.contract,
        result: current,
        authority,
        policy,
        signal,
      });
    } catch (error) {
      const latest = await authority.lookup(current.taskId);
      if (signal.aborted) return latest ?? task.result;
      if (!latest || isTerminalState(latest.state)) throw error;
      return await authority.block(
        { taskId: latest.taskId, revision: latest.revision },
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    handle.close();
  }
}

async function blockPersistedTask(
  stateDirectory: string,
  taskId: string,
  error: unknown,
  onEvent?: (event: TaskEvent) => void,
): Promise<TaskResult> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  const authority = new TaskAuthority(handle.database, { onEvent });
  try {
    const current = await authority.lookup(taskId);
    if (!current) throw new Error(`cannot block missing task ${taskId}: ${String(error)}`);
    if (isTerminalState(current.state)) return current;
    return await authority.block(
      { taskId: current.taskId, revision: current.revision },
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    handle.close();
  }
}

function createApiLayer(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly launch: (task: AdmittedTask, mode?: LaunchMode) => void;
  readonly activeTaskCapacity: number;
  readonly onEvent: (event: TaskEvent) => void;
  readonly eventHub: TransientEventHub;
}) {
  const stateDirectory = stateDirectoryFromEnvironment(options.environment);
  const serverHandlers = HttpApiBuilder.group(UsineApi, "server", (handlers) =>
    handlers.handleAll({
      health: () => apiEffect(() => lookupServerHealth(stateDirectory)),
      healthAlias: () => apiEffect(() => lookupServerHealth(stateDirectory)),
      snapshot: ({ query }) =>
        apiEffect(() => lookupServerSnapshot(stateDirectory, validLimit(query.limit, 100))),
      snapshotAlias: ({ query }) =>
        apiEffect(() => lookupServerSnapshot(stateDirectory, validLimit(query.limit, 100))),
    }),
  );
  const repositoryHandlers = HttpApiBuilder.group(UsineApi, "repositories", (handlers) =>
    handlers.handleAll({
      list: ({ query }) =>
        apiEffect(async () => ({
          repositories: await lookupRepositories(stateDirectory, validLimit(query.limit, 100)),
        })),
      get: ({ params }) =>
        apiEffect(async () => {
          const repository = await inspectRepositoryResource(stateDirectory, params.repositoryId);
          if (!repository) throw new ServerNotFoundError("repository not found");
          return repository;
        }),
      register: ({ payload }) =>
        apiEffect(async () => {
          const parsed = repositoryRegistrationSchema.safeParse(payload);
          if (!parsed.success)
            throw new ServerValidationError(JSON.stringify(contractIssues(parsed.error)));
          const registration: RepositorySnapshot = {
            ...parsed.data,
            path: await realpath(parsed.data.path),
          };
          return registerRepositoryResource(stateDirectory, registration);
        }),
    }),
  );
  const taskHandlers = HttpApiBuilder.group(UsineApi, "tasks", (handlers) =>
    handlers.handleAll({
      list: ({ query }) =>
        apiEffect(async () => ({
          tasks: await lookupTasks(stateDirectory, validLimit(query.limit, 100)),
        })),
      get: ({ params }) =>
        apiEffect(async () => {
          const result = await lookupTaskStatus(stateDirectory, params.taskId);
          if (!result) throw new ServerNotFoundError("task not found");
          return taskResourceForApi(result);
        }),
      history: ({ params, query }) =>
        apiEffect(async () => {
          const page = await lookupTaskEvents(
            stateDirectory,
            params.taskId,
            validCursor(query.after, 0),
            validLimit(query.limit, 200),
          );
          if (!page) throw new ServerNotFoundError("task not found");
          return page;
        }),
      submit: ({ payload }) =>
        apiEffect(async () => {
          const submission: TaskSubmission = payload;
          const rawContract = await readFile(submission.contractPath, "utf8");
          const contract = parseContract(rawContract);
          if (submission.repositoryId && submission.repositoryId !== contract.repositoryId)
            throw new ServerValidationError(
              "submitted repository ID does not match the task contract",
            );
          const repository = await inspectRepository(stateDirectory, contract.repositoryId);
          if (!repository)
            throw new ServerNotFoundError(`repository is not registered: ${contract.repositoryId}`);
          const policy = runtimePolicyFromEnvironment(options.environment, repository);
          const result = await admitTask(
            submission.contractPath,
            rawContract,
            contract,
            policy,
            options.activeTaskCapacity,
            options.onEvent,
          );
          if (!isTerminalState(result.state) && result.state !== "waiting")
            options.launch({ input: { ...submission, rawContract }, contract, result });
          return taskResourceForApi(result);
        }),
      retry: ({ params }) =>
        apiEffect(async () => {
          const execution = await lookupTaskExecution(stateDirectory, params.taskId);
          if (!execution) throw new ServerNotFoundError("task not found");
          const contract = parseContract(execution.input.rawContract);
          const result = await retryTask(
            stateDirectory,
            params.taskId,
            contract.budget.maxImplementerActivations,
            options.onEvent,
          );
          if (!isTerminalState(result.state) && result.state !== "waiting")
            options.launch({ input: execution.input, contract, result }, "replace");
          return taskResourceForApi(result);
        }),
    }),
  );
  const eventHandlers = HttpApiBuilder.group(UsineApi, "events", (handlers) =>
    handlers.handleAll({
      wait: ({ query }) => waitApiEventResponse(stateDirectory, options.eventHub, query),
      subscribe: ({ query }) => subscribeApiEvents(stateDirectory, options.eventHub, query),
      subscribeAlias: ({ query }) => subscribeApiEvents(stateDirectory, options.eventHub, query),
    }),
  );
  const apiLayer = HttpApiBuilder.layer(UsineApi).pipe(
    Layer.provide(Layer.mergeAll(serverHandlers, repositoryHandlers, taskHandlers, eventHandlers)),
  );
  return apiLayer;
}

function apiEffect<A>(thunk: () => Promise<A>): Effect.Effect<A, ApiError> {
  return Effect.tryPromise({ try: thunk, catch: apiError });
}

function apiError(error: unknown): ApiError {
  if (error instanceof ServerValidationError) return { code: "validation", message: error.message };
  if (error instanceof ServerNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof TaskCapacityError)
    return { code: "active_task_capacity", message: error.message, retryable: true };
  if (error instanceof TaskRetryConflictError)
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      state: error.state,
    };
  if (isTaskStateQuarantinedError(error)) {
    if (error.taskId !== undefined)
      return { taskId: error.taskId, error: "task_state_quarantined" };
    return { code: "server_error", message: "server request failed" };
  }
  if (error instanceof ForgeProfileResolutionError)
    return { code: error.code, message: error.message };
  return { code: "server_error", message: "server request failed" };
}

function validLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new ServerValidationError("limit is out of range");
  return limit;
}

function validCursor(value: number | undefined, fallback: number): number {
  const cursor = value ?? fallback;
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ServerValidationError("cursor is out of range");
  return cursor;
}

function eventScopeFromQuery(query: ApiEventScope): EventScope {
  const taskId = query.taskId?.trim() || undefined;
  const repositoryId = query.repositoryId?.trim() || undefined;
  if (taskId && repositoryId)
    throw new ServerValidationError("event scope must select a Task, Repository, or whole server");
  return { taskId, repositoryId };
}

function waitApiEventResponse(
  stateDirectory: string,
  eventHub: TransientEventHub,
  query: ApiEventQuery & { readonly timeoutMs?: number },
): Effect.Effect<HttpServerResponse.HttpServerResponse, ApiError> {
  return apiEffect(async () => {
    rejectEventReplayQuery(query);
    const scope = eventScopeFromQuery(query);
    await validateEventScope(stateDirectory, scope);
    const timeoutMs = query.timeoutMs ?? DEFAULT_EVENT_WAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_EVENT_WAIT_TIMEOUT_MS)
      throw new ServerValidationError("timeoutMs is out of range");
    const listener = eventHub.subscribe(scope);
    const eventBytes: Effect.Effect<Uint8Array, never> = Effect.tryPromise({
      try: listener.takeWithTimeout.bind(listener, timeoutMs),
      catch: () => new Error("event listener closed"),
    }).pipe(
      Effect.map((event) =>
        new TextEncoder().encode(encodeApiWaitResponse(Option.isNone(event) ? null : event.value)),
      ),
      Effect.catchCause(() => Effect.succeed(new TextEncoder().encode("null"))),
    );
    const body: Stream.Stream<Uint8Array, never> = Stream.concat(
      Stream.succeed(new TextEncoder().encode(" ")),
      Stream.fromEffect(eventBytes),
    ).pipe(Stream.ensuring(Effect.sync(listener.close)));
    return HttpServerResponse.stream(body, { contentType: "application/json" });
  });
}

function subscribeApiEvents(
  stateDirectory: string,
  eventHub: TransientEventHub,
  query: ApiEventQuery,
): Effect.Effect<Stream.Stream<ApiEventStreamValue>, ApiError> {
  return apiEffect(async () => {
    rejectEventReplayQuery(query);
    const scope = eventScopeFromQuery(query);
    await validateEventScope(stateDirectory, scope);
    const listener = eventHub.subscribe(scope);
    return Stream.concat(
      Stream.succeed({ kind: "ready" as const }),
      Stream.fromEffectRepeat(
        Effect.tryPromise({
          try: listener.take,
          catch: () => new Error("event listener closed"),
        }),
      ),
    ).pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.ensuring(Effect.sync(listener.close)),
    );
  });
}

function rejectEventReplayQuery(query: ApiEventQuery): void {
  if (query.after !== undefined || query.limit !== undefined)
    throw new ServerValidationError("event wait and subscribe do not support replay cursors");
}

function taskResourceForApi(result: TaskResult): ApiTaskResource {
  const resource = taskResourceFromResult(result);
  return {
    ...resource,
    waiting: resource.waiting ?? null,
    retryable: resource.retryable ?? false,
    delivery: resource.delivery
      ? { ...resource.delivery, merge: resource.delivery.merge ?? null }
      : null,
  };
}

async function validateEventScope(stateDirectory: string, scope: EventScope): Promise<void> {
  if (scope.taskId !== undefined) {
    if (!(await lookupTaskStatus(stateDirectory, scope.taskId)))
      throw new ServerNotFoundError("task not found");
    return;
  }
  if (scope.repositoryId !== undefined) {
    if (!(await inspectRepository(stateDirectory, scope.repositoryId)))
      throw new ServerNotFoundError("repository not found");
  }
}

function parseContract(rawContract: string): TaskContract {
  let input: unknown;
  try {
    input = JSON.parse(rawContract);
  } catch {
    throw new Error("task contract must be JSON");
  }
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid task contract: ${JSON.stringify(contractIssues(parsed.error))}`);
  }
  return parsed.data;
}
