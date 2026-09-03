import { and, asc, gte, inArray, lt, sql } from "drizzle-orm";
import { taskEvents, taskRuns } from "./schema.js";
import { decodeRawPersistedTaskResult } from "./task-state-schema.js";
import { decodeTaskEvent, type TaskEvent } from "./task-event.js";
import type { TaskResult } from "./task-state.js";
import { Schema } from "effect";
import type { RuntimeDatabase } from "./sqlite-database.js";

export const MAX_USAGE_REPORT_PAGE_SIZE = 200;
const MAX_USAGE_REPORT_CURSOR_LENGTH = 4096;
const USAGE_DIMENSION_UNAVAILABLE = "unavailable" as const;

export type UsageDimension = string;
export type UsageCoverage = "complete" | "partial" | "unavailable";
export type UsageOutcome = "succeeded" | "failed" | "cancelled" | "blocked" | "unknown";

export interface UsageAmounts {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly coverage: UsageCoverage;
}

export interface UsageReportScope {
  readonly taskId: string | null;
  readonly repositoryId: string | null;
  /** Inclusive lower bound. */
  readonly fromEpochMs: number | null;
  /** Exclusive upper bound. */
  readonly toEpochMs: number | null;
}

export interface UsageInvocation {
  readonly invocationId: string;
  readonly taskId: string;
  readonly pullRequest: number | null;
  readonly repositoryId: UsageDimension;
  readonly repository: UsageDimension;
  readonly role: "implementer" | "reviewer";
  readonly activation: number | null;
  readonly reviewCycle: number | null;
  readonly profile: UsageDimension;
  readonly configuredModel: UsageDimension;
  readonly configuredProvider: UsageDimension;
  readonly provider: UsageDimension;
  readonly adapter: UsageDimension;
  readonly model: UsageDimension;
  readonly serviceTier: UsageDimension;
  readonly reasoningEffort: UsageDimension;
  readonly outcome: UsageOutcome;
  readonly occurredAtEpochMs: number;
  readonly elapsedMs: number | null;
  readonly usage: UsageAmounts;
}

export interface UsageAggregate {
  readonly taskId: string;
  readonly pullRequest: number | null;
  readonly repositoryId: UsageDimension;
  readonly repository: UsageDimension;
  readonly role: "implementer" | "reviewer";
  readonly profile: UsageDimension;
  readonly configuredModel: UsageDimension;
  readonly configuredProvider: UsageDimension;
  readonly provider: UsageDimension;
  readonly adapter: UsageDimension;
  readonly model: UsageDimension;
  readonly serviceTier: UsageDimension;
  readonly reasoningEffort: UsageDimension;
  readonly outcome: UsageOutcome;
  readonly invocations: number;
  readonly usage: UsageAmounts;
}

export interface UsageReport {
  readonly schemaVersion: 1;
  readonly scope: UsageReportScope;
  readonly coverage: UsageCoverage;
  readonly invocations: readonly UsageInvocation[];
  readonly aggregates: readonly UsageAggregate[];
}

export interface UsageReportPage {
  readonly schemaVersion: 1;
  readonly scope: UsageReportScope;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly coverage: UsageCoverage;
  readonly invocations: readonly UsageInvocation[];
  readonly aggregates: readonly UsageAggregate[];
}

export interface UsageReportPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

const usageAmountsSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Natural),
  cachedInputTokens: Schema.NullOr(Schema.Natural),
  uncachedInputTokens: Schema.NullOr(Schema.Natural),
  cacheWriteInputTokens: Schema.NullOr(Schema.Natural),
  outputTokens: Schema.NullOr(Schema.Natural),
  reasoningOutputTokens: Schema.NullOr(Schema.Natural),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
});
const usageScopeSchema = Schema.Struct({
  taskId: Schema.NullOr(Schema.String),
  repositoryId: Schema.NullOr(Schema.String),
  fromEpochMs: Schema.NullOr(Schema.Int),
  toEpochMs: Schema.NullOr(Schema.Int),
});
const usageInvocationSchema = Schema.Struct({
  invocationId: Schema.String,
  taskId: Schema.String,
  pullRequest: Schema.NullOr(Schema.Natural),
  repositoryId: Schema.String,
  repository: Schema.String,
  role: Schema.Literals(["implementer", "reviewer"]),
  activation: Schema.NullOr(Schema.Natural),
  reviewCycle: Schema.NullOr(Schema.Natural),
  profile: Schema.String,
  configuredModel: Schema.String,
  configuredProvider: Schema.String,
  provider: Schema.String,
  adapter: Schema.String,
  model: Schema.String,
  serviceTier: Schema.String,
  reasoningEffort: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled", "blocked", "unknown"]),
  occurredAtEpochMs: Schema.Int,
  elapsedMs: Schema.NullOr(Schema.Natural),
  usage: usageAmountsSchema,
});
const usageAggregateSchema = Schema.Struct({
  taskId: Schema.String,
  pullRequest: Schema.NullOr(Schema.Natural),
  repositoryId: Schema.String,
  repository: Schema.String,
  role: Schema.Literals(["implementer", "reviewer"]),
  profile: Schema.String,
  configuredModel: Schema.String,
  configuredProvider: Schema.String,
  provider: Schema.String,
  adapter: Schema.String,
  model: Schema.String,
  serviceTier: Schema.String,
  reasoningEffort: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled", "blocked", "unknown"]),
  invocations: Schema.Natural,
  usage: usageAmountsSchema,
});
export const usageReportPageSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scope: usageScopeSchema,
  cursor: Schema.NullOr(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
  invocations: Schema.Array(usageInvocationSchema),
  aggregates: Schema.Array(usageAggregateSchema),
});

export interface UsageReportSource {
  readonly task: TaskResult;
  readonly events: readonly TaskEvent[];
}

export interface UsageReportSourcesPage {
  readonly sources: readonly UsageReportSource[];
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export class UsageReportCursorError extends Error {
  constructor() {
    super("usage report cursor is invalid");
    this.name = "UsageReportCursorError";
  }
}

type CompletedSession = Extract<TaskEvent["data"], { type: "coding_session_completed" }>;
type StartedSession = Extract<TaskEvent["data"], { type: "coding_session_started" }>;
type InterruptedSession = Extract<TaskEvent["data"], { type: "coding_session_interrupted" }>;
type UsageObserved = Extract<TaskEvent["data"], { type: "coding_usage_observed" }>;
type SessionUsage = NonNullable<CompletedSession["usage"]>;

const usageCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: usageScopeSchema,
  upperTaskId: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  ),
  afterTaskId: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),
  ),
});
type UsageReportCursor = Schema.Schema.Type<typeof usageCursorSchema>;

interface MutableInvocation {
  readonly invocationId: string;
  readonly taskId: string;
  readonly role: "implementer" | "reviewer";
  readonly activation: number;
  readonly reviewCycle: number | null;
  readonly startedAtEpochMs: number;
  requestedProfile: string | null;
  session: CompletedSession | null;
  interrupted: InterruptedSession | null;
  providerUsage: SessionUsage | null;
  actualModel: string | null;
  actualModelProvider: string | null;
  normalizerActualModel: string | null;
  normalizerActualModelProvider: string | null;
  normalizerUsage: SessionUsage | null;
  normalizerAttempted: boolean;
  normalizerStatus: UsageOutcome | null;
  normalizer: CompletedSession["normalizer"];
  completedAtEpochMs: number | null;
}

export function deriveUsageReport(
  sources: readonly UsageReportSource[],
  scope: UsageReportScope,
): UsageReport {
  const invocations = sources.flatMap((source) => invocationsForSource(source));
  return deriveUsageReportFromInvocations(invocations, scope);
}

export function deriveUsageReportFromInvocations(
  invocations: readonly UsageInvocation[],
  scope: UsageReportScope,
): UsageReport {
  const selected = invocations.filter((invocation) => inScope(invocation, scope));
  selected.sort(
    (left, right) =>
      compareTaskIds(left.taskId, right.taskId) ||
      left.occurredAtEpochMs - right.occurredAtEpochMs ||
      compareTaskIds(left.invocationId, right.invocationId),
  );
  const aggregates = aggregateInvocations(selected);
  return {
    schemaVersion: 1,
    scope,
    coverage: reportCoverage(selected),
    invocations: selected,
    aggregates,
  };
}

export async function listUsageReportSources(
  database: RuntimeDatabase,
  scope: UsageReportScope,
  request: UsageReportPageRequest = { cursor: null, limit: MAX_USAGE_REPORT_PAGE_SIZE },
): Promise<UsageReportSourcesPage> {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_USAGE_REPORT_PAGE_SIZE
  )
    throw new RangeError("usage report page limit is out of range");
  const cursor = request.cursor === null ? null : decodeUsageReportCursor(request.cursor, scope);
  const tasks = new Map<string, TaskResult>();
  const taskRows = await database
    .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
    .from(taskRuns)
    .orderBy(asc(taskRuns.taskId));
  for (const row of taskRows) {
    const task = decodeRawPersistedTaskResult(row.rawResult);
    if (scope.taskId === null || scope.taskId === task.taskId) tasks.set(task.taskId, task);
  }
  const hasTimeBound = scope.fromEpochMs !== null || scope.toEpochMs !== null;
  let taskIds: string[];
  if (scope.taskId !== null) {
    taskIds = tasks.has(scope.taskId) ? [scope.taskId] : [];
  } else if (!hasTimeBound) {
    taskIds = [...tasks.values()]
      .filter((task) => repositoryMatches(task, scope.repositoryId))
      .map((task) => task.taskId)
      .toSorted();
  } else {
    const timeConditions = [
      ...(scope.fromEpochMs === null ? [] : [gte(taskEvents.occurredAtEpochMs, scope.fromEpochMs)]),
      ...(scope.toEpochMs === null ? [] : [lt(taskEvents.occurredAtEpochMs, scope.toEpochMs)]),
    ];
    const selectedTaskIds = await database
      .select({ taskId: taskEvents.taskId })
      .from(taskEvents)
      .where(and(...timeConditions))
      .groupBy(taskEvents.taskId)
      .orderBy(asc(taskEvents.taskId));
    taskIds = selectedTaskIds
      .map((row) => row.taskId)
      .filter((taskId) => {
        const task = tasks.get(taskId);
        return task !== undefined && repositoryMatches(task, scope.repositoryId);
      });
  }
  taskIds = taskIds.toSorted(compareTaskIds);
  const upperTaskId = cursor?.upperTaskId ?? taskIds.at(-1) ?? null;
  const afterTaskId = cursor?.afterTaskId ?? null;
  const pageTaskIds = taskIds
    .filter(
      (taskId) =>
        (afterTaskId === null || compareTaskIds(taskId, afterTaskId) > 0) &&
        (upperTaskId === null || compareTaskIds(taskId, upperTaskId) <= 0),
    )
    .slice(0, request.limit);
  if (pageTaskIds.length === 0) return { cursor: request.cursor, nextCursor: null, sources: [] };
  const rows = await database
    .select()
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, pageTaskIds))
    .orderBy(asc(taskEvents.taskId), asc(taskEvents.sequence));
  const grouped = new Map<string, TaskEvent[]>();
  for (const row of rows) {
    const task = tasks.get(row.taskId);
    if (!task || !repositoryMatches(task, scope.repositoryId)) continue;
    const event = decodeTaskEventRow(row);
    const events = grouped.get(row.taskId) ?? [];
    events.push(event);
    grouped.set(row.taskId, events);
  }
  const lastTaskId = pageTaskIds.at(-1)!;
  const hasNext = taskIds.some(
    (taskId) =>
      compareTaskIds(taskId, lastTaskId) > 0 &&
      (upperTaskId === null || compareTaskIds(taskId, upperTaskId) <= 0),
  );
  return {
    cursor: request.cursor,
    nextCursor: hasNext
      ? encodeUsageReportCursor({
          version: 1,
          scope,
          upperTaskId,
          afterTaskId: lastTaskId,
        })
      : null,
    sources: [...grouped.entries()]
      .toSorted(([left], [right]) => compareTaskIds(left, right))
      .map(([taskId, events]) => ({ task: tasks.get(taskId)!, events })),
  };
}

function compareTaskIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeUsageReportCursor(cursor: UsageReportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeUsageReportCursor(value: string, scope: UsageReportScope): UsageReportCursor {
  try {
    if (value.length > MAX_USAGE_REPORT_CURSOR_LENGTH || value.length === 0)
      throw new Error("cursor is out of bounds");
    const decoded = Schema.decodeUnknownSync(usageCursorSchema, { onExcessProperty: "error" })(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (JSON.stringify(decoded.scope) !== JSON.stringify(scope)) throw new Error("scope mismatch");
    if (decoded.upperTaskId === null || decoded.afterTaskId === null)
      throw new Error("cursor bounds are missing");
    if (compareTaskIds(decoded.afterTaskId, decoded.upperTaskId) > 0)
      throw new Error("cursor is beyond its upper bound");
    return decoded;
  } catch {
    throw new UsageReportCursorError();
  }
}

function invocationsForSource(source: UsageReportSource): UsageInvocation[] {
  const events = [
    ...new Map(source.events.map((event) => [event.eventId, event])).values(),
  ].toSorted((left, right) => left.sequence - right.sequence);
  const runs = new Map<string, MutableInvocation>();
  for (const event of events) {
    const data = event.data;
    if ("role" in data && data.role === "coordinator") continue;
    if (data.type === "coding_session_started") {
      const run = getOrCreateRun(runs, source.task.taskId, event, data);
      run.requestedProfile = data.requestedProfile ?? run.requestedProfile;
    } else if (data.type === "coding_usage_observed") {
      const run = getOrCreateRun(runs, source.task.taskId, event, data);
      if (data.actualModel && data.source === "provider") {
        run.actualModel = data.actualModel.model;
        run.actualModelProvider = data.actualModel.provider;
      }
      if (data.actualModel && data.source === "role_output_normalizer") {
        run.normalizerActualModel = data.actualModel.model;
        run.normalizerActualModelProvider = data.actualModel.provider;
      }
      if (data.source === "provider")
        run.providerUsage =
          data.semantics === "replacement" ? data.usage : addUsage(run.providerUsage, data.usage);
      else {
        run.normalizerAttempted = true;
        run.normalizerUsage =
          data.semantics === "replacement" ? data.usage : addUsage(run.normalizerUsage, data.usage);
        run.normalizerStatus ??= "unknown";
      }
    } else if (data.type === "coding_session_interrupted") {
      const run = getOrCreateRun(runs, source.task.taskId, event, data);
      run.interrupted = data;
      run.completedAtEpochMs ??= event.occurredAtEpochMs;
      run.normalizerStatus = run.normalizerStatus ?? null;
    } else if (data.type === "coding_session_completed") {
      const run = getOrCreateRun(runs, source.task.taskId, event, data);
      run.session = data;
      run.completedAtEpochMs = event.occurredAtEpochMs;
      if (data.usage !== undefined) run.providerUsage = data.usage;
      if (data.effectiveProfile?.actualModel) run.actualModel = data.effectiveProfile.actualModel;
      if (data.effectiveProfile?.actualModelProvider)
        run.actualModelProvider = data.effectiveProfile.actualModelProvider;
      if (data.normalizer) {
        run.normalizerAttempted = true;
        run.normalizer = data.normalizer;
        run.normalizerStatus = data.normalizer.status;
        if (data.normalizer.actualModel) run.normalizerActualModel = data.normalizer.actualModel;
        if (data.normalizer.actualModelProvider)
          run.normalizerActualModelProvider = data.normalizer.actualModelProvider;
        if (data.normalizer.usage !== null) run.normalizerUsage = data.normalizer.usage;
      }
    }
  }
  return [...runs.values()].flatMap((run) => {
    const main = invocationFromRun(source.task, run, false);
    const normalizer = run.normalizerAttempted ? invocationFromRun(source.task, run, true) : null;
    return normalizer ? [main, normalizer] : [main];
  });
}

function getOrCreateRun(
  runs: Map<string, MutableInvocation>,
  taskId: string,
  event: TaskEvent,
  data: StartedSession | UsageObserved | InterruptedSession | CompletedSession,
): MutableInvocation {
  const key = `${data.role}:${data.activation}:${data.sessionId}`;
  const existing = runs.get(key);
  if (existing) return existing;
  if (data.role === "coordinator")
    throw new Error("coordinator usage is outside the factory report");
  const run: MutableInvocation = {
    invocationId: `${taskId}:${data.role}:${data.activation}:${data.sessionId}`,
    taskId,
    role: data.role,
    activation: data.activation,
    reviewCycle: "reviewCycle" in data ? (data.reviewCycle ?? null) : null,
    startedAtEpochMs: event.occurredAtEpochMs,
    requestedProfile: "requestedProfile" in data ? (data.requestedProfile ?? null) : null,
    session: null,
    interrupted: null,
    providerUsage: null,
    actualModel: null,
    actualModelProvider: null,
    normalizerActualModel: null,
    normalizerActualModelProvider: null,
    normalizerUsage: null,
    normalizerAttempted: false,
    normalizerStatus: null,
    normalizer: undefined,
    completedAtEpochMs: null,
  };
  runs.set(key, run);
  return run;
}

function invocationFromRun(
  task: TaskResult,
  run: MutableInvocation,
  normalizer: boolean,
): UsageInvocation {
  const session = run.session;
  const effective = session?.effectiveProfile;
  const usage = normalizer
    ? (run.normalizer?.usage ?? run.normalizerUsage)
    : (session?.usage ?? run.providerUsage);
  const outcome: UsageOutcome = normalizer
    ? (run.normalizer?.status ?? run.normalizerStatus ?? "unknown")
    : (session?.outcome ??
      (run.interrupted?.failureClass === "cancellation"
        ? "cancelled"
        : run.interrupted
          ? "failed"
          : "unknown"));
  const repository = task.repository;
  const elapsedMs =
    run.completedAtEpochMs === null
      ? null
      : Math.max(0, run.completedAtEpochMs - run.startedAtEpochMs);
  return {
    invocationId: normalizer ? `${run.invocationId}:role-output-normalizer` : run.invocationId,
    taskId: task.taskId,
    pullRequest: task.delivery?.prNumber ?? null,
    repositoryId: repository?.id ?? USAGE_DIMENSION_UNAVAILABLE,
    repository: repository ? `${repository.owner}/${repository.name}` : USAGE_DIMENSION_UNAVAILABLE,
    role: run.role,
    activation: run.activation,
    reviewCycle: run.reviewCycle,
    profile: normalizer
      ? USAGE_DIMENSION_UNAVAILABLE
      : (effective?.profileName ?? run.requestedProfile ?? USAGE_DIMENSION_UNAVAILABLE),
    configuredModel: normalizer
      ? (run.normalizer?.model ?? USAGE_DIMENSION_UNAVAILABLE)
      : (effective?.model ?? USAGE_DIMENSION_UNAVAILABLE),
    configuredProvider: normalizer
      ? (run.normalizer?.modelProvider ?? USAGE_DIMENSION_UNAVAILABLE)
      : (effective?.modelProvider ?? USAGE_DIMENSION_UNAVAILABLE),
    provider: normalizer
      ? (run.normalizerActualModelProvider ?? USAGE_DIMENSION_UNAVAILABLE)
      : (run.actualModelProvider ?? USAGE_DIMENSION_UNAVAILABLE),
    adapter: normalizer
      ? (run.normalizer?.adapter ?? "role-output-normalizer")
      : (effective?.adapter ?? USAGE_DIMENSION_UNAVAILABLE),
    model: normalizer
      ? (run.normalizerActualModel ?? USAGE_DIMENSION_UNAVAILABLE)
      : (effective?.actualModel ?? run.actualModel ?? USAGE_DIMENSION_UNAVAILABLE),
    serviceTier: normalizer
      ? USAGE_DIMENSION_UNAVAILABLE
      : (effective?.serviceTier ?? USAGE_DIMENSION_UNAVAILABLE),
    reasoningEffort: normalizer
      ? USAGE_DIMENSION_UNAVAILABLE
      : (effective?.reasoningEffort ?? USAGE_DIMENSION_UNAVAILABLE),
    outcome: outcome === "succeeded" ? "succeeded" : outcome,
    occurredAtEpochMs: run.completedAtEpochMs ?? run.startedAtEpochMs,
    elapsedMs,
    usage: usageAmounts(usage),
  };
}

function usageAmounts(usage: SessionUsage | null): UsageAmounts {
  const values = {
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    uncachedInputTokens: usage?.uncachedInputTokens,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens,
    outputTokens: usage?.outputTokens,
    reasoningOutputTokens: usage?.reasoningOutputTokens,
  };
  const required = [
    values.inputTokens,
    values.cachedInputTokens,
    values.uncachedInputTokens,
    values.outputTokens,
  ];
  const known = required.filter((value) => value !== undefined).length;
  return {
    inputTokens: values.inputTokens ?? null,
    cachedInputTokens: values.cachedInputTokens ?? null,
    uncachedInputTokens: values.uncachedInputTokens ?? null,
    cacheWriteInputTokens: values.cacheWriteInputTokens ?? null,
    outputTokens: values.outputTokens ?? null,
    reasoningOutputTokens: values.reasoningOutputTokens ?? null,
    coverage: usage === null || known === 0 ? "unavailable" : known === 4 ? "complete" : "partial",
  };
}

function aggregateInvocations(rows: readonly UsageInvocation[]): UsageAggregate[] {
  const grouped = new Map<string, UsageInvocation[]>();
  for (const row of rows) {
    const key = [
      row.taskId,
      row.pullRequest ?? "none",
      row.repositoryId,
      row.repository,
      row.role,
      row.profile,
      row.configuredModel,
      row.configuredProvider,
      row.provider,
      row.adapter,
      row.model,
      row.serviceTier,
      row.reasoningEffort,
      row.outcome,
    ].join("\u0000");
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((group) => {
      const first = group[0]!;
      return {
        taskId: first.taskId,
        pullRequest: first.pullRequest,
        repositoryId: first.repositoryId,
        repository: first.repository,
        role: first.role,
        profile: first.profile,
        configuredModel: first.configuredModel,
        configuredProvider: first.configuredProvider,
        provider: first.provider,
        adapter: first.adapter,
        model: first.model,
        serviceTier: first.serviceTier,
        reasoningEffort: first.reasoningEffort,
        outcome: first.outcome,
        invocations: group.length,
        usage: aggregateUsage(group.map((row) => row.usage)),
      } satisfies UsageAggregate;
    })
    .toSorted((left, right) => compareTaskIds(aggregateKey(left), aggregateKey(right)));
}

function aggregateUsage(values: readonly UsageAmounts[]): UsageAmounts {
  const sum = (selector: (value: UsageAmounts) => number | null): number | null => {
    const selected = values.map(selector);
    return selected.some((value) => value === null)
      ? null
      : selected.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  const coverage = values.every((value) => value.coverage === "complete")
    ? "complete"
    : values.every((value) => value.coverage === "unavailable")
      ? "unavailable"
      : "partial";
  return {
    inputTokens: sum((value) => value.inputTokens),
    cachedInputTokens: sum((value) => value.cachedInputTokens),
    uncachedInputTokens: sum((value) => value.uncachedInputTokens),
    cacheWriteInputTokens: sum((value) => value.cacheWriteInputTokens),
    outputTokens: sum((value) => value.outputTokens),
    reasoningOutputTokens: sum((value) => value.reasoningOutputTokens),
    coverage,
  };
}

function addUsage(left: SessionUsage | null, right: SessionUsage): SessionUsage {
  if (left === null) return right;

  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined ? undefined : a + b;
  return {
    inputTokens: add(left?.inputTokens, right.inputTokens),
    cachedInputTokens: add(left?.cachedInputTokens, right.cachedInputTokens),
    uncachedInputTokens: add(left?.uncachedInputTokens, right.uncachedInputTokens),
    cacheWriteInputTokens: add(left?.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: add(left?.outputTokens, right.outputTokens),
    reasoningOutputTokens: add(left?.reasoningOutputTokens, right.reasoningOutputTokens),
  };
}

function reportCoverage(selected: readonly UsageInvocation[]): UsageCoverage {
  if (selected.length === 0) return "complete";
  if (selected.every((row) => row.usage.coverage === "complete")) return "complete";
  if (selected.every((row) => row.usage.coverage === "unavailable")) return "unavailable";
  return "partial";
}

function inScope(row: UsageInvocation, scope: UsageReportScope): boolean {
  return (
    (scope.taskId === null || row.taskId === scope.taskId) &&
    (scope.repositoryId === null || row.repositoryId === scope.repositoryId) &&
    (scope.fromEpochMs === null || row.occurredAtEpochMs >= scope.fromEpochMs) &&
    (scope.toEpochMs === null || row.occurredAtEpochMs < scope.toEpochMs)
  );
}

function repositoryMatches(task: TaskResult, repositoryId: string | null): boolean {
  return repositoryId === null || task.repository?.id === repositoryId;
}

function decodeTaskEventRow(row: typeof taskEvents.$inferSelect): TaskEvent {
  return decodeTaskEvent({
    taskId: row.taskId,
    sequence: row.sequence,
    eventId: row.eventId,
    occurredAtEpochMs: row.occurredAtEpochMs,
    data: row.data,
  });
}

function aggregateKey(value: UsageAggregate): string {
  return [
    value.taskId,
    value.pullRequest ?? "none",
    value.repositoryId,
    value.repository,
    value.role,
    value.profile,
    value.configuredModel,
    value.configuredProvider,
    value.provider,
    value.adapter,
    value.model,
    value.serviceTier,
    value.reasoningEffort,
    value.outcome,
  ].join("\u0000");
}
