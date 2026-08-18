import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TaskContract } from "./contract.js";
import { repositoryLeases, taskRuns } from "./schema.js";

export type TaskState = "admitted" | "candidate" | "checked" | "reviewed" | "reviewed_pr" | "blocked";

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
  state: TaskState;
  candidateSha: string | null;
  check: CheckResult | null;
  review: ReviewVerdict | null;
  delivery: DeliveryEffect | null;
  blocker: string | null;
  writer: { repository: string; repositoryIdentity: string; generation: number };
  evidence: {
    workflowId: string;
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
  checked: ["checked", "reviewed", "blocked"],
  reviewed: ["reviewed", "candidate", "reviewed_pr", "blocked"],
  reviewed_pr: ["reviewed_pr"],
  blocked: ["blocked"],
};

export function hashTaskContract(rawContract: string): string {
  return createHash("sha256").update(rawContract).digest("hex");
}

export class TaskAuthority {
  constructor(private readonly database: AuthorityDatabase) {}

  async admit(input: AuthorityInput): Promise<TaskResult> {
    const existing = await this.database.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, input.contract.id),
    });
    if (existing) {
      if (existing.contractHash !== input.contractHash) throw new Error("admitted contract is immutable");
      return existing.result as TaskResult;
    }

    const inserted = await this.database
      .insert(repositoryLeases)
      .values({ repositoryIdentity: input.repositoryIdentity, taskId: input.contract.id, generation: 1 })
      .onConflictDoNothing()
      .returning();
    const lease =
      inserted[0] ??
      (await this.database.query.repositoryLeases.findFirst({
        where: and(
          eq(repositoryLeases.repositoryIdentity, input.repositoryIdentity),
          eq(repositoryLeases.taskId, input.contract.id),
        ),
      }));
    if (!lease) throw new Error("repository already has an active writer");

    const result: TaskResult = {
      taskId: input.contract.id,
      contractHash: input.contractHash,
      state: "admitted",
      candidateSha: null,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      writer: {
        repository: input.repository,
        repositoryIdentity: input.repositoryIdentity,
        generation: lease.generation,
      },
      evidence: {
        workflowId: input.contract.id,
        implementerActivations: 0,
        reviewCycles: 0,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    await this.database.insert(taskRuns).values({
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
  }

  async save(result: TaskResult): Promise<TaskResult> {
    const current = await this.database.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, result.taskId),
    });
    if (!current) throw new Error("task is not admitted");
    if (current.contractHash !== result.contractHash) throw new Error("admitted contract is immutable");
    const prior = current.result as TaskResult;
    if (!transitions[prior.state].includes(result.state)) {
      throw new Error(`illegal task state transition: ${prior.state} -> ${result.state}`);
    }
    await this.database
      .update(taskRuns)
      .set({ state: result.state, result, updatedAt: new Date() })
      .where(eq(taskRuns.taskId, result.taskId));
    return result;
  }

  acceptCandidate(result: TaskResult, fact: CandidateFact): void {
    if (fact.generation !== result.writer.generation) throw new Error("candidate belongs to a stale writer generation");
    if (fact.fence <= 0 || !Number.isSafeInteger(fact.fence) || fact.fence !== result.evidence.implementerActivations) {
      throw new Error("candidate fence is stale");
    }
    // A candidate may descend from the contract base or the prior candidate used for repair.
    // The workspace adapter proves ancestry; authority only rejects a stale repair parent.
    if (result.candidateSha && fact.baseSha !== result.candidateSha) {
      throw new Error("candidate base is stale");
    }
    if (!/^[0-9a-f]{40}$/.test(fact.sha)) throw new Error("candidate SHA is not exact");
  }

  static invalidateEvidence(result: TaskResult, candidateSha: string): TaskResult {
    if (result.candidateSha !== candidateSha) return result;
    return { ...result, check: null, review: null, delivery: null, state: "candidate" };
  }
}
