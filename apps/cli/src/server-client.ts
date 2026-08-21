import { Clock, Duration, Effect } from "effect";
import {
  decodeCurrentTaskResult,
  decodeCurrentTaskStatus,
  taskProgressFromResult,
  type TaskProgress,
  type TaskResult,
  type TaskStatus,
  repositoryRegistrationSchema,
  type RepositorySnapshot,
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

export class ServerClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServerClientError";
  }
}

export async function submitTask(
  serverUrl: string,
  submission: TaskSubmission,
): Promise<TaskResult> {
  return request(serverUrl, "/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
}

export async function registerRepository(
  serverUrl: string,
  repository: RepositorySnapshot,
): Promise<RepositorySnapshot> {
  const response = await fetch(new URL("/v1/repositories", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(repository),
  });
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "repository registration failed"),
      response.status,
    );
  try {
    return repositoryRegistrationSchema.parse(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid Repository (${response.status})`,
      response.status,
    );
  }
}

export async function inspectRepository(
  serverUrl: string,
  repositoryId: string,
): Promise<RepositorySnapshot | null> {
  const response = await fetch(
    new URL(`/v1/repositories/${encodeURIComponent(repositoryId)}`, serverUrl),
  );
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok)
    throw new ServerClientError(
      responseMessage(body, "repository inspection failed"),
      response.status,
    );
  try {
    return repositoryRegistrationSchema.parse(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid Repository (${response.status})`,
      response.status,
    );
  }
}

export async function taskStatus(serverUrl: string, taskId: string): Promise<TaskStatus | null> {
  const response = await fetch(new URL(`/v1/tasks/${encodeURIComponent(taskId)}`, serverUrl));
  if (response.status === 404) return null;
  return readStatusResponse(response);
}

export interface FollowOptions {
  intervalMs?: number;
  onProgress?: (progress: TaskProgress) => void;
}

export async function followTask(
  serverUrl: string,
  taskId: string,
  options: FollowOptions = {},
): Promise<TaskResult> {
  const intervalMs = options.intervalMs ?? 100;
  let lastRevision = -1;
  while (true) {
    const result = await taskStatus(serverUrl, taskId);
    if (!result) throw new ServerClientError(`task not found: ${taskId}`, 404);
    if (result.revision > lastRevision) {
      lastRevision = result.revision;
      options.onProgress?.(taskProgressFromResult(result));
    }
    if (isTerminalState(result.state)) return result;
    const remainingMs = result.deadlineEpochMs - (await Effect.runPromise(Clock.currentTimeMillis));
    if (remainingMs <= 0)
      throw new ServerClientError("task follow reached its durable deadline", 408);
    await Effect.runPromise(Effect.sleep(Duration.millis(Math.min(intervalMs, remainingMs))));
  }
}

async function request(serverUrl: string, path: string, init: RequestInit): Promise<TaskResult> {
  return readResponse(await fetch(new URL(path, serverUrl), init));
}

async function readResponse(response: Response): Promise<TaskResult> {
  const parsed = await readJson(response);
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String(parsed.message)
        : `server request failed (${response.status})`;
    throw new ServerClientError(message, response.status);
  }
  try {
    return decodeCurrentTaskResult(parsed);
  } catch {
    throw new ServerClientError(
      "server returned invalid TaskResult (" + response.status + ")",
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

async function readStatusResponse(response: Response): Promise<TaskStatus> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ServerClientError(
      `server returned invalid JSON (${response.status})`,
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String(parsed.message)
        : `server request failed (${response.status})`;
    throw new ServerClientError(message, response.status);
  }
  try {
    return decodeCurrentTaskStatus(parsed);
  } catch {
    throw new ServerClientError(
      "server returned invalid TaskStatus (" + response.status + ")",
      response.status,
    );
  }
}
