import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyMigrations,
  hashTaskContract,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskResult,
} from "@usine/task-authority";
import { CandidateWorkspace } from "@usine/candidate-workspace";
import { CodexCodingSession } from "@usine/coding-session";
import { executeDeliveryRun, type DeliveryRunInput } from "@usine/delivery-run";
import { ForgeDelivery } from "@usine/forge-delivery";
import { QualityGate } from "@usine/quality-gate";
import { verifyCommittedContract } from "./verify-committed-contract.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import { deadlineExpired } from "@usine/task-authority";

export { executeDeliveryRun } from "@usine/delivery-run";

export { runtimePolicyFromEnvironment, type RuntimePolicy } from "./runtime-policy.js";
export { forgeGitEnvironment } from "@usine/forge-delivery";
export type { ForgePolicy } from "@usine/forge-delivery";
export type { GitAuthor } from "@usine/candidate-workspace";
export { explicitWorkerEnvironment } from "@usine/coding-session";

export type {
  CheckResult,
  DeliveryEffect,
  ReviewVerdict,
  TaskResult,
  TaskState,
} from "@usine/task-authority";

export async function admitTask(
  contractPath: string,
  rawContract: string,
  contract: TaskContract,
  suppliedPolicy: RuntimePolicy,
): Promise<TaskResult> {
  const policy = suppliedPolicy;
  const stateDirectory = policy.stateDirectory;
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const contractHash = hashTaskContract(rawContract);
  const repositoryIdentity =
    `${contract.repository.owner}/${contract.repository.name}`.toLowerCase();
  const handle = openSqliteDatabase(databasePath);
  const database = handle.database;
  const authority = new TaskAuthority(database);
  try {
    const existing = await authority.lookupExisting(contract.id, contractHash);
    const deadlineEpochMs = existing?.deadlineEpochMs ?? Date.now() + contract.budget.maxElapsedMs;
    if (existing?.state === "reviewed_pr" || existing?.state === "blocked") return existing;
    const blockExpiredExisting = async (): Promise<TaskResult> => {
      if (!existing) throw new Error("cannot expire a task before admission");
      const blocked = await authority.block(
        { taskId: existing.taskId, revision: existing.revision },
        "elapsed budget exhausted",
      );
      return blocked;
    };
    if (existing && deadlineExpired(deadlineEpochMs)) return await blockExpiredExisting();
    let repository: string;
    try {
      repository = await verifyCommittedContract(
        contractPath,
        contract,
        deadlineEpochMs,
        policy.credentialFreeGitEnvironment,
      );
    } catch (error) {
      if (existing && deadlineExpired(deadlineEpochMs)) return await blockExpiredExisting();
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
    if (policy.stopAfterAdmitted) return admitted;
    if (!policy.forge) throw new Error("GitHub App credentials are required");
    const workspace = new CandidateWorkspace({
      repository,
      stateDirectory,
      deadlineEpochMs: persistedDeadlineEpochMs,
      credentialFreeGit: policy.credentialFreeGitEnvironment,
      gitAuthor: policy.gitAuthor,
    });
    const session = new CodexCodingSession(undefined, { environment: policy.workerEnvironment });
    const quality = new QualityGate({
      workspace,
      session,
      reviewer: policy.roles.reviewer,
      checkEnvironment: policy.checkEnvironment,
      reviewerEnvironment: policy.workerEnvironment,
      deadlineEpochMs: persistedDeadlineEpochMs,
    });
    const forge = new ForgeDelivery({
      repository,
      deadlineEpochMs: persistedDeadlineEpochMs,
      forge: policy.forge,
      environment: policy.credentialFreeGitEnvironment,
    });
    const workflowInput: DeliveryRunInput = {
      contract,
      contractHash,
      repository,
      repositoryIdentity,
      deadlineEpochMs: persistedDeadlineEpochMs,
      implementer: policy.roles.implementer,
    };
    const result = await executeDeliveryRun(workflowInput, {
      authority,
      workspace,
      session,
      quality,
      forge,
    });
    return result;
  } finally {
    handle.close();
  }
}
