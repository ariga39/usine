import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { TaskContract } from "./contract.js";
import { repositoryLeases, taskRuns } from "./schema.js";
import type { RuntimeDatabase } from "./sqlite-database.js";

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
  writer: { repository: string; repositoryIdentity: string };
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
  fence: number;
}

export interface TaskObservation {
  taskId: string;
  revision: number;
}

export type TaskFact =
  | { type: "candidate"; candidate: CandidateFact }
  | { type: "check"; check: CheckResult }
  | { type: "review"; review: ReviewVerdict }
  | { type: "delivery"; delivery: DeliveryEffect }
  | { type: "repair_batch" }
  | { type: "blocked"; blocker: string };

export interface AuthorityInput {
  contract: TaskContract;
  contractHash: string;
  repository: string;
  repositoryIdentity: string;
  deadlineEpochMs: number;
}

type AuthorityDatabase = RuntimeDatabase;

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

function requireExactSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("candidate SHA is not exact");
}

/**
 * Apply one authority-owned fact without persistence or database knowledge.
 * The persistence adapter supplies the durable revision and lease checks;
 * this reducer owns lifecycle legality and stale evidence invalidation.
 */
export function applyTaskFact(result: TaskResult, fact: TaskFact): TaskResult {
  switch (fact.type) {
    case "candidate": {
      if (!canTransition(result.state, "candidate"))
        throw new Error(`illegal task state transition: ${result.state} -> candidate`);
      if (
        fact.candidate.fence <= 0 ||
        !Number.isSafeInteger(fact.candidate.fence) ||
        fact.candidate.fence !== result.activeActivation
      )
        throw new Error("candidate fence is stale");
      if (result.candidateSha && fact.candidate.baseSha !== result.candidateSha)
        throw new Error("candidate base is stale");
      requireExactSha(fact.candidate.sha);
      return {
        ...result,
        state: "candidate",
        candidateSha: fact.candidate.sha,
        candidateFence: fact.candidate.fence,
        check: null,
        review: null,
        delivery: null,
        blocker: null,
        activeActivation: null,
      };
    }
    case "check": {
      if (!canTransition(result.state, "checked"))
        throw new Error(`illegal task state transition: ${result.state} -> checked`);
      if (!result.candidateSha || fact.check.sha !== result.candidateSha)
        throw new Error("check belongs to a stale candidate");
      requireExactSha(fact.check.sha);
      return { ...result, state: "checked", check: fact.check, review: null, delivery: null };
    }
    case "review": {
      if (!canTransition(result.state, "reviewed"))
        throw new Error(`illegal task state transition: ${result.state} -> reviewed`);
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        fact.review.sha !== result.candidateSha ||
        fact.review.sha !== result.check.sha
      )
        throw new Error("review belongs to a stale or unchecked candidate");
      requireExactSha(fact.review.sha);
      return {
        ...result,
        state: "reviewed",
        review: fact.review,
        delivery: null,
        evidence: { ...result.evidence, reviewCycles: result.evidence.reviewCycles + 1 },
      };
    }
    case "delivery": {
      if (!canTransition(result.state, "reviewed_pr"))
        throw new Error(`illegal task state transition: ${result.state} -> reviewed_pr`);
      if (
        !result.candidateSha ||
        !result.check ||
        result.check.status !== "passed" ||
        !result.review ||
        result.review.verdict !== "approved" ||
        fact.delivery.sha !== result.candidateSha ||
        fact.delivery.sha !== result.review.sha
      )
        throw new Error("delivery is not bound to an exact approved candidate");
      requireExactSha(fact.delivery.sha);
      return { ...result, state: "reviewed_pr", delivery: fact.delivery };
    }
    case "repair_batch":
      if (result.state !== "reviewed" || result.review?.verdict !== "changes_requested")
        throw new Error("review repair batch is not current");
      return {
        ...result,
        evidence: {
          ...result.evidence,
          changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
        },
      };
    case "blocked":
      if (!canTransition(result.state, "blocked"))
        throw new Error(`illegal task state transition: ${result.state} -> blocked`);
      return { ...result, state: "blocked", blocker: fact.blocker };
  }
  throw new Error("unknown task fact");
}

export function hashTaskContract(rawContract: string): string {
  return createHash("sha256").update(rawContract).digest("hex");
}

export class TaskAuthority {
  constructor(private readonly database: AuthorityDatabase) {}

  async lookupExisting(taskId: string, contractHash: string): Promise<TaskResult | null> {
    const row = await this.database.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, taskId),
    });
    if (!row) return null;
    const result = TaskAuthority.withDurableFields(row.result as TaskResult);
    if (result.contractHash !== contractHash) throw new Error("admitted contract is immutable");
    return result;
  }

  private static async currentTask(database: AuthorityDatabase, taskId: string) {
    return database.query.taskRuns.findFirst({ where: eq(taskRuns.taskId, taskId) });
  }

  private static existingAdmission(
    row: typeof taskRuns.$inferSelect,
    input: AuthorityInput,
  ): TaskResult {
    const result = TaskAuthority.withDurableFields(row.result as TaskResult);
    if (result.contractHash !== input.contractHash)
      throw new Error("admitted contract is immutable");
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
        result,
      });
      return result;
    };
    return this.inTransaction(admit);
  }

  private async persistFact(observation: TaskObservation, fact: TaskFact): Promise<TaskResult> {
    const persist = async (database: AuthorityDatabase): Promise<TaskResult> => {
      const current = await TaskAuthority.currentTask(database, observation.taskId);
      if (!current) throw new Error("task is not admitted");
      const prior = TaskAuthority.withDurableFields(current.result as TaskResult);
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
      const prior = TaskAuthority.withDurableFields(current.result as TaskResult);
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

  private static withDurableFields(result: TaskResult): TaskResult {
    return {
      ...result,
      revision: Number.isSafeInteger(result.revision) ? result.revision : 0,
    };
  }
}
