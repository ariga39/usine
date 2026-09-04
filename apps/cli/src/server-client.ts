import { Effect, Result, Schema, Stream } from "effect";
import { HttpClientError } from "effect/unstable/http";
import {
  decodeApiEventStreamValue,
  makeUsineApiClient,
  type ApiEventEnvelope,
  type ApiEventScope,
  type ApiTaskResource,
  type ApiTaskSubmission,
  type ApiCampaignPublication,
  type ApiCampaignProposalSubmission,
} from "@usine/runtime";
import {
  deriveUsageReportFromInvocations,
  MAX_USAGE_REPORT_PAGE_SIZE,
  type TaskEvent,
  type TaskEventPage,
  type TaskListPage,
  type TaskResource,
  type RepositoryResource,
  type RepositoryRegistration,
  type ServerHealth,
  type ServerSnapshot,
  isTerminalState,
  isWaitingState,
  type UsageReport,
  type UsageReportPage,
  type UsageReportScope,
  type CampaignResource,
} from "@usine/task-authority";
import { deriveTaskEvidence, type TaskEvidence } from "./task-evidence.js";

export type TaskSubmission = ApiTaskSubmission;
export type CampaignPublication = ApiCampaignPublication;
export type CampaignProposalSubmission = ApiCampaignProposalSubmission;

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

export class TaskRetryConflictError extends ServerClientError {
  readonly code = "task_retry_conflict";
  readonly retryable = false;

  constructor(
    message: string,
    status: number,
    readonly state: string,
  ) {
    super(message, status, "server", "task_retry_conflict");
    this.name = "TaskRetryConflictError";
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
  return normalizeTaskResource(await runRequest(client.tasks.submit({ payload: submission })));
}

export async function publishCampaign(
  serverUrl: string,
  publication: CampaignPublication,
): Promise<CampaignResource> {
  const client = await clientFor(serverUrl);
  const campaign = await runRequest(client.campaigns.publish({ payload: publication }));
  return campaign;
}

export async function getCampaign(
  serverUrl: string,
  campaignId: string,
): Promise<CampaignResource | null> {
  const client = await clientFor(serverUrl);
  try {
    const campaign = await runRequest(client.campaigns.get({ params: { campaignId } }));
    return campaign;
  } catch (error) {
    if (error instanceof ServerClientError && error.status === 404) return null;
    throw error;
  }
}

export async function proposeCampaign(
  serverUrl: string,
  campaignId: string,
  proposal: CampaignProposalSubmission,
): Promise<CampaignResource> {
  const client = await clientFor(serverUrl);
  return runRequest(client.campaigns.propose({ params: { campaignId }, payload: proposal }));
}

export async function retryTask(serverUrl: string, taskId: string): Promise<TaskResource> {
  const client = await clientFor(serverUrl);
  return normalizeTaskResource(await runRequest(client.tasks.retry({ params: { taskId } })));
}

export async function registerRepository(
  serverUrl: string,
  repository: RepositoryRegistration,
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
    return normalizeTaskResource(await runRequest(client.tasks.get({ params: { taskId } })));
  } catch (error) {
    if (error instanceof ServerClientError && error.status === 404) return null;
    throw error;
  }
}

export const getTask = taskStatus;

export async function listTasks(
  serverUrl: string,
  limit = 100,
  cursor: string | null = null,
): Promise<TaskListPage> {
  validateLimit(limit);
  const client = await clientFor(serverUrl);
  return runRequest(
    client.tasks.list({ query: { limit, ...(cursor === null ? {} : { cursor }) } }),
  );
}

export async function listAllTasks(serverUrl: string, limit = 100): Promise<TaskListPage> {
  const tasks: TaskListPage["tasks"][number][] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await listTasks(serverUrl, limit, cursor);
    tasks.push(...page.tasks);
    const nextCursor = page.nextCursor ?? null;
    if (nextCursor === null) return { tasks };
    if (nextCursor === cursor || seenCursors.has(nextCursor))
      throw new ServerClientError("task list cursor did not advance", 500);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export async function usageReport(
  serverUrl: string,
  scope: UsageReportScope,
): Promise<UsageReport> {
  const client = await clientFor(serverUrl);
  const scopeQuery = {
    ...(scope.taskId === null ? {} : { taskId: scope.taskId }),
    ...(scope.repositoryId === null ? {} : { repositoryId: scope.repositoryId }),
    ...(scope.fromEpochMs === null ? {} : { fromEpochMs: scope.fromEpochMs }),
    ...(scope.toEpochMs === null ? {} : { toEpochMs: scope.toEpochMs }),
  };
  const invocations: UsageReport["invocations"][number][] = [];
  let cursor: string | null = null;
  while (true) {
    const pageRequest = client.usage.report({
      query: {
        ...scopeQuery,
        limit: MAX_USAGE_REPORT_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
    });
    const page: UsageReportPage = await runRequest<UsageReportPage>(pageRequest);
    invocations.push(...page.invocations);
    if (page.nextCursor === null) break;
    if (page.nextCursor === cursor)
      throw new ServerClientError("usage report cursor did not advance", 500);
    cursor = page.nextCursor;
  }
  return deriveUsageReportFromInvocations(invocations, scope);
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

export async function taskEvidence(
  serverUrl: string,
  taskId: string,
  limit = 200,
): Promise<TaskEvidence | null> {
  const task = await taskStatus(serverUrl, taskId);
  if (!task) return null;
  const events: TaskEvent[] = [];
  let afterSequence = 0;
  while (true) {
    const page = await taskEvents(serverUrl, taskId, afterSequence, limit);
    events.push(...page.events);
    const highestEventSequence = page.events.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      afterSequence,
    );
    const nextSequence = Math.max(afterSequence, page.nextSequence, highestEventSequence);
    if (page.events.length === 0 || nextSequence <= afterSequence) break;
    afterSequence = nextSequence;
    if (page.events.length < limit) break;
  }
  const currentTask = await taskStatus(serverUrl, taskId);
  if (!currentTask) return null;
  return deriveTaskEvidence(currentTask, events);
}

export type EventScope = ApiEventScope;

export interface ServerEventListener extends AsyncIterable<ApiEventEnvelope> {
  close(): void;
}

export async function openServerEventListener(
  serverUrl: string,
  options: EventScope = {},
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
  const close = (): void => {
    void iterator.return?.().catch(() => undefined);
  };
  const listener: ServerEventListener = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    close,
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

export interface FollowOptions {
  intervalMs?: number;
  afterSequence?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    if (options.signal?.aborted) throw new Error("task follow cancelled");
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
    if (isTerminalState(result.state) || isWaitingState(result.state)) return result;
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
    await waitForFollowInterval(Math.min(intervalMs, remainingMs), options.signal);
  }
}

function waitForFollowInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, intervalMs));
  const activeSignal = signal;
  if (activeSignal.aborted) return Promise.reject(new Error("task follow cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, intervalMs);
    const abort = () => {
      clearTimeout(timer);
      activeSignal.removeEventListener("abort", abort);
      reject(new Error("task follow cancelled"));
    };
    function done() {
      activeSignal.removeEventListener("abort", abort);
      resolve();
    }
    activeSignal.addEventListener("abort", abort, { once: true });
  });
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
    if (code === "task_retry_conflict")
      return new TaskRetryConflictError(
        message,
        409,
        typeof error.state === "string" ? error.state : "blocked",
      );
    const status = statusForCode(code);
    return new ServerClientError(message, status, failureKindForStatus(status), code);
  }
  if (HttpClientError.isHttpClientError(error)) {
    const status = error.response?.status ?? 0;
    return new ServerClientError(error.message, status, failureKindForStatus(status));
  }
  if (Schema.isSchemaError(error)) {
    return new ServerClientError(error.message, 200, failureKindForStatus(200));
  }
  return new ServerClientError(
    error instanceof Error ? error.message : "server request failed",
    500,
  );
}

function normalizeTaskResource(resource: ApiTaskResource): TaskResource {
  return {
    ...resource,
    schemaVersion: 3,
    waiting: resource.waiting ?? null,
    retryable: resource.retryable ?? false,
  };
}

function isApiError(
  error: unknown,
): error is { code?: string; error?: string; message?: string; state?: unknown } {
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
    case "task_retry_conflict":
      return 409;
    case "campaign_content_conflict":
      return 409;
    case "campaign_proposal_conflict":
      return 409;
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
