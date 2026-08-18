import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TaskContract } from "./contract.js";
import { repositoryLeases, taskRuns } from "./schema.js";

export type TaskState =
  | "admitted"
  | "candidate"
  | "checked"
  | "reviewed"
  | "reviewed_pr"
  | "blocked";

export interface CheckResult {
  sha: string;
  status: "passed" | "failed";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReviewVerdict {
  sha: string;
  verdict: "approved" | "changes_requested" | "inconclusive";
  summary: string;
  findings: string[];
}

export interface DeliveryEffect {
  sha: string;
  effect: "github";
  prNumber: number;
  url: string;
  attestationId: string;
}

export interface TaskResult {
  taskId: string;
  contractHash: string;
  /** Durable compare-and-set identity for this observation. */
  revision: number;
  /** The first admission deadline, reused for every recovery. */
  deadlineEpochMs: number;
  state: TaskState;
  candidateSha: string | null;
  candidateFence: number | null;
  check: CheckResult | null;
  review: ReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: string | null;
  activeActivation: number | null;
  writer: { repository: string; repositoryIdentity: string; generation: number };
  evidence: {
    implementerActivations: number;
    reviewCycles: number;
    changesRequestedBatches: number;
    restartRecoveries: number;
  };
}

export interface CandidateFact {
  sha: string;
  baseSha: string;
  generation: number;
  fence: number;
}

export interface AuthorityInput {
  contract: TaskContract;
  contractHash: string;
  repository: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
}

type AuthorityDatabase = NodePgDatabase<{
  repositoryLeases: typeof repositoryLeases;
  taskRuns: typeof taskRuns;
}>;

const transitions: Record<TaskState, readonly TaskState[]> = {
  admitted: ["admitted", "candidate", "blocked"],
  candidate: ["candidate", "checked", "blocked"],
  checked: ["checked", "candidate", "reviewed", "blocked"],
  reviewed: ["reviewed", "candidate", "reviewed_pr", "blocked"],
  reviewed_pr: ["reviewed_pr"],
  blocked: ["blocked"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to);
}

export function hashTaskContract(rawContract: string): string {
  return createHash("sha256").update(rawContract).digest("hex");
}

export class TaskAuthority {
  constructor(private readonly database: AuthorityDatabase) {}

  private static async currentTask(database: AuthorityDatabase, taskId: string) {
    if (typeof database.select === "function") {
      const rows = await database
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.taskId, taskId))
        .for("update");
      return rows[0];
    }
    return database.query.taskRuns.findFirst({ where: eq(taskRuns.taskId, taskId) });
  }

  private static existingAdmission(
    row: typeof taskRuns.$inferSelect,
    input: AuthorityInput,
  ): TaskResult {
    if (row.contractHash !== input.contractHash) throw new Error("admitted contract is immutable");
    const result = TaskAuthority.withDurableFields(row.result as TaskResult, row.deadlineAt);
    if (result.writer.repositoryIdentity !== input.repositoryIdentity)
      throw new Error("task repository identity is immutable");
    return result;
  }

  async admit(input: AuthorityInput): Promise<TaskResult> {
    const admit = async (database: AuthorityDatabase): Promise<TaskResult> => {
      // The task row is immutable.  Lock it when it already exists so a
      // concurrent admission cannot observe a half-updated lifecycle.
      const existing = await TaskAuthority.currentTask(database, input.contract.id);
      if (existing) return TaskAuthority.existingAdmission(existing, input);

      const inserted = await database
        .insert(repositoryLeases)
        .values({
          repositoryIdentity: input.repositoryIdentity,
          taskId: input.contract.id,
          generation: 1,
        })
        .onConflictDoNothing()
        .returning();
      const lease = inserted[0];
      if (!lease) {
        // The lease's unique task ID serializes same-ID admissions. After the
        // conflict wait, the winning task is visible in this transaction.
        const winner = await TaskAuthority.currentTask(database, input.contract.id);
        if (winner) return TaskAuthority.existingAdmission(winner, input);
        const occupied = await database.query.repositoryLeases.findFirst({
          where: eq(repositoryLeases.repositoryIdentity, input.repositoryIdentity),
        });
        if (occupied?.taskId === input.contract.id)
          throw new Error("repository lease has no admitted task");
        throw new Error("repository already has an active writer");
      }

      const result: TaskResult = {
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
          repository: input.repository,
          repositoryIdentity: input.repositoryIdentity,
          generation: lease.generation,
        },
        evidence: {
          implementerActivations: 0,
          reviewCycles: 0,
          changesRequestedBatches: 0,
          restartRecoveries: 0,
        },
      };
      await database.insert(taskRuns).values({
        taskId: result.taskId,
        contractHash: result.contractHash,
        contract: input.contract,
        repository: input.repository,
        state: result.state,
        writerGeneration: lease.generation,
        deadlineAt: new Date(input.deadlineEpochMs),
        result,
      });
      return result;
    };
    const database = this.database as AuthorityDatabase & {
      transaction?: <T>(callback: (transaction: AuthorityDatabase) => Promise<T>) => Promise<T>;
    };
    return database.transaction ? database.transaction(admit) : admit(this.database);
  }

  async save(result: TaskResult): Promise<TaskResult> {
    const persist = async (database: AuthorityDatabase): Promise<TaskResult> => {
      const current = await TaskAuthority.currentTask(database, result.taskId);
      if (!current) throw new Error("task is not admitted");
      if (current.contractHash !== result.contractHash)
        throw new Error("admitted contract is immutable");
      const prior = TaskAuthority.withDurableFields(
        current.result as TaskResult,
        current.deadlineAt,
      );
      if (result.revision !== prior.revision) throw new Error("stale task revision");
      const lease = await database.query.repositoryLeases.findFirst({
        where: eq(repositoryLeases.repositoryIdentity, result.writer.repositoryIdentity),
      });
      if (!lease || lease.taskId !== result.taskId || lease.generation !== result.writer.generation)
        throw new Error("repository writer lease is stale");
      if (
        result.candidateFence !== null &&
        result.candidateFence < prior.evidence.implementerActivations &&
        result.candidateSha !== prior.candidateSha
      )
        throw new Error("stale candidate observation");
      if (!canTransition(prior.state, result.state)) {
        throw new Error(`illegal task state transition: ${prior.state} -> ${result.state}`);
      }
      const saved: TaskResult = {
        ...result,
        revision: prior.revision + 1,
        deadlineEpochMs: prior.deadlineEpochMs,
      };
      await database
        .update(taskRuns)
        .set({ state: saved.state, result: saved, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, result.taskId));
      if (saved.state === "reviewed_pr" || saved.state === "blocked") {
        await database
          .delete(repositoryLeases)
          .where(
            and(
              eq(repositoryLeases.repositoryIdentity, result.writer.repositoryIdentity),
              eq(repositoryLeases.taskId, result.taskId),
              eq(repositoryLeases.generation, result.writer.generation),
            ),
          );
      }
      return saved;
    };
    const database = this.database as AuthorityDatabase & {
      transaction?: <T>(callback: (transaction: AuthorityDatabase) => Promise<T>) => Promise<T>;
    };
    return database.transaction ? database.transaction(persist) : persist(this.database);
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
      const prior = TaskAuthority.withDurableFields(
        current.result as TaskResult,
        current.deadlineAt,
      );
      if (prior.state === "reviewed_pr" || prior.state === "blocked")
        throw new Error("task is terminal");
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
        .set({ state: result.state, result, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, taskId));
      return { result, activation };
    };
    const database = this.database as AuthorityDatabase & {
      transaction?: <T>(callback: (transaction: AuthorityDatabase) => Promise<T>) => Promise<T>;
    };
    return database.transaction ? database.transaction(reserve) : reserve(this.database);
  }

  private static withDurableFields(result: TaskResult, deadlineAt: Date): TaskResult {
    const persistedDeadline =
      deadlineAt instanceof Date ? deadlineAt.getTime() : result.deadlineEpochMs;
    return {
      ...result,
      revision: Number.isSafeInteger(result.revision) ? result.revision : 0,
      deadlineEpochMs: persistedDeadline ?? Date.now(),
    };
  }

  acceptCandidate(result: TaskResult, fact: CandidateFact): void {
    if (fact.generation !== result.writer.generation)
      throw new Error("candidate belongs to a stale writer generation");
    if (
      fact.fence <= 0 ||
      !Number.isSafeInteger(fact.fence) ||
      fact.fence !== result.evidence.implementerActivations
    ) {
      throw new Error("candidate fence is stale");
    }
    // A candidate may descend from the contract base or the prior candidate used for repair.
    // The workspace adapter proves ancestry; authority only rejects a stale repair parent.
    if (result.candidateSha && fact.baseSha !== result.candidateSha) {
      throw new Error("candidate base is stale");
    }
    if (!/^[0-9a-f]{40}$/.test(fact.sha)) throw new Error("candidate SHA is not exact");
  }
}
