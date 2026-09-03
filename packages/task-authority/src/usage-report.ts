import { and, asc, gte, inArray, lt, sql } from "drizzle-orm";
import { taskEvents, taskRuns } from "./schema.js";
import { decodeRawPersistedTaskResult } from "./task-state-schema.js";
import { decodeTaskEvent, type TaskEvent } from "./task-event.js";
import type { TaskResult } from "./task-state.js";
import { Schema } from "effect";
import type { RuntimeDatabase } from "./sqlite-database.js";

export const MAX_USAGE_REPORT_EVENTS = 100_000;
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
  provider: Schema.String,
  adapter: Schema.String,
  model: Schema.String,
  serviceTier: Schema.String,
  reasoningEffort: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled", "blocked", "unknown"]),
  invocations: Schema.Natural,
  usage: usageAmountsSchema,
});
export const usageReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scope: usageScopeSchema,
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
  readonly complete: boolean;
}

type CompletedSession = Extract<TaskEvent["data"], { type: "coding_session_completed" }>;
type StartedSession = Extract<TaskEvent["data"], { type: "coding_session_started" }>;
type InterruptedSession = Extract<TaskEvent["data"], { type: "coding_session_interrupted" }>;
type UsageObserved = Extract<TaskEvent["data"], { type: "coding_usage_observed" }>;
type SessionUsage = NonNullable<CompletedSession["usage"]>;

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
  normalizerUsage: SessionUsage | null;
  normalizerAttempted: boolean;
  normalizerStatus: UsageOutcome | null;
  normalizer: CompletedSession["normalizer"];
  completedAtEpochMs: number | null;
}

export function deriveUsageReport(
  sources: readonly UsageReportSource[],
  scope: UsageReportScope,
  sourceCoverage: UsageCoverage = "complete",
): UsageReport {
  const invocations = sources.flatMap((source) => invocationsForSource(source));
  const selected = invocations.filter((invocation) => inScope(invocation, scope));
  selected.sort(
    (left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.occurredAtEpochMs - right.occurredAtEpochMs ||
      left.invocationId.localeCompare(right.invocationId),
  );
  const aggregates = aggregateInvocations(selected);
  return {
    schemaVersion: 1,
    scope,
    coverage:
      sourceCoverage === "unavailable" || selected.some((row) => row.usage.coverage !== "complete")
        ? selected.length === 0 && sourceCoverage === "complete"
          ? "complete"
          : sourceCoverage === "unavailable"
            ? "unavailable"
            : "partial"
        : "complete",
    invocations: selected,
    aggregates,
  };
}

export async function listUsageReportSources(
  database: RuntimeDatabase,
  scope: UsageReportScope,
): Promise<UsageReportSourcesPage> {
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
  if (taskIds.length === 0) return { complete: true, sources: [] };
  const rows = await database
    .select()
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, taskIds))
    .orderBy(asc(taskEvents.occurredAtEpochMs), asc(taskEvents.taskId), asc(taskEvents.sequence))
    .limit(MAX_USAGE_REPORT_EVENTS + 1);
  const complete = rows.length <= MAX_USAGE_REPORT_EVENTS;
  const grouped = new Map<string, TaskEvent[]>();
  for (const row of rows.slice(0, MAX_USAGE_REPORT_EVENTS)) {
    const task = tasks.get(row.taskId);
    if (!task || !repositoryMatches(task, scope.repositoryId)) continue;
    const event = decodeTaskEventRow(row);
    const events = grouped.get(row.taskId) ?? [];
    events.push(event);
    grouped.set(row.taskId, events);
  }
  return {
    complete,
    sources: [...grouped.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([taskId, events]) => ({ task: tasks.get(taskId)!, events })),
  };
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
      if (data.source === "provider") run.providerUsage = addUsage(run.providerUsage, data.usage);
      else {
        run.normalizerAttempted = true;
        run.normalizerUsage = addUsage(run.normalizerUsage, data.usage);
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
      if (data.normalizer) {
        run.normalizerAttempted = true;
        run.normalizer = data.normalizer;
        run.normalizerStatus = data.normalizer.status;
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
    provider: normalizer
      ? (run.normalizer?.modelProvider ?? USAGE_DIMENSION_UNAVAILABLE)
      : (effective?.modelProvider ?? USAGE_DIMENSION_UNAVAILABLE),
    adapter: normalizer
      ? (run.normalizer?.adapter ?? "role-output-normalizer")
      : (effective?.adapter ?? USAGE_DIMENSION_UNAVAILABLE),
    model: normalizer
      ? (run.normalizer?.model ?? USAGE_DIMENSION_UNAVAILABLE)
      : (effective?.model ?? USAGE_DIMENSION_UNAVAILABLE),
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
  const known = Object.values(values).filter((value) => value !== undefined).length;
  return {
    inputTokens: values.inputTokens ?? null,
    cachedInputTokens: values.cachedInputTokens ?? null,
    uncachedInputTokens: values.uncachedInputTokens ?? null,
    cacheWriteInputTokens: values.cacheWriteInputTokens ?? null,
    outputTokens: values.outputTokens ?? null,
    reasoningOutputTokens: values.reasoningOutputTokens ?? null,
    coverage: usage === null || known === 0 ? "unavailable" : known === 6 ? "complete" : "partial",
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
    .toSorted((left, right) => aggregateKey(left).localeCompare(aggregateKey(right)));
}

function aggregateUsage(values: readonly UsageAmounts[]): UsageAmounts {
  const sum = (selector: (value: UsageAmounts) => number | null): number | null => {
    const selected = values.map(selector);
    return selected.every((value) => value === null)
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
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: add(left?.inputTokens, right.inputTokens),
    cachedInputTokens: add(left?.cachedInputTokens, right.cachedInputTokens),
    uncachedInputTokens: add(left?.uncachedInputTokens, right.uncachedInputTokens),
    cacheWriteInputTokens: add(left?.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: add(left?.outputTokens, right.outputTokens),
    reasoningOutputTokens: add(left?.reasoningOutputTokens, right.reasoningOutputTokens),
  };
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
    value.provider,
    value.adapter,
    value.model,
    value.serviceTier,
    value.reasoningEffort,
    value.outcome,
  ].join("\u0000");
}
