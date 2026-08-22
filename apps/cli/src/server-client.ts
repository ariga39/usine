import { Effect, Result, Stream } from "effect";
import { HttpClientError } from "effect/unstable/http";
import {
  decodeApiEventStreamValue,
  makeUsineApiClient,
  type ApiEventEnvelope,
  type ApiEventScope,
  type ApiTaskSubmission,
} from "@usine/runtime";
import {
  type TaskEvent,
  type TaskEventPage,
  type TaskListPage,
  type TaskResource,
  type RepositoryResource,
  type RepositorySnapshot,
  type ServerHealth,
  type ServerSnapshot,
  isTerminalState,
} from "@usine/task-authority";

export type TaskSubmission = ApiTaskSubmission;

export function serverUrlFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.USINE_SERVER_URL?.trim();
  if (explicit) return explicit;
  const host = environment.USINE_SERVER_HOST?.trim() || "127.0.0.1";
  const port = environment.USINE_SERVER_PORT?.trim() || "8787";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export class ServerClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ServerFailureKind = failureKindForStatus(status),
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "ServerClientError";
  }
}

export class TaskCapacityError extends ServerClientError {
  readonly code = "active_task_capacity";
  readonly retryable = true;

  constructor(message: string, status: number, diagnostic = "active_task_capacity") {
    super(message, status, "server", diagnostic);
    this.name = "TaskCapacityError";
  }
}

export type ServerFailureKind = "validation" | "not_found" | "timeout" | "connection" | "server";

async function clientFor(serverUrl: string) {
  return Effect.runPromise(makeUsineApiClient(serverUrl));
}

async function runRequest<A>(request: Effect.Effect<A, unknown>): Promise<A> {
  try {
    return await Effect.runPromise(request);
  } catch (error) {
    throw clientError(error);
  }
}

export async function serverHealth(serverUrl: string): Promise<ServerHealth> {
  const client = await clientFor(serverUrl);
  return runRequest(client.health());
}

export async function serverSnapshot(serverUrl: string, limit = 100): Promise<ServerSnapshot> {
  validateLimit(limit);
  const client = await clientFor(serverUrl);
  return runRequest(client.snapshot({ query: { limit } }));
}

export async function submitTask(
  serverUrl: string,
  submission: TaskSubmission,
): Promise<TaskResource> {
  const client = await clientFor(serverUrl);
  return runRequest(client.tasks.submit({ payload: submission }));
}

export async function registerRepository(
  serverUrl: string,
  repository: RepositorySnapshot,
): Promise<RepositoryResource> {
  const client = await clientFor(serverUrl);
  return runRequest(client.repositories.register({ payload: repository }));
}

export async function inspectRepository(
  serverUrl: string,
  repositoryId: string,
): Promise<RepositoryResource | null> {
  const client = await clientFor(serverUrl);
  try {
    return await runRequest(client.repositories.get({ params: { repositoryId } }));
  } catch (error) {
    if (error instanceof ServerClientError && error.status === 404) return null;
    throw error;
  }
}

export async function listRepositories(
  serverUrl: string,
  limit = 100,
): Promise<{ repositories: RepositoryResource[] }> {
  validateLimit(limit);
  const client = await clientFor(serverUrl);
  const result = await runRequest(client.repositories.list({ query: { limit } }));
  return { repositories: [...result.repositories] };
}

export async function taskStatus(serverUrl: string, taskId: string): Promise<TaskResource | null> {
  const client = await clientFor(serverUrl);
  try {
    return await runRequest(client.tasks.get({ params: { taskId } }));
  } catch (error) {
    if (error instanceof ServerClientError && error.status === 404) return null;
    throw error;
  }
}

export const getTask = taskStatus;

export async function listTasks(serverUrl: string, limit = 100): Promise<TaskListPage> {
  validateLimit(limit);
  const client = await clientFor(serverUrl);
  return runRequest(client.tasks.list({ query: { limit } }));
}

export async function taskEvents(
  serverUrl: string,
  taskId: string,
  afterSequence = 0,
  limit = 200,
): Promise<TaskEventPage> {
  validateCursor(afterSequence, "after");
  validateLimit(limit);
  const client = await clientFor(serverUrl);
  return runRequest(
    client.tasks.history({ params: { taskId }, query: { after: afterSequence, limit } }),
  );
}

export type EventScope = ApiEventScope;

export interface ServerEventListener extends AsyncIterable<ApiEventEnvelope> {
  close(): void;
}

export interface ServerEventListenerOptions extends EventScope {
  signal?: AbortSignal;
}

export async function openServerEventListener(
  serverUrl: string,
  options: ServerEventListenerOptions = {},
): Promise<ServerEventListener> {
  const scope = apiScope(options);
  const client = await clientFor(serverUrl);
  const stream = Stream.filterMap(
    Stream.map(
      await runRequest(client.events.subscribe({ query: scope })),
      decodeApiEventStreamValue,
    ),
    (value) => (value === undefined ? Result.fail(undefined) : Result.succeed(value)),
  );
  const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    void iterator.return?.(undefined).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const listener: ServerEventListener & AsyncIterator<ApiEventEnvelope> = {
    next: () => (closed ? Promise.resolve({ done: true, value: undefined }) : iterator.next()),
    return: async () => {
      stop();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return listener;
    },
    close: stop,
  };
  return listener;
}

export async function waitForServerEvent(
  serverUrl: string,
  scope: EventScope = {},
  timeoutMs = 30_000,
): Promise<ApiEventEnvelope | null> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
    throw new ServerClientError("timeoutMs is out of range", 400, "validation", "validation");
  const client = await clientFor(serverUrl);
  return runRequest(client.events.wait({ query: { ...apiScope(scope), timeoutMs } }));
}

export const waitForEvent = waitForServerEvent;
export const subscribeToServerEvents = openServerEventListener;

export interface FollowOptions {
  intervalMs?: number;
  afterSequence?: number;
  timeoutMs?: number;
  onEvent?: (event: TaskEvent) => void;
}

export async function followTask(
  serverUrl: string,
  taskId: string,
  options: FollowOptions = {},
): Promise<TaskResource> {
  const intervalMs = options.intervalMs ?? 100;
  let afterSequence = options.afterSequence ?? 0;
  const startedAt = Date.now();
  while (true) {
    const result = await taskStatus(serverUrl, taskId);
    if (!result) throw new ServerClientError(`task not found: ${taskId}`, 404);
    while (true) {
      const page = await taskEvents(serverUrl, taskId, afterSequence, 200);
      for (const event of page.events) {
        options.onEvent?.(event);
        afterSequence = event.sequence;
      }
      if (page.events.length < 200) break;
    }
    if (isTerminalState(result.state)) return result;
    const now = Date.now();
    const durableRemainingMs = result.deadlineEpochMs - now;
    const timeoutRemainingMs =
      options.timeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : options.timeoutMs - (now - startedAt);
    const remainingMs = Math.min(durableRemainingMs, timeoutRemainingMs);
    if (remainingMs <= 0)
      throw new ServerClientError(
        timeoutRemainingMs <= 0
          ? "task watch timed out"
          : "task follow reached its durable deadline",
        408,
      );
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }
}

function apiScope(scope: EventScope): ApiEventScope {
  if (scope.taskId !== undefined && scope.repositoryId !== undefined)
    throw new ServerClientError(
      "event scope must select a Task, Repository, or whole server",
      400,
      "validation",
      "validation",
    );
  return { taskId: scope.taskId, repositoryId: scope.repositoryId };
}

function clientError(error: unknown): ServerClientError {
  if (isApiError(error)) {
    const code = error.code ?? error.error;
    const message = error.message ?? "server request failed";
    if (code === "active_task_capacity") return new TaskCapacityError(message, 429, code);
    const status = statusForCode(code);
    return new ServerClientError(message, status, failureKindForStatus(status), code);
  }
  if (HttpClientError.isHttpClientError(error)) {
    const response = error.reason._tag === "StatusCodeError" ? error.reason.response : undefined;
    const status = response?.status ?? 0;
    return new ServerClientError(error.message, status, failureKindForStatus(status));
  }
  return new ServerClientError(
    error instanceof Error ? error.message : "server request failed",
    500,
  );
}

function isApiError(error: unknown): error is { code?: string; error?: string; message?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && typeof error.code === "string") ||
      ("error" in error && typeof error.error === "string")) &&
    (!("message" in error) || typeof error.message === "string")
  );
}

function statusForCode(code: string | undefined): number {
  switch (code) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "active_task_capacity":
      return 429;
    case "task_state_quarantined":
      return 503;
    default:
      return 500;
  }
}

function failureKindForStatus(status: number): ServerFailureKind {
  if (status === 400) return "validation";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 0) return "connection";
  return "server";
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new ServerClientError("limit is out of range", 400, "validation", "validation");
}

function validateCursor(cursor: number, name: string): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ServerClientError(
      `${name} must be a non-negative integer`,
      400,
      "validation",
      "validation",
    );
}
