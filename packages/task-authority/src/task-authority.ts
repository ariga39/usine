import { and, asc, eq, sql } from "drizzle-orm";
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
  type TaskObservationEventInput,
} from "./task-event.js";
import {
  applyTaskFact,
  isTerminalState,
  type AuthorityInput,
  type CandidateFact,
  type CheckResult,
  type DeliveryEffect,
  type ReviewVerdict,
  type TaskFact,
  type TaskObservation,
  type TaskExecutionInput,
  type TaskResult,
} from "./task-state.js";
import {
  snapshotFromRegistration,
  repositoryResourceFromSnapshot,
  taskSnapshotFromRegistration,
  type RepositoryRegistration,
  type RepositoryResource,
  type RepositorySnapshot,
} from "./repository.js";

export type {
  AuthorityInput,
  CandidateFact,
  CheckResult,
  DeliveryEffect,
  ReviewVerdict,
  TaskFact,
  TaskExecutionInput,
  TaskObservation,
  TaskResult,
  TaskResource,
} from "./task-state.js";
import { taskListItemFromResult, type TaskListItem } from "./task-state-schema.js";
import type { CodingSessionResource, ServerSnapshot } from "./resource.js";
export {
  decodeTaskEvent,
  decodeTaskEventPage,
  decodeTaskObservationEventInput,
} from "./task-event.js";
export type {
  TaskEvent,
  TaskEventPage,
  TaskEventData,
  TaskObservationEventData,
  TaskObservationEventInput,
} from "./task-event.js";
export type {
  RepositoryRegistration,
  RepositoryResource,
  RepositorySnapshot,
  TaskRepositorySnapshot,
} from "./repository.js";

type AuthorityDatabase = RuntimeDatabase;

const MAX_EVENT_LIMIT = 200;
const MAX_DURABLE_REVISION = Number.MAX_SAFE_INTEGER;

function saturatingAdd(left: number, right: number): number {
  return left >= MAX_DURABLE_REVISION - right ? MAX_DURABLE_REVISION : left + right;
}

export class TaskAuthority {
  constructor(private readonly database: AuthorityDatabase) {}

  async registerRepository(input: RepositoryRegistration): Promise<RepositorySnapshot> {
    const register = async (database: AuthorityDatabase): Promise<RepositorySnapshot> => {
      const existing = await database.query.repositories.findFirst({
        where: eq(repositories.id, input.id),
      });
      const snapshot = snapshotFromRegistration(input);
      if (existing) {
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
        projectCheckCommand: input.projectCheck.command,
        projectCheckTimeoutMs: input.projectCheck.timeoutMs,
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
          projectCheck: {
            command: row.projectCheckCommand,
            timeoutMs: row.projectCheckTimeoutMs,
          },
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
        projectCheck: { command: row.projectCheckCommand, timeoutMs: row.projectCheckTimeoutMs },
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
          projectCheck: { command: row.projectCheckCommand, timeoutMs: row.projectCheckTimeoutMs },
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
      } else if (event.data.type === "coding_session_completed") {
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
    if (quarantined[0]) throw new TaskStateQuarantinedError();
    return null;
  }

  async listTasks(limit = 100): Promise<TaskListItem[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const quarantined = await this.database
      .select({ taskId: taskQuarantines.taskId })
      .from(taskQuarantines)
      .orderBy(asc(taskQuarantines.taskId));
    if (quarantined[0]) throw new TaskStateQuarantinedError(quarantined[0].taskId);
    const rows = await this.database
      .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .orderBy(asc(taskRuns.taskId));
    const tasks: TaskListItem[] = [];
    for (const row of rows) {
      try {
        tasks.push(taskListItemFromResult(decodeRawPersistedTaskResult(row.rawResult)));
      } catch (error) {
        if (isTaskStateQuarantinedError(error)) throw new TaskStateQuarantinedError(row.taskId);
        throw error;
      }
    }
    return tasks.slice(0, boundedLimit);
  }

  async lookupExisting(taskId: string, contractHash: string): Promise<TaskResult | null> {
    const result = await this.lookup(taskId);
    if (!result) return null;
    if (result.contractHash !== contractHash) throw new Error("admitted contract is immutable");
    return result;
  }

  async appendObservation(taskId: string, input: TaskObservationEventInput): Promise<TaskEvent> {
    const decoded = decodeTaskObservationEventInput(input);
    return this.inTransaction(async (database) => {
      const current = await TaskAuthority.currentTask(database, taskId);
      if (!current) throw new Error("task is not admitted");
      return TaskAuthority.appendEvent(database, taskId, decoded);
    });
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

  async listRestartable(): Promise<Array<{ result: TaskResult; input: TaskExecutionInput }>> {
    const rows = await this.database
      .select({
        rawResult: sql<string>`${taskRuns.result}`,
        contractPath: taskRuns.contractPath,
        rawContract: taskRuns.rawContract,
      })
      .from(taskRuns);
    const restartable: Array<{ result: TaskResult; input: TaskExecutionInput }> = [];
    for (const row of rows) {
      let result: TaskResult;
      try {
        result = decodeRawPersistedTaskResult(row.rawResult);
      } catch {
        continue;
      }
      if (isTerminalState(result.state)) continue;
      if (!row.contractPath || !row.rawContract || !result.repository) continue;
      restartable.push({
        result,
        input: {
          contractPath: row.contractPath,
          rawContract: row.rawContract,
        },
      });
    }
    return restartable;
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
    if (
      input.repository &&
      (!result.repository ||
        JSON.stringify(result.repository) !==
          JSON.stringify(taskSnapshotFromRegistration(input.repository)))
    )
      throw new Error("task repository snapshot is immutable");
    return result;
  }

  async admit(input: AuthorityInput, executionInput?: TaskExecutionInput): Promise<TaskResult> {
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
        throw new Error("repository already has an active writer");
      }

      const result: TaskResult = {
        schemaVersion: TASK_RESULT_SCHEMA_VERSION,
        taskId: input.contract.id,
        contractHash: input.contractHash,
        revision: 0,
        deadlineEpochMs: input.deadlineEpochMs,
        state: "admitted",
        mergeAuthorized: input.contract.authorization.merge === true,
        candidateSha: null,
        candidateFence: null,
        check: null,
        review: null,
        delivery: null,
        blocker: null,
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
      return result;
    };
    return this.inTransaction(admit);
  }

  private async persistFact(observation: TaskObservation, fact: TaskFact): Promise<TaskResult> {
    const persist = async (database: AuthorityDatabase): Promise<TaskResult> => {
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
      const saved: TaskResult = {
        ...next,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, observation.taskId));
      await TaskAuthority.appendFactEvents(database, prior, fact, saved);
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
      return saved;
    };
    return this.inTransaction(persist);
  }

  recordCandidate(observation: TaskObservation, candidate: CandidateFact): Promise<TaskResult> {
    return this.persistFact(observation, { type: "candidate", candidate });
  }

  recordCheck(observation: TaskObservation, check: CheckResult): Promise<TaskResult> {
    return this.persistFact(observation, { type: "check", check });
  }

  recordReview(observation: TaskObservation, review: ReviewVerdict): Promise<TaskResult> {
    return this.persistFact(observation, { type: "review", review });
  }

  recordDelivery(observation: TaskObservation, delivery: DeliveryEffect): Promise<TaskResult> {
    return this.persistFact(observation, { type: "delivery", delivery });
  }

  recordRepairBatch(observation: TaskObservation): Promise<TaskResult> {
    return this.persistFact(observation, { type: "repair_batch" });
  }

  block(observation: TaskObservation, blocker: string): Promise<TaskResult> {
    return this.persistFact(observation, { type: "blocked", blocker });
  }

  async reserveActivation(
    taskId: string,
    budget: number,
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
      if (activation > budget) throw new Error("implementer activation budget exhausted");
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
    return this.inTransaction(reserve);
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
  ): Promise<void> {
    const event = factEvent(prior, fact);
    if (event) await TaskAuthority.appendEvent(database, saved.taskId, event);
    if (saved.state === "reviewed_pr" || saved.state === "merged" || saved.state === "blocked") {
      await TaskAuthority.appendEvent(database, saved.taskId, {
        eventId: `terminal:${saved.state}`,
        occurredAtEpochMs: Date.now(),
        data: { type: "task_terminal", state: saved.state },
      });
    }
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
}

function factEvent(
  prior: TaskResult,
  fact: TaskFact,
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
        },
      };
    case "review":
      return {
        eventId: `review:${prior.revision}`,
        occurredAtEpochMs,
        data: {
          type: "review_completed",
          sha: fact.review.sha,
          cycle: Math.max(1, prior.evidence.reviewCycles + 1),
          verdict: fact.review.verdict,
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
    case "blocked":
      return {
        eventId: `blocked:${prior.revision}`,
        occurredAtEpochMs,
        data: { type: "task_blocked", reason: blockerReason(fact.blocker) },
      };
  }
  return null;
}

type TaskBlockReason = Extract<TaskEventData, { type: "task_blocked" }>["reason"];

function blockerReason(blocker: string): TaskBlockReason {
  const normalized = blocker.toLowerCase();
  if (normalized.includes("elapsed budget")) return "elapsed_budget";
  if (normalized.includes("project check")) return "project_check_failure";
  if (normalized.includes("review inconclusive")) return "review_inconclusive";
  if (normalized.includes("delivery") || normalized.includes("forge")) return "delivery_failure";
  if (normalized.includes("provider") || normalized.includes("coding session"))
    return "provider_failure";
  if (normalized.includes("phase") || normalized.includes("evidence")) return "invalid_phase";
  return "unknown";
}
