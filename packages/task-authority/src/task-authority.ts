import { and, asc, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { repositories, repositoryLeases, taskEvents, taskQuarantines, taskRuns } from "./schema.js";
import type { RuntimeDatabase } from "./sqlite-database.js";
import {
  decodePersistedTaskResult,
  decodeRawPersistedTaskResult,
  TaskStateQuarantinedError,
  isTaskStateQuarantinedError,
  TASK_RESULT_SCHEMA_VERSION,
} from "./task-state-schema.js";
import {
  decodeTaskEvent,
  decodeTaskObservationEventInput,
  type TaskEvent,
  type TaskEventData,
  type TaskArchiveReference,
  type TaskObservationEventInput,
} from "./task-event.js";
import {
  applyTaskFact,
  isTerminalState,
  isWaitingState,
  type AuthorityInput,
  type CandidateFact,
  type CheckResult,
  type DeliveryEffect,
  type ReviewVerdict,
  type TaskBlockerClassification,
  type TaskFact,
  type TaskObservation,
  type TaskExecutionInput,
  type TaskResult,
  type TaskWaiting,
  type TaskFailureClass,
} from "./task-state.js";
import { deadlineExpired } from "./remaining-until.js";
import { countBudgetExhausted, type CountBudget } from "./contract.js";
import {
  snapshotFromRegistration,
  decodeAcceptanceChecks,
  repositoryResourceFromSnapshot,
  taskSnapshotFromRegistration,
  type RepositoryRegistration,
  type RepositoryResource,
  type RepositorySnapshot,
  type TaskRepositorySnapshot,
} from "./repository.js";

import {
  taskListItemFromResult,
  type TaskListItem,
  type TaskListPage,
} from "./task-state-schema.js";
import type { CodingSessionResource, ServerSnapshot } from "./resource.js";
import { decodeTaskIdCursor, encodeTaskIdCursor, pageTaskIds } from "./task-id-cursor.js";
import {
  listUsageReportSources,
  type UsageReportScope,
  type UsageReportPageRequest,
  type UsageReportSourcesPage,
} from "./usage-report.js";
import { listCampaignEvidenceSources } from "./campaign-evidence-sources.js";
import type {
  CampaignEvidencePageRequest,
  CampaignEvidenceSourcesPage,
} from "./campaign-evidence.js";

type AuthorityDatabase = RuntimeDatabase;

const MAX_EVENT_LIMIT = 200;
export const MAX_TASK_LIST_PAGE_SIZE = 200;
const TASK_LIST_CURSOR_SCOPE = "task-list" as const;
const MAX_DURABLE_REVISION = Number.MAX_SAFE_INTEGER;

export interface RecoveryArchiveReference {
  readonly taskId: string;
  readonly role: "implementer" | "reviewer";
  readonly attempt: string;
  readonly archive: TaskArchiveReference;
}

function repositoryPolicySelectionChanged(
  existing: typeof repositories.$inferSelect,
  input: RepositoryRegistration,
): boolean {
  return (
    existing.owner !== input.owner ||
    existing.name !== input.name ||
    existing.implementerProfile !== input.implementerProfile ||
    existing.reviewerProfile !== input.reviewerProfile ||
    existing.forgeProfile !== input.forgeProfile ||
    existing.githubReadProfile !== (input.githubReadProfile ?? null) ||
    JSON.stringify(existing.acceptanceChecks) !== JSON.stringify(input.acceptanceChecks ?? [])
  );
}

function acceptanceChecksFromRow(row: typeof repositories.$inferSelect) {
  return decodeAcceptanceChecks(row.acceptanceChecks);
}

function repositorySnapshotsEqual(
  left: TaskRepositorySnapshot,
  right: TaskRepositorySnapshot,
): boolean {
  return (
    JSON.stringify({ ...left, acceptanceChecks: left.acceptanceChecks ?? [] }) ===
    JSON.stringify({ ...right, acceptanceChecks: right.acceptanceChecks ?? [] })
  );
}

export interface TaskAuthorityOptions {
  onEvent?: (event: TaskEvent) => void;
}

export interface TaskListPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export type ReviewAttemptTakeoverStatus = "claimed" | "budget_exhausted";
export interface ReviewAttemptReservationResult {
  result: TaskResult;
  claimed: boolean;
  cycle: number | null;
}
export interface ReviewAttemptTakeoverResult extends ReviewAttemptReservationResult {
  status: ReviewAttemptTakeoverStatus;
}

export class TaskCapacityError extends Error {
  readonly code = "active_task_capacity";
  readonly retryable = true;

  constructor(
    readonly capacity: number,
    readonly active: number,
  ) {
    super("active Task capacity is full");
    this.name = "TaskCapacityError";
  }
}

export class RepositoryWriterConflictError extends Error {
  readonly code = "repository_writer_conflict";
  readonly retryable = true;

  constructor(readonly repositoryIdentity: string) {
    super("repository already has an active writer");
    this.name = "RepositoryWriterConflictError";
  }
}

export type TaskRetryConflictReason =
  | "task_not_waiting"
  | "deadline_exhausted"
  | "activation_budget_exhausted"
  | "campaign_abandoned";

export class TaskRetryConflictError extends Error {
  readonly code = "task_retry_conflict";
  readonly retryable = false;

  constructor(
    readonly reason: TaskRetryConflictReason,
    readonly state: string,
  ) {
    super("task is not retryable");
    this.name = "TaskRetryConflictError";
  }
}

function saturatingAdd(left: number, right: number): number {
  return left >= MAX_DURABLE_REVISION - right ? MAX_DURABLE_REVISION : left + right;
}

export class TaskAuthority {
  private readonly onEvent: ((event: TaskEvent) => void) | undefined;

  constructor(
    private readonly database: AuthorityDatabase,
    options: TaskAuthorityOptions = {},
  ) {
    this.onEvent = options.onEvent;
  }

  async registerRepository(input: RepositoryRegistration): Promise<RepositorySnapshot> {
    const register = async (database: AuthorityDatabase): Promise<RepositorySnapshot> => {
      const existing = await database.query.repositories.findFirst({
        where: eq(repositories.id, input.id),
      });
      const snapshot = snapshotFromRegistration(input);
      if (existing) {
        const repositoryIdentities = new Set([
          `${existing.owner}/${existing.name}`.toLowerCase(),
          `${input.owner}/${input.name}`.toLowerCase(),
        ]);
        for (const repositoryIdentity of repositoryIdentities) {
          const lease = await database.query.repositoryLeases.findFirst({
            where: eq(repositoryLeases.repositoryIdentity, repositoryIdentity),
          });
          if (lease && repositoryPolicySelectionChanged(existing, input))
            throw new Error("cannot change repository capability policy while a Task is active");
        }
        await database
          .update(repositories)
          .set({
            path: input.path,
            owner: input.owner,
            name: input.name,
            baseBranch: input.baseBranch,
            implementerProfile: input.implementerProfile,
            reviewerProfile: input.reviewerProfile,
            forgeProfile: input.forgeProfile,
            githubReadProfile: input.githubReadProfile ?? null,
            revision: sql`${repositories.revision} + 1`,
            projectCheckCommand: input.projectCheck.command,
            projectCheckTimeoutMs: input.projectCheck.timeoutMs,
            acceptanceChecks: input.acceptanceChecks ?? [],
            gitAuthorName: input.gitAuthor.name,
            gitAuthorEmail: input.gitAuthor.email,
            updatedAt: new Date(),
          })
          .where(eq(repositories.id, input.id));
        return snapshot;
      }
      await database.insert(repositories).values({
        id: input.id,
        path: input.path,
        owner: input.owner,
        name: input.name,
        baseBranch: input.baseBranch,
        implementerProfile: input.implementerProfile,
        reviewerProfile: input.reviewerProfile,
        forgeProfile: input.forgeProfile,
        githubReadProfile: input.githubReadProfile ?? null,
        headSha: null,
        projectCheckCommand: input.projectCheck.command,
        projectCheckTimeoutMs: input.projectCheck.timeoutMs,
        acceptanceChecks: input.acceptanceChecks ?? [],
        gitAuthorName: input.gitAuthor.name,
        gitAuthorEmail: input.gitAuthor.email,
      });
      return snapshot;
    };
    return this.inTransaction(register);
  }

  async lookupRepository(id: string): Promise<RepositorySnapshot | null> {
    const row = await this.database.query.repositories.findFirst({
      where: eq(repositories.id, id),
    });
    return row
      ? {
          id: row.id,
          path: row.path,
          owner: row.owner,
          name: row.name,
          baseBranch: row.baseBranch,
          implementerProfile: row.implementerProfile,
          reviewerProfile: row.reviewerProfile,
          forgeProfile: row.forgeProfile,
          githubReadProfile: row.githubReadProfile,
          ...(row.headSha ? { headSha: row.headSha } : {}),
          projectCheck: {
            command: row.projectCheckCommand,
            timeoutMs: row.projectCheckTimeoutMs,
          },
          acceptanceChecks: acceptanceChecksFromRow(row),
          gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail },
        }
      : null;
  }

  async lookupRepositoryResource(id: string): Promise<RepositoryResource | null> {
    const row = await this.database.query.repositories.findFirst({
      where: eq(repositories.id, id),
    });
    if (!row) return null;
    return repositoryResourceFromSnapshot(
      {
        id: row.id,
        path: row.path,
        owner: row.owner,
        name: row.name,
        baseBranch: row.baseBranch,
        implementerProfile: row.implementerProfile,
        reviewerProfile: row.reviewerProfile,
        forgeProfile: row.forgeProfile,
        githubReadProfile: row.githubReadProfile,
        ...(row.headSha ? { headSha: row.headSha } : {}),
        projectCheck: { command: row.projectCheckCommand, timeoutMs: row.projectCheckTimeoutMs },
        acceptanceChecks: acceptanceChecksFromRow(row),
        gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail },
      },
      row.revision,
    );
  }

  async listRepositories(limit = 100): Promise<RepositoryResource[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const rows = await this.database
      .select()
      .from(repositories)
      .orderBy(asc(repositories.id))
      .limit(boundedLimit);
    return rows.map((row) =>
      repositoryResourceFromSnapshot(
        {
          id: row.id,
          path: row.path,
          owner: row.owner,
          name: row.name,
          baseBranch: row.baseBranch,
          implementerProfile: row.implementerProfile,
          reviewerProfile: row.reviewerProfile,
          forgeProfile: row.forgeProfile,
          githubReadProfile: row.githubReadProfile,
          ...(row.headSha ? { headSha: row.headSha } : {}),
          projectCheck: { command: row.projectCheckCommand, timeoutMs: row.projectCheckTimeoutMs },
          acceptanceChecks: acceptanceChecksFromRow(row),
          gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail },
        },
        row.revision,
      ),
    );
  }

  async listCodingSessions(limit = 100): Promise<CodingSessionResource[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
    const rows = await this.database
      .select()
      .from(taskEvents)
      .orderBy(asc(taskEvents.taskId), asc(taskEvents.sequence));
    const active = new Map<string, CodingSessionResource>();
    for (const row of rows) {
      let event: TaskEvent;
      try {
        event = decodeTaskEvent(row);
      } catch {
        throw new TaskStateQuarantinedError(row.taskId);
      }
      if (
        event.data.type === "coding_session_started" ||
        event.data.type === "coding_thread_started"
      ) {
        active.set(`${event.taskId}:${event.data.sessionId}`, {
          taskId: event.taskId,
          sessionId: event.data.sessionId,
          role: event.data.role,
          activation: event.data.activation,
          revision: event.sequence,
        });
      } else if (
        event.data.type === "coding_session_completed" ||
        event.data.type === "coding_session_interrupted"
      ) {
        active.delete(`${event.taskId}:${event.data.sessionId}`);
      }
    }
    return [...active.values()]
      .toSorted((left, right) =>
        `${left.taskId}:${left.sessionId}`.localeCompare(`${right.taskId}:${right.sessionId}`),
      )
      .slice(0, boundedLimit);
  }

  async durableRevision(): Promise<number> {
    const repositoryRows = await this.database
      .select({ revision: repositories.revision })
      .from(repositories);
    const eventRows = await this.database
      .select({ taskId: taskEvents.taskId, sequence: taskEvents.sequence })
      .from(taskEvents);
    const taskRows = await this.database
      .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns);
    const quarantinedRows = await this.database
      .select({ taskId: taskQuarantines.taskId })
      .from(taskQuarantines);
    let weightedRevision = 0;
    let factCount = 0;
    const addFact = (value: number): void => {
      factCount = saturatingAdd(factCount, 1);
      weightedRevision = saturatingAdd(weightedRevision, Math.max(0, value));
    };
    for (const row of repositoryRows) addFact(row.revision);
    for (const row of eventRows) addFact(row.sequence);
    for (const row of taskRows) {
      try {
        addFact(decodeRawPersistedTaskResult(row.rawResult).revision);
      } catch {
        throw new TaskStateQuarantinedError(row.taskId);
      }
    }
    quarantinedRows.forEach(() => addFact(0));
    return saturatingAdd(weightedRevision, factCount > 0 ? factCount - 1 : 0);
  }

  async readServerSnapshot(limit = 100): Promise<ServerSnapshot> {
    return this.inReadTransaction(async (database) => {
      const authority = new TaskAuthority(database);
      const repositoryResources = await authority.listRepositories(limit);
      const tasks = await authority.listTasks(limit);
      const codingSessions = await authority.listCodingSessions(limit);
      const revision = await authority.durableRevision();
      return {
        schemaVersion: 1,
        revision,
        server: { status: "ok", revision },
        repositories: repositoryResources,
        tasks,
        codingSessions,
      };
    });
  }

  async lookup(taskId: string): Promise<TaskResult | null> {
    const rows = await this.database
      .select({ rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .limit(1);
    const row = rows[0];
    if (row) {
      try {
        return decodeRawPersistedTaskResult(row.rawResult);
      } catch (error) {
        if (isTaskStateQuarantinedError(error)) throw new TaskStateQuarantinedError(taskId);
        throw error;
      }
    }
    const quarantined = await this.database
      .select({ taskId: taskQuarantines.taskId })
      .from(taskQuarantines)
      .where(eq(taskQuarantines.taskId, taskId))
      .limit(1);
    if (quarantined[0]) throw new TaskStateQuarantinedError(taskId);
    return null;
  }

  async listTasks(limit = 100): Promise<TaskListItem[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_TASK_LIST_PAGE_SIZE);
    return [...(await this.listTaskPage({ cursor: null, limit: boundedLimit })).tasks];
  }

  async listTaskPage(request: TaskListPageRequest): Promise<TaskListPage> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > MAX_TASK_LIST_PAGE_SIZE
    )
      throw new RangeError("task list page limit is out of range");
    const quarantined = await this.database
      .select({ taskId: taskQuarantines.taskId })
      .from(taskQuarantines)
      .orderBy(asc(taskQuarantines.taskId));
    if (quarantined[0]) throw new TaskStateQuarantinedError(quarantined[0].taskId);
    const rows = await this.database
      .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .orderBy(asc(taskRuns.taskId));
    const taskIds = rows.map((row) => row.taskId);
    const cursor =
      request.cursor === null ? null : decodeTaskIdCursor(request.cursor, TASK_LIST_CURSOR_SCOPE);
    const page = pageTaskIds(taskIds, cursor, request.limit, TASK_LIST_CURSOR_SCOPE);
    const selectedTaskIds = new Set(page.taskIds);
    const tasks: TaskListItem[] = [];
    for (const row of rows) {
      try {
        const task = taskListItemFromResult(decodeRawPersistedTaskResult(row.rawResult));
        if (selectedTaskIds.has(row.taskId)) tasks.push(task);
      } catch (error) {
        if (isTaskStateQuarantinedError(error)) throw new TaskStateQuarantinedError(row.taskId);
        throw error;
      }
    }
    return {
      tasks,
      cursor: request.cursor,
      nextCursor:
        page.nextCursor === null
          ? null
          : encodeTaskIdCursor({
              ...page.nextCursor,
              scope: TASK_LIST_CURSOR_SCOPE,
            }),
    };
  }

  async lookupExisting(taskId: string, contractHash: string): Promise<TaskResult | null> {
    const result = await this.lookup(taskId);
    if (!result) return null;
    if (result.contractHash !== contractHash) throw new Error("admitted contract is immutable");
    return result;
  }

  async appendObservation(taskId: string, input: TaskObservationEventInput): Promise<TaskEvent> {
    const decoded = decodeTaskObservationEventInput(input);
    const event = await this.inTransaction(async (database) => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      return TaskAuthority.appendEvent(database, taskId, decoded);
    });
    this.emit([event]);
    return event;
  }

  async recordRecoveryObservation(
    taskId: string,
    kind: "server_restart",
    archiveReferences: readonly RecoveryArchiveReference[] = [],
  ): Promise<readonly TaskEvent[]> {
    const events = await this.inTransaction(async (database) => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      const rows = await database
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .orderBy(asc(taskEvents.sequence));
      const active = new Map<
        string,
        {
          readonly start: Extract<TaskEventData, { type: "coding_session_started" }>;
          readonly startEventId: string;
          readonly sequence: number;
          phase: "startup" | "thread" | "turn" | "output";
        }
      >();
      const reviewShaByCycle = new Map<number, string>();
      for (const row of rows) {
        const event = decodeTaskEvent(row);
        const data = event.data;
        if (data.type === "review_started") {
          reviewShaByCycle.set(data.cycle, data.sha);
          continue;
        }
        if (
          data.type !== "coding_session_started" &&
          data.type !== "coding_thread_started" &&
          data.type !== "coding_turn_started" &&
          data.type !== "coding_tool_completed" &&
          data.type !== "coding_mcp_tool_completed" &&
          data.type !== "coding_turn_completed" &&
          data.type !== "coding_session_completed" &&
          data.type !== "coding_session_interrupted"
        )
          continue;
        const key = `${data.role}:${data.activation}:${data.sessionId}`;
        if (data.type === "coding_session_started") {
          active.set(key, {
            start: data,
            startEventId: event.eventId,
            sequence: event.sequence,
            phase: "startup",
          });
        } else if (
          data.type === "coding_session_completed" ||
          data.type === "coding_session_interrupted"
        ) {
          active.delete(key);
        } else {
          const run = active.get(key);
          if (run) {
            run.phase =
              data.type === "coding_thread_started"
                ? "thread"
                : data.type === "coding_turn_completed"
                  ? "output"
                  : "turn";
          }
        }
      }
      const recovered: TaskEvent[] = [];
      for (const run of [...active.values()].sort(
        (left, right) => left.sequence - right.sequence,
      )) {
        const attempt =
          run.start.role === "implementer"
            ? String(run.start.activation)
            : run.start.reviewCycle === undefined
              ? null
              : (() => {
                  const sha = reviewShaByCycle.get(run.start.reviewCycle);
                  return sha === undefined ? null : `${run.start.reviewCycle}-${sha}`;
                })();
        const matches =
          attempt === null
            ? []
            : archiveReferences.filter(
                (reference) =>
                  reference.taskId === taskId &&
                  reference.role === run.start.role &&
                  reference.attempt === attempt,
              );
        const archive = matches.length === 1 ? matches[0]!.archive : undefined;
        recovered.push(
          await TaskAuthority.appendEvent(database, taskId, {
            eventId: `recovery:coding_session_interrupted:${createHash("sha256")
              .update(run.startEventId)
              .digest("hex")
              .slice(0, 32)}`,
            occurredAtEpochMs: Date.now(),
            data: {
              type: "coding_session_interrupted",
              role: run.start.role,
              activation: run.start.activation,
              sessionId: run.start.sessionId,
              phase: run.phase,
              failureClass: "unknown",
              ...(archive ? { archive } : {}),
            },
          }),
        );
      }
      recovered.push(
        await TaskAuthority.appendEvent(database, taskId, {
          eventId: `recovery:${kind}:${randomUUID()}`,
          occurredAtEpochMs: Date.now(),
          data: { type: "recovery_observed", kind },
        }),
      );
      return recovered;
    });
    this.emit(events);
    return events;
  }

  async listEvents(
    taskId: string,
    afterSequence = 0,
    limit = MAX_EVENT_LIMIT,
  ): Promise<TaskEvent[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_EVENT_LIMIT);
    const rows = await this.database
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.sequence} > ${afterSequence}`))
      .orderBy(taskEvents.sequence)
      .limit(boundedLimit);
    return rows.map(decodeTaskEvent);
  }

  async listUsageReportSources(
    scope: UsageReportScope,
    request?: UsageReportPageRequest,
  ): Promise<UsageReportSourcesPage> {
    return listUsageReportSources(this.database, scope, request);
  }

  async listCampaignEvidenceSources(
    campaignId: string,
    request?: CampaignEvidencePageRequest,
  ): Promise<CampaignEvidenceSourcesPage | null> {
    return listCampaignEvidenceSources(this.database, campaignId, request);
  }

  async listRestartable(): Promise<{
    restartable: Array<{ result: TaskResult; input: TaskExecutionInput }>;
    activeTaskCount: number;
  }> {
    const rows = await this.database
      .select({
        rawResult: sql<string>`${taskRuns.result}`,
        contractPath: taskRuns.contractPath,
        rawContract: taskRuns.rawContract,
      })
      .from(taskRuns);
    const restartable: Array<{ result: TaskResult; input: TaskExecutionInput }> = [];
    let activeTaskCount = 0;
    for (const row of rows) {
      let result: TaskResult;
      try {
        result = decodeRawPersistedTaskResult(row.rawResult);
      } catch {
        continue;
      }
      if (isTerminalState(result.state)) continue;
      activeTaskCount += 1;
      if (
        isWaitingState(result.state) &&
        result.waiting?.reason !== "review_interruption" &&
        result.waiting?.reason !== "pipeline_checks"
      )
        continue;
      if (!row.rawContract || !result.repository) continue;
      restartable.push({
        result,
        input: {
          contractPath: row.contractPath,
          rawContract: row.rawContract,
        },
      });
    }
    return { restartable, activeTaskCount };
  }

  async lookupExecution(taskId: string): Promise<TaskExecutionInput | null> {
    const rows = await this.database
      .select({
        rawResult: sql<string>`${taskRuns.result}`,
        contractPath: taskRuns.contractPath,
        rawContract: taskRuns.rawContract,
      })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!row.rawContract) return null;
    // Validate durable Task state before returning committed execution input.
    decodeRawPersistedTaskResult(row.rawResult);
    return {
      contractPath: row.contractPath,
      rawContract: row.rawContract,
    };
  }

  private static async currentTask(database: AuthorityDatabase, taskId: string) {
    return database.query.taskRuns.findFirst({ where: eq(taskRuns.taskId, taskId) });
  }

  private static existingAdmission(
    row: typeof taskRuns.$inferSelect,
    input: AuthorityInput,
  ): TaskResult {
    const result = decodePersistedTaskResult(row.result);
    if (result.contractHash !== input.contractHash)
      throw new Error("admitted contract is immutable");
    if (result.writer.repositoryIdentity !== input.repositoryIdentity)
      throw new Error("task repository identity is immutable");
    if (result.mergeAuthorized !== (input.contract.authorization.merge === true))
      throw new Error("task merge authority is immutable");
    if (JSON.stringify(result.campaign ?? null) !== JSON.stringify(input.contract.campaign ?? null))
      throw new Error("task Campaign association is immutable");
    if (
      input.repository &&
      (!result.repository ||
        !repositorySnapshotsEqual(
          result.repository,
          taskSnapshotFromRegistration(input.repository),
        ))
    )
      throw new Error("task repository snapshot is immutable");
    return result;
  }

  async admit(
    input: AuthorityInput,
    executionInput?: TaskExecutionInput,
    activeTaskCapacity?: number,
  ): Promise<TaskResult> {
    let createdAdmission = false;
    const admit = async (database: AuthorityDatabase): Promise<TaskResult> => {
      // The task row is immutable.  Lock it when it already exists so a
      // concurrent admission cannot observe a half-updated lifecycle.
      const existing = await TaskAuthority.currentTask(database, input.contract.id);
      if (existing) {
        if (executionInput && (!existing.contractPath || !existing.rawContract)) {
          await database
            .update(taskRuns)
            .set(executionInput)
            .where(eq(taskRuns.taskId, input.contract.id));
        }
        return TaskAuthority.existingAdmission(existing, input);
      }

      if (activeTaskCapacity !== undefined) {
        const rows = await database
          .select({ rawResult: sql<string>`${taskRuns.result}` })
          .from(taskRuns);
        let active = 0;
        for (const row of rows) {
          try {
            if (!isTerminalState(decodeRawPersistedTaskResult(row.rawResult).state)) active += 1;
          } catch (error) {
            if (!isTaskStateQuarantinedError(error)) throw error;
          }
        }
        if (active >= activeTaskCapacity) throw new TaskCapacityError(activeTaskCapacity, active);
      }

      const inserted = await database
        .insert(repositoryLeases)
        .values({
          repositoryIdentity: input.repositoryIdentity,
          taskId: input.contract.id,
        })
        .onConflictDoNothing()
        .returning();
      const lease = inserted[0];
      if (!lease) {
        // The lease's unique task ID serializes same-ID admissions. After the
        // conflict wait, the winning task is visible in this transaction.
        const winner = await TaskAuthority.currentTask(database, input.contract.id);
        if (winner) {
          if (executionInput && (!winner.contractPath || !winner.rawContract)) {
            await database
              .update(taskRuns)
              .set(executionInput)
              .where(eq(taskRuns.taskId, input.contract.id));
          }
          return TaskAuthority.existingAdmission(winner, input);
        }
        const occupied = await database.query.repositoryLeases.findFirst({
          where: eq(repositoryLeases.repositoryIdentity, input.repositoryIdentity),
        });
        if (occupied?.taskId === input.contract.id)
          throw new Error("repository lease has no admitted task");
        throw new RepositoryWriterConflictError(input.repositoryIdentity);
      }

      const result: TaskResult = {
        schemaVersion: TASK_RESULT_SCHEMA_VERSION,
        taskId: input.contract.id,
        contractHash: input.contractHash,
        revision: 0,
        ...(input.deadlineEpochMs === undefined ? {} : { deadlineEpochMs: input.deadlineEpochMs }),
        state: "admitted",
        ...(input.contract.campaign ? { campaign: { ...input.contract.campaign } } : {}),
        mergeAuthorized: input.contract.authorization.merge === true,
        candidateSha: null,
        candidateFence: null,
        check: null,
        review: null,
        repairBatchRecorded: false,
        reviewAttempt: null,
        delivery: null,
        blocker: null,
        blockerClassification: null,
        waiting: null,
        activeActivation: null,
        writer: {
          repositoryIdentity: input.repositoryIdentity,
        },
        repository: input.repository ? taskSnapshotFromRegistration(input.repository) : undefined,
        evidence: {
          implementerActivations: 0,
          reviewCycles: 0,
          changesRequestedBatches: 0,
          restartRecoveries: 0,
        },
      };
      await database.insert(taskRuns).values({
        taskId: result.taskId,
        result,
        ...executionInput,
      });
      await database.insert(taskEvents).values({
        taskId: result.taskId,
        sequence: 1,
        eventId: "task-admitted",
        occurredAtEpochMs: Date.now(),
        data: { type: "task_admitted", contractHash: result.contractHash },
      });
      createdAdmission = true;
      return result;
    };
    const result = await this.inTransaction(admit);
    if (createdAdmission && this.onEvent) this.emit(await this.listEvents(result.taskId, 0, 1));
    return result;
  }

  private async persistFact(observation: TaskObservation, fact: TaskFact): Promise<TaskResult> {
    const persist = async (
      database: AuthorityDatabase,
    ): Promise<{ saved: TaskResult; events: TaskEvent[] }> => {
      const current = await TaskAuthority.currentTask(database, observation.taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = decodePersistedTaskResult(current.result);
      if (observation.revision !== prior.revision) throw new Error("stale task revision");
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== prior.taskId)
        throw new Error("repository writer lease is stale");
      const next = applyTaskFact(prior, fact);
      if (next === prior) return { saved: prior, events: [] };
      const saved: TaskResult = {
        ...next,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, observation.taskId));
      const events = await TaskAuthority.appendFactEvents(database, prior, fact, saved);
      if (isTerminalState(saved.state)) {
        await database
          .delete(repositoryLeases)
          .where(
            and(
              eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
              eq(repositoryLeases.taskId, prior.taskId),
            ),
          );
      }
      return { saved, events };
    };
    const { saved, events } = await this.inTransaction(persist);
    this.emit(events);
    return saved;
  }

  recordCandidate(observation: TaskObservation, candidate: CandidateFact): Promise<TaskResult> {
    return this.persistFact(observation, { type: "candidate", candidate });
  }

  recordCheck(observation: TaskObservation, check: CheckResult): Promise<TaskResult> {
    return this.persistFact(observation, { type: "check", check });
  }

  recordReview(
    observation: TaskObservation,
    review: ReviewVerdict,
    ownerId: string,
  ): Promise<TaskResult> {
    return this.persistFact(observation, { type: "review", review, ownerId });
  }

  recordReviewInterruption(
    observation: TaskObservation,
    sha: string,
    failureClass: TaskFailureClass,
    ownerId: string,
  ): Promise<TaskResult> {
    return this.persistFact(observation, {
      type: "review_interrupted",
      sha,
      failureClass,
      ownerId,
    });
  }

  releaseReviewAttempt(observation: TaskObservation, ownerId: string): Promise<TaskResult> {
    return this.persistFact(observation, { type: "review_released", ownerId });
  }

  async reserveReviewAttempt(
    taskId: string,
    budget: CountBudget,
    ownerId: string,
  ): Promise<ReviewAttemptReservationResult> {
    const reserve = async (database: AuthorityDatabase) => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = decodePersistedTaskResult(current.result);
      if (prior.state === "reviewing")
        return { result: prior, claimed: false, cycle: null, events: [] };
      if (
        prior.state !== "checked" &&
        !(prior.state === "waiting" && prior.waiting?.reason === "review_interruption")
      )
        throw new Error("task is not ready for a review attempt");
      const cycle = prior.evidence.reviewCycles + 1;
      if (countBudgetExhausted(budget, prior.evidence.reviewCycles))
        throw new Error("review budget exhausted");
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== prior.taskId)
        throw new Error("repository writer lease is stale");
      const next = applyTaskFact(prior, {
        type: "review_started",
        ownerId,
      });
      const saved: TaskResult = {
        ...next,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, taskId));
      const events = await TaskAuthority.appendFactEvents(
        database,
        prior,
        { type: "review_started", ownerId },
        saved,
      );
      return { result: saved, claimed: true, cycle, events };
    };
    const reserved = await this.inTransaction(reserve);
    this.emit(reserved.events);
    return {
      result: reserved.result,
      claimed: reserved.claimed,
      cycle: reserved.cycle,
    };
  }

  async takeOverReviewAttempt(
    taskId: string,
    budget: CountBudget,
    ownerId: string,
  ): Promise<ReviewAttemptTakeoverResult> {
    const takeover = async (database: AuthorityDatabase) => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = decodePersistedTaskResult(current.result);
      if (prior.state !== "reviewing") throw new Error("task is not reviewing");
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== prior.taskId)
        throw new Error("repository writer lease is stale");
      const cycle = prior.evidence.reviewCycles + 1;
      if (countBudgetExhausted(budget, prior.evidence.reviewCycles))
        return {
          result: prior,
          claimed: false,
          cycle: null,
          status: "budget_exhausted" as const,
          events: [] as TaskEvent[],
        };
      const next = applyTaskFact(prior, {
        type: "review_started",
        ownerId,
        takeover: true,
      });
      const saved: TaskResult = {
        ...next,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, taskId));
      const events = await TaskAuthority.appendFactEvents(
        database,
        prior,
        { type: "review_started", ownerId, takeover: true },
        saved,
      );
      return { result: saved, claimed: true, cycle, status: "claimed" as const, events };
    };
    const recovered = await this.inTransaction(takeover);
    this.emit(recovered.events);
    return {
      result: recovered.result,
      claimed: recovered.claimed,
      cycle: recovered.cycle,
      status: recovered.status,
    };
  }

  recordDelivery(observation: TaskObservation, delivery: DeliveryEffect): Promise<TaskResult> {
    return this.persistFact(observation, { type: "delivery", delivery });
  }

  recordRepairBatch(observation: TaskObservation): Promise<TaskResult> {
    return this.persistFact(observation, { type: "repair_batch" });
  }

  recordWaiting(observation: TaskObservation, waiting: TaskWaiting): Promise<TaskResult> {
    return this.persistFact(observation, { type: "waiting", waiting });
  }

  async resumePipelineChecks(taskId: string, revision: number): Promise<TaskResult> {
    const current = await this.lookup(taskId);
    if (!current) throw new Error("task is not admitted");
    if (current.revision !== revision) throw new Error("stale task revision");
    if (current.state !== "waiting" || current.waiting?.reason !== "pipeline_checks")
      return current;
    return this.retryTask(taskId, null);
  }

  block(
    observation: TaskObservation,
    blocker: string,
    classification?: TaskBlockerClassification,
  ): Promise<TaskResult> {
    return this.persistFact(observation, { type: "blocked", blocker, classification });
  }

  async reserveActivation(
    taskId: string,
    budget: CountBudget,
  ): Promise<{ result: TaskResult; activation: number }> {
    const reserve = async (
      database: AuthorityDatabase,
    ): Promise<{ result: TaskResult; activation: number }> => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = decodePersistedTaskResult(current.result);
      if (isTerminalState(prior.state)) throw new Error("task is terminal");
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== prior.taskId)
        throw new Error("repository writer lease is stale");
      const activation = prior.evidence.implementerActivations + 1;
      if (countBudgetExhausted(budget, prior.evidence.implementerActivations))
        throw new Error("implementer activation budget exhausted");
      const result: TaskResult = {
        ...prior,
        revision: prior.revision + 1,
        evidence: {
          ...prior.evidence,
          implementerActivations: activation,
          restartRecoveries:
            prior.evidence.restartRecoveries + (prior.activeActivation != null ? 1 : 0),
        },
        activeActivation: activation,
      };
      await database
        .update(taskRuns)
        .set({ result, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, taskId));
      await TaskAuthority.appendEvent(database, taskId, {
        eventId: `activation:${activation}`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "activation_reserved",
          activation,
          recovery: prior.activeActivation != null,
        },
      });
      return { result, activation };
    };
    const reserved = await this.inTransaction(async (database) => {
      const result = await reserve(database);
      const event = await database
        .select()
        .from(taskEvents)
        .where(
          and(
            eq(taskEvents.taskId, taskId),
            eq(taskEvents.eventId, `activation:${result.activation}`),
          ),
        )
        .limit(1);
      return { result, event: event[0] ? decodeTaskEvent(event[0]) : null };
    });
    if (reserved.event) this.emit([reserved.event]);
    return reserved.result;
  }

  async retryTask(taskId: string, budget: CountBudget): Promise<TaskResult> {
    const retry = async (
      database: AuthorityDatabase,
    ): Promise<{ result: TaskResult; events: TaskEvent[] }> => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = decodePersistedTaskResult(current.result);
      if (!isWaitingState(prior.state) || !prior.waiting)
        throw new TaskRetryConflictError("task_not_waiting", prior.state);
      if (prior.waiting.reason === "review_interruption")
        throw new TaskRetryConflictError("task_not_waiting", prior.state);
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== prior.taskId)
        throw new Error("repository writer lease is stale");
      if (deadlineExpired(prior.deadlineEpochMs)) {
        const blocked = applyTaskFact(prior, {
          type: "blocked",
          blocker: "elapsed budget exhausted",
        });
        const saved = {
          ...blocked,
          revision: prior.revision + 1,
          deadlineEpochMs: prior.deadlineEpochMs,
        };
        await database
          .update(taskRuns)
          .set({ result: saved, updatedAt: new Date() })
          .where(eq(taskRuns.taskId, taskId));
        const blockedEvent = await TaskAuthority.appendEvent(database, taskId, {
          eventId: `blocked:${prior.revision}`,
          occurredAtEpochMs: Date.now(),
          data: { type: "task_blocked", reason: saved.blockerClassification! },
        });
        const terminalEvent = await TaskAuthority.appendEvent(database, taskId, {
          eventId: `terminal:${saved.state}`,
          occurredAtEpochMs: Date.now(),
          data: { type: "task_terminal", state: "blocked" },
        });
        await database
          .delete(repositoryLeases)
          .where(
            and(
              eq(repositoryLeases.repositoryIdentity, prior.writer.repositoryIdentity),
              eq(repositoryLeases.taskId, prior.taskId),
            ),
          );
        return { result: saved, events: [blockedEvent, terminalEvent] };
      }
      if (
        prior.waiting.reason === "network_interruption" &&
        countBudgetExhausted(budget, prior.evidence.implementerActivations)
      )
        throw new TaskRetryConflictError("activation_budget_exhausted", prior.state);
      const resumed = applyTaskFact(prior, { type: "retry" });
      const saved = {
        ...resumed,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, taskId));
      const event = await TaskAuthority.appendEvent(database, taskId, {
        eventId: `retry:${prior.revision}`,
        occurredAtEpochMs: Date.now(),
        data: {
          type: "task_retry_accepted",
          reason: prior.waiting.reason,
          activation: prior.waiting.activation,
        },
      });
      return { result: saved, events: [event] };
    };
    const accepted = await this.inTransaction(retry);
    this.emit(accepted.events);
    return accepted.result;
  }

  private async inTransaction<T>(
    callback: (database: AuthorityDatabase) => Promise<T>,
  ): Promise<T> {
    const database = this.database as AuthorityDatabase & {
      transaction?: (
        callback: (transaction: AuthorityDatabase) => Promise<T>,
        config?: { behavior?: "deferred" | "immediate" | "exclusive" },
      ) => Promise<T>;
    };
    if (!database.transaction) return callback(this.database);
    return database.transaction(callback, { behavior: "immediate" });
  }

  private async inReadTransaction<T>(
    callback: (database: AuthorityDatabase) => Promise<T>,
  ): Promise<T> {
    const database = this.database as AuthorityDatabase & {
      transaction?: (
        callback: (transaction: AuthorityDatabase) => Promise<T>,
        config?: { behavior?: "deferred" | "immediate" | "exclusive" },
      ) => Promise<T>;
    };
    if (!database.transaction) return callback(this.database);
    return database.transaction(callback, { behavior: "deferred" });
  }

  private static async appendFactEvents(
    database: AuthorityDatabase,
    prior: TaskResult,
    fact: TaskFact,
    saved: TaskResult,
  ): Promise<TaskEvent[]> {
    const events: TaskEvent[] = [];
    const event = factEvent(prior, fact, saved);
    if (event) events.push(await TaskAuthority.appendEvent(database, saved.taskId, event));
    if (saved.state === "reviewed_pr" || saved.state === "merged" || saved.state === "blocked") {
      events.push(
        await TaskAuthority.appendEvent(database, saved.taskId, {
          eventId: `terminal:${saved.state}`,
          occurredAtEpochMs: Date.now(),
          data: { type: "task_terminal", state: saved.state },
        }),
      );
    }
    return events;
  }

  private static async appendEvent(
    database: AuthorityDatabase,
    taskId: string,
    input: { eventId: string; occurredAtEpochMs: number; data: TaskEventData },
  ): Promise<TaskEvent> {
    const existing = await database
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventId, input.eventId)))
      .limit(1);
    if (existing[0]) return decodeTaskEvent(existing[0]);
    const latest = await database
      .select({ sequence: sql<number>`coalesce(max(${taskEvents.sequence}), 0)` })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId));
    const sequence = (latest[0]?.sequence ?? 0) + 1;
    const inserted = await database
      .insert(taskEvents)
      .values({
        taskId,
        sequence,
        eventId: input.eventId,
        occurredAtEpochMs: input.occurredAtEpochMs,
        data: input.data,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row) return decodeTaskEvent(row);
    const winner = await database
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventId, input.eventId)))
      .limit(1);
    if (!winner[0]) throw new Error("task event was not persisted");
    return decodeTaskEvent(winner[0]);
  }

  private emit(events: readonly TaskEvent[]): void {
    if (!this.onEvent) return;
    for (const event of events) this.onEvent(event);
  }
}

function factEvent(
  prior: TaskResult,
  fact: TaskFact,
  saved: TaskResult,
): { eventId: string; occurredAtEpochMs: number; data: TaskEventData } | null {
  const occurredAtEpochMs = Date.now();
  switch (fact.type) {
    case "candidate":
      return {
        eventId: `candidate:${fact.candidate.sha}`,
        occurredAtEpochMs,
        data: { type: "candidate_frozen", sha: fact.candidate.sha, fence: fact.candidate.fence },
      };
    case "check":
      return {
        eventId: `check:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "project_check_completed",
          sha: fact.check.sha,
          cycle: Math.max(1, prior.evidence.reviewCycles + 1),
          outcome: fact.check.status,
          exitCode: fact.check.exitCode,
          ...(fact.check.acceptanceChecks ? { acceptanceChecks: fact.check.acceptanceChecks } : {}),
        },
      };
    case "review":
      return {
        eventId: `review:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "review_completed",
          sha: fact.review.sha,
          cycle: Math.max(1, prior.evidence.reviewCycles),
          verdict: fact.review.verdict,
          ...(fact.review.failureClass ? { failureClass: fact.review.failureClass } : {}),
        },
      };
    case "review_started":
      return {
        eventId: `review-started:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "review_started",
          sha: prior.candidateSha!,
          cycle: Math.max(1, prior.evidence.reviewCycles + 1),
        },
      };
    case "review_released":
      return {
        eventId: `review-released:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "review_released",
          sha: prior.candidateSha!,
          cycle: Math.max(1, prior.evidence.reviewCycles),
        },
      };
    case "review_interrupted":
      return {
        eventId: `review:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "review_interrupted",
          sha: fact.sha,
          cycle: Math.max(1, prior.evidence.reviewCycles),
          failureClass: fact.failureClass,
        },
      };
    case "delivery":
      return {
        eventId: `delivery:${fact.delivery.sha}`,
        occurredAtEpochMs,
        data: {
          type: "delivery_completed",
          sha: fact.delivery.sha,
          prNumber: fact.delivery.prNumber,
          merged: fact.delivery.merge != null,
        },
      };
    case "repair_batch":
      return {
        eventId: `repair:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "repair_batch_recorded",
          cycle: Math.max(1, prior.evidence.reviewCycles),
        },
      };
    case "waiting":
      return {
        eventId:
          fact.waiting.reason === "network_interruption"
            ? `waiting:${fact.waiting.activation}`
            : `waiting:${fact.waiting.reason}:${fact.waiting.activation}`,
        occurredAtEpochMs,
        data: {
          type: "task_waiting",
          reason: fact.waiting.reason,
          activation: fact.waiting.activation,
          ...(fact.waiting.failureClass ? { failureClass: fact.waiting.failureClass } : {}),
          ...(fact.waiting.diagnostic ? { diagnostic: fact.waiting.diagnostic } : {}),
        },
      };
    case "retry":
      return null;
    case "blocked":
      return {
        eventId: `blocked:${prior.revision}`,
        occurredAtEpochMs,
        data: { type: "task_blocked", reason: saved.blockerClassification! },
      };
  }
  return null;
}
