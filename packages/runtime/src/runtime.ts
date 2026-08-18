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
import { CodexCodingSession } from "./coding-session.js";
import { executeDeliveryRun, type DeliveryRunInput } from "./delivery-run.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { verifyCommittedContract } from "./verify-committed-contract.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import { deadlineExpired } from "@usine/task-authority";

export { executeDeliveryRun } from "./delivery-run.js";

export {
  capabilityEnvironments,
  explicitWorkerEnvironment,
  forgeGitEnvironment,
  runtimePolicyFromEnvironment,
  type CapabilityEnvironments,
  type ForgePolicy,
  type GitAuthor,
  type RolePolicy,
  type RuntimePolicy,
} from "./runtime-policy.js";

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
        policy.capabilities.credentialFreeGit,
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
      credentialFreeGit: policy.capabilities.credentialFreeGit,
      gitAuthor: policy.gitAuthor,
    });
    const session = new CodexCodingSession();
    const quality = new QualityGate({
      workspace,
      session,
      reviewer: policy.roles.reviewer,
      environment: policy.capabilities,
      deadlineEpochMs: persistedDeadlineEpochMs,
    });
    const forge = new ForgeDelivery({
      repository,
      deadlineEpochMs: persistedDeadlineEpochMs,
      forge: policy.forge,
      environment: policy.capabilities,
    });
    const workflowInput: DeliveryRunInput = {
      contract,
      contractHash,
      repository,
      repositoryIdentity,
      deadlineEpochMs: persistedDeadlineEpochMs,
      implementer: policy.roles.implementer,
      environments: policy.capabilities,
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
