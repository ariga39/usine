import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyMigrations,
  hashTaskContract,
  openSqliteDatabase,
  TaskAuthority,
  type TaskContract,
  type TaskExecutionInput,
  type TaskProgress,
  type TaskResult,
  taskProgressFromResult,
} from "@usine/task-authority";
import { CandidateWorkspace } from "@usine/candidate-workspace";
import { CodexCodingSession } from "@usine/coding-session";
import { executeDeliveryRun, type DeliveryRunInput } from "@usine/delivery-run";
import { ForgeDelivery } from "@usine/forge-delivery";
import { QualityGate } from "@usine/quality-gate";
import { verifyCommittedContract } from "./verify-committed-contract.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import { deadlineExpired } from "@usine/task-authority";

export {
  runtimePolicyFromEnvironment,
  stateDirectoryFromEnvironment,
  type RuntimePolicy,
} from "./runtime-policy.js";
export type { TaskExecutionInput } from "@usine/task-authority";

export async function lookupTaskStatus(
  stateDirectory: string,
  taskId: string,
): Promise<TaskResult | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).lookup(taskId);
  } finally {
    handle.close();
  }
}

export async function lookupRestartableTasks(
  stateDirectory: string,
): Promise<Array<{ result: TaskResult; input: TaskExecutionInput }>> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).listRestartable();
  } finally {
    handle.close();
  }
}

export async function admitTask(
  contractPath: string,
  repositoryPath: string,
  rawContract: string,
  contract: TaskContract,
  suppliedPolicy: RuntimePolicy,
  onProgress?: (progress: TaskProgress) => void,
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
    const reportProgress = (result: TaskResult): void => {
      try {
        onProgress?.(taskProgressFromResult(result));
      } catch {
        // Progress is an observation only; a failed sink cannot alter authority.
      }
    };
    const existing = await authority.lookupExisting(contract.id, contractHash);
    const deadlineEpochMs = existing?.deadlineEpochMs ?? Date.now() + contract.budget.maxElapsedMs;
    if (existing?.state === "reviewed_pr" || existing?.state === "blocked") return existing;
    const blockExpiredExisting = async (): Promise<TaskResult> => {
      if (!existing) throw new Error("cannot expire a task before admission");
      const blocked = await authority.block(
        { taskId: existing.taskId, revision: existing.revision },
        "elapsed budget exhausted",
      );
      reportProgress(blocked);
      return blocked;
    };
    if (existing && deadlineExpired(deadlineEpochMs)) return await blockExpiredExisting();
    let repository: string;
    try {
      repository = await verifyCommittedContract(
        contractPath,
        repositoryPath,
        contract,
        deadlineEpochMs,
        policy.credentialFreeGitEnvironment,
      );
    } catch (error) {
      if (existing && deadlineExpired(deadlineEpochMs)) return await blockExpiredExisting();
      throw error;
    }
    // Admission is the single source of the first deadline.  On recovery this
    // reads the durable result deadline instead of extending the budget in process.
    const admitted = await authority.admit(
      {
        contract,
        contractHash,
        repositoryIdentity,
        deadlineEpochMs,
      },
      { contractPath, repositoryPath, rawContract },
    );
    reportProgress(admitted);
    if (deadlineExpired(admitted.deadlineEpochMs)) {
      const blocked = await authority.block(
        { taskId: admitted.taskId, revision: admitted.revision },
        "elapsed budget exhausted",
      );
      reportProgress(blocked);
      return blocked;
    }
    return admitted;
  } finally {
    handle.close();
  }
}

export async function executeAdmittedTask(
  input: TaskExecutionInput,
  contract: TaskContract,
  suppliedPolicy: RuntimePolicy,
  onProgress?: (progress: TaskProgress) => void,
  signal?: AbortSignal,
): Promise<TaskResult> {
  if (signal?.aborted) throw new Error("task execution was aborted");
  const policy = suppliedPolicy;
  const stateDirectory = policy.stateDirectory;
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const handle = openSqliteDatabase(databasePath);
  const database = handle.database;
  const authority = new TaskAuthority(database);
  try {
    const existing = await authority.lookup(contract.id);
    if (!existing) throw new Error("task is not admitted");
    if (existing.state === "reviewed_pr" || existing.state === "blocked") return existing;
    if (hashTaskContract(input.rawContract) !== existing.contractHash)
      throw new Error("persisted task contract bytes do not match admission");
    const forgePolicy = policy.forge;
    if (!forgePolicy) throw new Error("GitHub App credentials are required");
    const repository = await verifyCommittedContract(
      input.contractPath,
      input.repositoryPath,
      contract,
      existing.deadlineEpochMs,
      policy.credentialFreeGitEnvironment,
    );
    return await executeWithServices({
      contract,
      contractHash: existing.contractHash,
      repositoryIdentity: existing.writer.repositoryIdentity,
      repository,
      policy,
      forgePolicy,
      authority,
      deadlineEpochMs: existing.deadlineEpochMs,
      onProgress,
    });
  } catch (error) {
    const current = await authority.lookup(contract.id);
    if (current && current.state !== "reviewed_pr" && current.state !== "blocked") {
      const blocker = error instanceof Error ? error.message : String(error);
      const blocked = await authority.block(
        { taskId: current.taskId, revision: current.revision },
        blocker,
      );
      try {
        onProgress?.(taskProgressFromResult(blocked));
      } catch {
        // Progress is an observation only; a failed sink cannot alter authority.
      }
      return blocked;
    }
    throw error;
  } finally {
    handle.close();
  }
}

async function executeWithServices(options: {
  contract: TaskContract;
  contractHash: string;
  repositoryIdentity: string;
  repository: string;
  policy: RuntimePolicy;
  forgePolicy: NonNullable<RuntimePolicy["forge"]>;
  authority: TaskAuthority;
  deadlineEpochMs: number;
  onProgress?: (progress: TaskProgress) => void;
}): Promise<TaskResult> {
  const {
    contract,
    contractHash,
    repositoryIdentity,
    repository,
    policy,
    forgePolicy,
    authority,
    deadlineEpochMs,
    onProgress,
  } = options;
  const workspace = new CandidateWorkspace({
    repository,
    stateDirectory: policy.stateDirectory,
    deadlineEpochMs,
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
    deadlineEpochMs,
  });
  const forge = new ForgeDelivery({
    repository,
    deadlineEpochMs,
    forge: forgePolicy,
    environment: policy.credentialFreeGitEnvironment,
  });
  const workflowInput: DeliveryRunInput = {
    contract,
    contractHash,
    repositoryIdentity,
    deadlineEpochMs,
    implementer: policy.roles.implementer,
  };
  return executeDeliveryRun(workflowInput, {
    authority,
    workspace,
    session,
    quality,
    forge,
    onProgress,
  });
}

export {
  startUsineServer,
  type RunningUsineServer,
  type ServerExecutionContext,
  type TaskSubmission,
  type ServerExecution,
  type UsineServerOptions,
} from "./server.js";
