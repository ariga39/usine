import { Clock, Duration, Effect } from "effect";
import {
  decodeTaskResource,
  decodeTaskEventPage,
  decodeTaskListPage,
  decodeServerHealth,
  decodeServerSnapshot,
  type TaskEvent,
  type TaskEventPage,
  type TaskListPage,
  type TaskResource,
  repositoryResourceSchema,
  type RepositoryResource,
  type RepositorySnapshot,
  type ServerHealth,
  type ServerSnapshot,
  isTerminalState,
} from "@usine/task-authority";

export interface TaskSubmission {
  contractPath: string;
  repositoryId?: string;
}

export function serverUrlFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.USINE_SERVER_URL?.trim();
  if (explicit) return explicit;
  const host = environment.USINE_SERVER_HOST?.trim() || "127.0.0.1";
  const port = environment.USINE_SERVER_PORT?.trim() || "8787";
  const urlHost = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  return "http://" + urlHost + ":" + port;
}

export async function serverHealth(serverUrl: string): Promise<ServerHealth> {
  const response = await fetchServer(new URL("/v1/health", serverUrl));
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "server health failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(body),
    );
  try {
    return decodeServerHealth(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid ServerHealth (${response.status})`,
      response.status,
    );
  }
}

export async function serverSnapshot(serverUrl: string, limit = 100): Promise<ServerSnapshot> {
  validateLimit(limit);
  const response = await fetchServer(new URL(`/v1/snapshot?limit=${limit}`, serverUrl));
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "server snapshot failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(body),
    );
  try {
    return decodeServerSnapshot(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid ServerSnapshot (${response.status})`,
      response.status,
    );
  }
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

export async function submitTask(
  serverUrl: string,
  submission: TaskSubmission,
): Promise<TaskResource> {
  return requestTask(serverUrl, "/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
}

export async function registerRepository(
  serverUrl: string,
  repository: RepositorySnapshot,
): Promise<RepositoryResource> {
  const response = await fetchServer(new URL("/v1/repositories", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(repository),
  });
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "repository registration failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(body),
    );
  try {
    return repositoryResourceSchema.parse(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid RepositoryResource (${response.status})`,
      response.status,
    );
  }
}

export async function inspectRepository(
  serverUrl: string,
  repositoryId: string,
): Promise<RepositoryResource | null> {
  const response = await fetchServer(
    new URL(`/v1/repositories/${encodeURIComponent(repositoryId)}`, serverUrl),
  );
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "repository inspection failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(body),
    );
  try {
    return repositoryResourceSchema.parse(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid RepositoryResource (${response.status})`,
      response.status,
    );
  }
}

export async function listRepositories(
  serverUrl: string,
  limit = 100,
): Promise<{ repositories: RepositoryResource[] }> {
  validateLimit(limit);
  const response = await fetchServer(new URL(`/v1/repositories?limit=${limit}`, serverUrl));
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "repository list failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(body),
    );
  try {
    if (
      typeof body !== "object" ||
      body === null ||
      !("repositories" in body) ||
      !Array.isArray(body.repositories)
    )
      throw new Error("invalid repository list");
    return {
      repositories: body.repositories.map((repository) =>
        repositoryResourceSchema.parse(repository),
      ),
    };
  } catch {
    throw new ServerClientError(
      `server returned invalid RepositoryList (${response.status})`,
      response.status,
    );
  }
}

export async function taskStatus(serverUrl: string, taskId: string): Promise<TaskResource | null> {
  const response = await fetchServer(new URL(`/v1/tasks/${encodeURIComponent(taskId)}`, serverUrl));
  if (response.status === 404) return null;
  return readTaskResponse(response);
}

export async function listTasks(serverUrl: string, limit = 100): Promise<TaskListPage> {
  validateLimit(limit);
  const response = await fetchServer(new URL(`/v1/tasks?limit=${limit}`, serverUrl));
  const parsed = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(parsed, "task list failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(parsed),
    );
  try {
    return decodeTaskListPage(parsed);
  } catch {
    throw new ServerClientError(
      `server returned invalid TaskListPage (${response.status})`,
      response.status,
    );
  }
}

export const getTask = taskStatus;

export async function taskEvents(
  serverUrl: string,
  taskId: string,
  afterSequence = 0,
  limit = 200,
): Promise<TaskEventPage> {
  validateCursor(afterSequence, "after");
  validateLimit(limit);
  const path = `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${afterSequence}&limit=${limit}`;
  const response = await fetchServer(new URL(path, serverUrl));
  const parsed = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(parsed, "task events request failed"),
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(parsed),
    );
  try {
    return decodeTaskEventPage(parsed);
  } catch {
    throw new ServerClientError(
      "server returned invalid TaskEventPage (" + response.status + ")",
      response.status,
    );
  }
}

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
  const startedAt = await Effect.runPromise(Clock.currentTimeMillis);
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
    const now = await Effect.runPromise(Clock.currentTimeMillis);
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
    await Effect.runPromise(Effect.sleep(Duration.millis(Math.min(intervalMs, remainingMs))));
  }
}

async function requestTask(
  serverUrl: string,
  path: string,
  init: RequestInit,
): Promise<TaskResource> {
  return readTaskResponse(await fetchServer(new URL(path, serverUrl), init));
}

async function readTaskResponse(response: Response): Promise<TaskResource> {
  const parsed = await readJson(response);
  if (!response.ok) {
    if (isTaskCapacityResponse(parsed))
      throw new TaskCapacityError(parsed.message, response.status);
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String(parsed.message)
        : `server request failed (${response.status})`;
    throw new ServerClientError(
      message,
      response.status,
      failureKindForStatus(response.status),
      responseDiagnostic(parsed),
    );
  }
  try {
    return decodeTaskResource(parsed);
  } catch {
    throw new ServerClientError(
      "server returned invalid TaskResource (" + response.status + ")",
      response.status,
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ServerClientError(
      `server returned invalid JSON (${response.status})`,
      response.status,
    );
  }
}

function responseMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body !== null && "message" in body
    ? String(body.message)
    : fallback;
}

function responseDiagnostic(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if ("error" in body) return String(body.error);
  if ("code" in body) return String(body.code);
  return undefined;
}

function isTaskCapacityResponse(
  body: unknown,
): body is { code: "active_task_capacity"; message: string; retryable: true } {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    body.code === "active_task_capacity" &&
    "retryable" in body &&
    body.retryable === true &&
    "message" in body &&
    typeof body.message === "string"
  );
}

async function fetchServer(input: URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ServerClientError("server connection failed", 0, "connection");
  }
}

function failureKindForStatus(status: number): ServerFailureKind {
  if (status === 0) return "connection";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  return "validation";
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new ServerClientError("limit is out of range", 400, "validation", "validation");
}

function validateCursor(cursor: number, name: string): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ServerClientError(`${name} is out of range`, 400, "validation", "validation");
}
