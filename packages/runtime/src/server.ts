import { readFile, mkdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Duration, Effect, Exit, Fiber, FiberMap, Option, PubSub, Scope } from "effect";
import {
  applyMigrations,
  contractIssues,
  openSqliteDatabase,
  TaskAuthority,
  TaskCapacityError,
  isTaskStateQuarantinedError,
  taskContractSchema,
  repositoryRegistrationSchema,
  type RepositorySnapshot,
  type TaskContract,
  type TaskExecutionInput,
  type TaskEvent,
  type TaskResult,
  type TaskEventPage,
  type TaskListPage,
  type ServerSnapshot,
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
import type { TaskEventEnvelope } from "./server-events.js";

export interface TaskSubmission {
  contractPath: string;
  repositoryId?: string;
}

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

type EventScope = { readonly taskId?: string; readonly repositoryId?: string };

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

const SERVER_EVENT_DRAIN_TIMEOUT_MS = 1_000;
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
  await mkdir(stateDirectory, { recursive: true });
  await applyMigrations(resolve(stateDirectory, "usine.sqlite"));
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

  let resolveReady: (server: RunningUsineServer) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<RunningUsineServer>((resolveReadyValue, reject) => {
    resolveReady = resolveReadyValue;
    rejectReady = reject;
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const runTask = yield* FiberMap.makeRuntime<never, string>();
      let launchTask: (task: AdmittedTask) => void = () => undefined;
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            listen(host, port, async (request, response) => {
              await handleRequest(
                request,
                response,
                options.environment,
                launchTask,
                activeTaskCapacity,
                onEvent,
                eventHub,
              );
            }),
          catch: (cause) => new Error(`server failed to listen: ${String(cause)}`),
        }),
        (value) =>
          Effect.tryPromise({
            try: () => close(value),
            catch: (cause) => new Error(`server failed to close: ${String(cause)}`),
          }).pipe(Effect.ignore),
      );

      launchTask = (task) => {
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
          { onlyIfMissing: true },
        );
      };

      const running: RunningUsineServer = {
        host,
        port: server.addressPort,
        url: `http://${urlHost}:${server.addressPort}`,
        close: async () => undefined,
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
      resolveReady(running);
      yield* Effect.never;
    }),
  );
  const fiber = Effect.runFork(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => rejectReady(new Error(`server failed: ${String(cause)}`))),
      ),
    ),
  );
  const running = await ready;
  return {
    ...running,
    close: async () => {
      eventHub.shutdown();
      const initial = await Promise.allSettled([
        options.codingSession
          ? options.codingSession.cleanupOwned(stateDirectory)
          : Promise.resolve(),
        Effect.runPromise(Fiber.interrupt(fiber)),
      ]);
      const initialFailure = initial.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      let finalFailure: unknown;
      if (options.codingSession) {
        try {
          await options.codingSession.cleanupOwned(stateDirectory);
        } catch (error) {
          finalFailure = error;
        }
      }
      if (initialFailure) throw initialFailure.reason;
      if (finalFailure) throw finalFailure;
    },
  };
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

interface BoundServer {
  addressPort: number;
  close(callback: (error?: Error) => void): void;
}

function listen(
  host: string,
  port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<BoundServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handler(request, response).catch((error) => {
        if (!response.headersSent) {
          response.statusCode =
            error instanceof TaskCapacityError
              ? 429
              : error instanceof ServerValidationError
                ? 400
                : error instanceof ServerNotFoundError
                  ? 404
                  : 500;
          writeJson(response, errorProjection(error));
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve({ addressPort: address.port, close: (callback) => server.close(callback) });
    });
  });
}

function close(server: BoundServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function streamServerEvents(
  response: ServerResponse,
  stateDirectory: string,
  eventHub: TransientEventHub,
  scope: EventScope,
): Promise<void> {
  await validateEventScope(stateDirectory, scope);
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache");
  response.setHeader("connection", "keep-alive");
  const subscription = eventHub.subscribe(scope, () => response.destroy());
  response.once("close", () => {
    subscription.close();
  });
  response.flushHeaders();
  response.write(": connected\n\n");
  try {
    while (!response.destroyed) {
      const envelope = await subscription.take();
      if (!(await writeServerEvent(response, envelope))) return;
    }
  } catch {
    // Closing the transient subscription interrupts its pending take.
  } finally {
    subscription.close();
  }
}

function writeServerEvent(response: ServerResponse, envelope: TaskEventEnvelope): Promise<boolean> {
  if (response.destroyed) return Promise.resolve(false);
  if (response.write(`data: ${JSON.stringify(envelope)}\n\n`)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      resolve(accepted);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    timeout = setTimeout(() => {
      response.destroy();
      finish(false);
    }, SERVER_EVENT_DRAIN_TIMEOUT_MS);
  });
}

function parseEventScope(url: URL): EventScope {
  const taskId = url.searchParams.get("taskId")?.trim() || undefined;
  const repositoryId = url.searchParams.get("repositoryId")?.trim() || undefined;
  if (taskId && repositoryId)
    throw new ServerValidationError("event scope must select a Task, Repository, or whole server");
  if (url.searchParams.has("after") || url.searchParams.has("limit"))
    throw new ServerValidationError("event listeners do not support replay cursors");
  return { taskId, repositoryId };
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

function parseWaitTimeout(value: string | null): number {
  if (value == null) return DEFAULT_EVENT_WAIT_TIMEOUT_MS;
  if (!/^\d+$/.test(value))
    throw new ServerValidationError("timeoutMs must be a non-negative integer");
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_EVENT_WAIT_TIMEOUT_MS)
    throw new ServerValidationError("timeoutMs is out of range");
  return timeoutMs;
}

async function waitForServerEvent(
  response: ServerResponse,
  stateDirectory: string,
  eventHub: TransientEventHub,
  scope: EventScope,
  timeoutMs: number,
): Promise<void> {
  await validateEventScope(stateDirectory, scope);
  const subscription = eventHub.subscribe(scope);
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.once("close", () => subscription.close());
  response.flushHeaders();
  response.write(" ");
  try {
    const event = await subscription.takeWithTimeout(timeoutMs);
    if (Option.isNone(event)) {
      response.end("null");
      return;
    }
    response.end(JSON.stringify(event.value));
  } catch {
    if (!response.destroyed) response.end("null");
  } finally {
    subscription.close();
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  environment: NodeJS.ProcessEnv,
  launch: (task: AdmittedTask) => void,
  activeTaskCapacity: number,
  onEvent: (event: TaskEvent) => void,
  eventHub: TransientEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const taskEventsPath = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/)?.[1];
  const taskId = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/)?.[1];
  const stateDirectory = stateDirectoryFromEnvironment(environment);
  if (request.method === "GET" && ["/v1/events", "/v1/events/subscribe"].includes(url.pathname)) {
    await streamServerEvents(response, stateDirectory, eventHub, parseEventScope(url));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/events/wait") {
    await waitForServerEvent(
      response,
      stateDirectory,
      eventHub,
      parseEventScope(url),
      parseWaitTimeout(url.searchParams.get("timeoutMs")),
    );
    return;
  }
  if (request.method === "GET" && ["/v1/health", "/v1/server/health"].includes(url.pathname)) {
    try {
      writeJson(response, await lookupServerHealth(stateDirectory));
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: error.taskId, error: error.code });
        return;
      }
      throw error;
    }
    return;
  }
  if (request.method === "GET" && ["/v1/snapshot", "/v1/server/snapshot"].includes(url.pathname)) {
    const limit = parseCursor(url.searchParams.get("limit"), "limit", 100);
    try {
      const snapshot: ServerSnapshot = await lookupServerSnapshot(stateDirectory, limit);
      writeJson(response, snapshot);
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: error.taskId, error: error.code });
        return;
      }
      throw error;
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/tasks") {
    const limit = parseCursor(url.searchParams.get("limit"), "limit", 100);
    let page: TaskListPage;
    try {
      page = { tasks: await lookupTasks(stateDirectory, limit) };
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: error.taskId, error: error.code });
        return;
      }
      throw error;
    }
    writeJson(response, page);
    return;
  }
  if (request.method === "GET" && taskEventsPath) {
    const requestedTaskId = decodeURIComponent(taskEventsPath);
    const afterSequence = parseCursor(url.searchParams.get("after"), "after");
    const limit = parseCursor(url.searchParams.get("limit"), "limit", 200);
    let page: TaskEventPage | null;
    try {
      page = await lookupTaskEvents(stateDirectory, requestedTaskId, afterSequence, limit);
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: error.taskId, error: error.code });
        return;
      }
      throw error;
    }
    if (!page) {
      response.statusCode = 404;
      writeJson(response, { message: "task not found" });
      return;
    }
    writeJson(response, page);
    return;
  }
  if (request.method === "GET" && taskId) {
    const requestedTaskId = decodeURIComponent(taskId);
    let result: TaskResult | null;
    try {
      result = await lookupTaskStatus(stateDirectory, requestedTaskId);
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: requestedTaskId, error: error.code });
        return;
      }
      throw error;
    }
    if (!result) {
      response.statusCode = 404;
      writeJson(response, { message: "task not found" });
      return;
    }
    writeJson(response, taskResourceFromResult(result));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/repositories") {
    const limit = parseCursor(url.searchParams.get("limit"), "limit", 100);
    writeJson(response, { repositories: await lookupRepositories(stateDirectory, limit) });
    return;
  }

  const repositoryId = url.pathname.match(/^\/v1\/repositories\/([^/]+)$/)?.[1];
  if (request.method === "GET" && repositoryId) {
    const repository = await inspectRepositoryResource(
      stateDirectory,
      decodeURIComponent(repositoryId),
    );
    if (!repository) {
      response.statusCode = 404;
      writeJson(response, { message: "repository not found" });
      return;
    }
    writeJson(response, repository);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/repositories") {
    const parsed = repositoryRegistrationSchema.safeParse(JSON.parse(await readBody(request)));
    if (!parsed.success) {
      response.statusCode = 400;
      writeJson(response, { message: JSON.stringify(contractIssues(parsed.error)) });
      return;
    }
    const registration: RepositorySnapshot = {
      ...parsed.data,
      path: await realpath(parsed.data.path),
    };
    writeJson(response, await registerRepositoryResource(stateDirectory, registration));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/tasks") {
    const submission = parseSubmission(await readBody(request));
    const rawContract = await readFile(submission.contractPath, "utf8");
    const contract = parseContract(rawContract);
    if (submission.repositoryId && submission.repositoryId !== contract.repositoryId)
      throw new Error("submitted repository ID does not match the task contract");
    const repository = await inspectRepository(stateDirectory, contract.repositoryId);
    if (!repository) throw new Error(`repository is not registered: ${contract.repositoryId}`);
    const policy = runtimePolicyFromEnvironment(environment, repository);
    const result = await admitTask(
      submission.contractPath,
      rawContract,
      contract,
      policy,
      activeTaskCapacity,
      onEvent,
    );
    if (!isTerminalState(result.state)) {
      launch({
        input: { ...submission, rawContract },
        contract,
        result,
      });
    }
    writeJson(response, taskResourceFromResult(result));
    return;
  }

  response.statusCode = 404;
  writeJson(response, { message: "route not found" });
}

function parseCursor(value: string | null, name: string, fallback = 0): number {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value))
    throw new ServerValidationError(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ServerValidationError(`${name} is out of range`);
  if (name === "limit" && (parsed < 1 || parsed > 200))
    throw new ServerValidationError(`${name} is out of range`);
  return parsed;
}

function parseSubmission(body: string): TaskSubmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("request body must be JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("contractPath" in parsed) ||
    typeof parsed.contractPath !== "string" ||
    ("repositoryId" in parsed && typeof parsed.repositoryId !== "string")
  ) {
    throw new Error("task submission shape is invalid");
  }
  return {
    contractPath: parsed.contractPath,
    repositoryId:
      "repositoryId" in parsed && typeof parsed.repositoryId === "string"
        ? parsed.repositoryId
        : undefined,
  };
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("request body is too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function errorProjection(error: unknown): { message: string; code?: string; retryable?: boolean } {
  if (error instanceof ServerValidationError) return { code: error.code, message: error.message };
  if (error instanceof TaskCapacityError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof ForgeProfileResolutionError)
    return { code: error.code, message: error.message };
  return { code: "server_error", message: "server request failed" };
}
