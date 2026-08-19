import { Clock, Duration, Effect } from "effect";
import type { TaskResult } from "@usine/task-authority";
import { taskProgressFromResult, type TaskProgress } from "@usine/task-authority";

export interface TaskSubmission {
  contractPath: string;
  repositoryPath: string;
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
  return request<TaskResult>(serverUrl, "/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(submission),
  });
}

export async function taskStatus(serverUrl: string, taskId: string): Promise<TaskResult | null> {
  const response = await fetch(new URL(`/v1/tasks/${encodeURIComponent(taskId)}`, serverUrl));
  if (response.status === 404) return null;
  return readResponse<TaskResult>(response);
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
    if (result.state === "reviewed_pr" || result.state === "blocked") return result;
    const remainingMs = result.deadlineEpochMs - (await Effect.runPromise(Clock.currentTimeMillis));
    if (remainingMs <= 0)
      throw new ServerClientError("task follow reached its durable deadline", 408);
    await Effect.runPromise(Effect.sleep(Duration.millis(Math.min(intervalMs, remainingMs))));
  }
}

async function request<T>(serverUrl: string, path: string, init: RequestInit): Promise<T> {
  return readResponse<T>(await fetch(new URL(path, serverUrl), init));
}

async function readResponse<T>(response: Response): Promise<T> {
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
  return parsed as T;
}
