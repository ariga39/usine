import { and, desc, eq, sql } from "drizzle-orm";
import {
  repositories,
  repositoryLeases,
  taskHistory,
  taskQuarantines,
  taskRuns,
} from "./schema.js";
import type { RuntimeDatabase } from "./sqlite-database.js";
import {
  decodePersistedTaskResult,
  decodeRawPersistedTaskResult,
  decodeTaskHistoryRecord,
  TaskStateQuarantinedError,
  TASK_RESULT_SCHEMA_VERSION,
} from "./task-state-schema.js";
import {
  applyTaskFact,
  type AuthorityInput,
  type CandidateFact,
  type CheckResult,
  type DeliveryEffect,
  type ReviewVerdict,
  type TaskFact,
  type TaskObservation,
  type TaskExecutionInput,
  type TaskHistoryRecord,
  type TaskHistoryRecordInput,
  type TaskResult,
  type TaskStatus,
} from "./task-state.js";
import {
  snapshotFromRegistration,
  taskSnapshotFromRegistration,
  type RepositoryRegistration,
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
  TaskHistoryRecord,
  TaskHistoryRecordInput,
  TaskHistoryTokenUsage,
  TaskObservation,
  TaskResult,
  TaskStatus,
} from "./task-state.js";
export type {
  RepositoryRegistration,
  RepositorySnapshot,
  TaskRepositorySnapshot,
} from "./repository.js";

type AuthorityDatabase = RuntimeDatabase;

const MAX_HISTORY_LIMIT = 100;

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
          projectCheck: {
            command: row.projectCheckCommand,
            timeoutMs: row.projectCheckTimeoutMs,
          },
          gitAuthor: { name: row.gitAuthorName, email: row.gitAuthorEmail },
        }
      : null;
  }

  async lookup(taskId: string): Promise<TaskResult | null> {
    const rows = await this.database
      .select({ rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .limit(1);
    const row = rows[0];
    if (row) return decodeRawPersistedTaskResult(row.rawResult);
    const quarantined = await this.database
      .select({ taskId: taskQuarantines.taskId })
      .from(taskQuarantines)
      .where(eq(taskQuarantines.taskId, taskId))
      .limit(1);
    if (quarantined[0]) throw new TaskStateQuarantinedError();
    return null;
  }

  async lookupExisting(taskId: string, contractHash: string): Promise<TaskResult | null> {
    const result = await this.lookup(taskId);
    if (!result) return null;
    if (result.contractHash !== contractHash) throw new Error("admitted contract is immutable");
    return result;
  }

  async appendHistory(input: TaskHistoryRecordInput): Promise<TaskHistoryRecord> {
    const append = async (database: AuthorityDatabase): Promise<TaskHistoryRecord> => {
      const current = await TaskAuthority.currentTask(database, input.taskId);
      if (!current) throw new Error("task is not admitted");
      const inserted = await database
        .insert(taskHistory)
        .values({
          taskId: input.taskId,
          kind: input.kind,
          activation: input.activation,
          cycle: input.cycle,
          role: input.role,
          profile: input.profile,
          observedModel: input.observedModel,
          observedProvider: input.observedProvider,
          executionOwner: input.executionOwner ?? null,
          previousExecutionOwner: input.previousExecutionOwner ?? null,
          startedAtEpochMs: input.startedAtEpochMs,
          endedAtEpochMs: input.endedAtEpochMs,
          outcome: input.outcome,
          failure: input.failure,
          candidateSha: input.candidateSha,
          candidateFence: input.candidateFence,
          tokenUsage: input.tokenUsage,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("history record was not persisted");
      return decodeTaskHistoryRecord(row);
    };
    return this.inTransaction(append);
  }

  async listHistory(taskId: string, limit = MAX_HISTORY_LIMIT): Promise<TaskHistoryRecord[]> {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_HISTORY_LIMIT);
    const rows = await this.database
      .select()
      .from(taskHistory)
      .where(eq(taskHistory.taskId, taskId))
      .orderBy(desc(taskHistory.id))
      .limit(boundedLimit);
    return rows.reverse().map(decodeTaskHistoryRecord);
  }

  async lookupStatus(taskId: string, limit = MAX_HISTORY_LIMIT): Promise<TaskStatus | null> {
    const result = await this.lookup(taskId);
    if (!result) return null;
    return { ...result, history: await this.listHistory(taskId, limit) };
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
      if (result.state === "reviewed_pr" || result.state === "blocked") continue;
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
      if (saved.state === "reviewed_pr" || saved.state === "blocked") {
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
      if (prior.state === "reviewed_pr" || prior.state === "blocked")
        throw new Error("task is terminal");
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
}
