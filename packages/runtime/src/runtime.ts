import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { TaskContract } from "./contract.js";
import { applyMigrations } from "./apply-migrations.js";
import { CandidateWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { executeDeliveryRun, writeTaskResult, type DeliveryRunInput } from "./delivery-run.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { repositoryLeases, taskRuns } from "./schema.js";
import { TaskAuthority, hashTaskContract, type TaskResult } from "./task-authority.js";
import { verifyCommittedContract } from "./verify-committed-contract.js";

export type {
  CheckResult,
  DeliveryEffect,
  ReviewVerdict,
  TaskResult,
  TaskState,
} from "./task-authority.js";

export async function admitTask(
  contractPath: string,
  rawContract: string,
  contract: TaskContract,
): Promise<TaskResult> {
  const databaseUrl = process.env.USINE_DATABASE_URL;
  if (!databaseUrl) throw new Error("USINE_DATABASE_URL is required");
  await applyMigrations(databaseUrl);
  const stateDirectory = process.env.USINE_STATE_DIR ?? ".usine";
  const contractHash = hashTaskContract(rawContract);
  const repositoryIdentity =
    `${contract.repository.owner}/${contract.repository.name}`.toLowerCase();
  const pool = new Pool({ connectionString: databaseUrl });
  const database = drizzle(pool, { schema: { repositoryLeases, taskRuns } });
  const authority = new TaskAuthority(database);
  try {
    const existing = await authority.lookupExisting(contract.id, contractHash);
    const deadlineEpochMs = existing?.deadlineEpochMs ?? Date.now() + contract.budget.maxElapsedMs;
    if (existing?.state === "reviewed_pr" || existing?.state === "blocked") {
      await writeTaskResult(stateDirectory, existing);
      return existing;
    }
    const blockExpiredExisting = async (): Promise<TaskResult> => {
      if (!existing) throw new Error("cannot expire a task before admission");
      const blocked = await authority.save({
        ...existing,
        state: "blocked",
        blocker: "elapsed budget exhausted",
      });
      await writeTaskResult(stateDirectory, blocked);
      return blocked;
    };
    if (existing && Date.now() >= deadlineEpochMs) return await blockExpiredExisting();
    let repository: string;
    try {
      repository = await verifyCommittedContract(contractPath, contract, deadlineEpochMs);
    } catch (error) {
      if (existing && Date.now() >= deadlineEpochMs) return await blockExpiredExisting();
      throw error;
    }
    // Admission is the single source of the first deadline.  On recovery this
    // reads task_runs.deadline_at instead of extending the budget in process.
    const admitted = await authority.admit({
      contract,
      contractHash,
      repository,
      repositoryIdentity,
      deadlineEpochMs,
    });
    const persistedDeadlineEpochMs = admitted.deadlineEpochMs;
    const workspace = new CandidateWorkspace({
      repository,
      stateDirectory,
      deadlineEpochMs: persistedDeadlineEpochMs,
    });
    const session = new CodexCodingSession();
    const quality = new QualityGate({
      workspace,
      session,
      reviewerModel: process.env.USINE_REVIEWER_MODEL ?? "gpt-5.6-sol",
      reviewerReasoningEffort: process.env.USINE_REVIEWER_REASONING_EFFORT ?? "low",
      deadlineEpochMs: persistedDeadlineEpochMs,
    });
    const forge = new ForgeDelivery({ repository, deadlineEpochMs: persistedDeadlineEpochMs });
    const workflowInput: DeliveryRunInput = {
      contract,
      contractHash,
      repository,
      repositoryIdentity,
      deadlineEpochMs: persistedDeadlineEpochMs,
      implementerModel: process.env.USINE_IMPLEMENTER_MODEL ?? "gpt-5.6-luna",
      stopAfterAdmitted: process.env.USINE_STOP_AFTER === "admitted",
    };
    const result = await executeDeliveryRun(workflowInput, {
      authority,
      workspace,
      session,
      quality,
      forge,
    });
    await writeTaskResult(stateDirectory, result);
    return result;
  } finally {
    await pool.end();
  }
}
