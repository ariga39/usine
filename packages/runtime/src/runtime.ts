import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyMigrations,
  hashTaskContract,
  openSqliteDatabase,
  resolveTaskContract,
  repositoryIdentity,
  TaskAuthority,
  type TaskContract,
  type TaskExecutionInput,
  type RepositorySnapshot,
  type ResolvedTaskContract,
  type TaskProgress,
  type TaskResult,
  type TaskStatus,
  type TaskHistoryKind,
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

export async function registerRepository(
  stateDirectory: string,
  registration: RepositorySnapshot,
): Promise<RepositorySnapshot> {
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const handle = openSqliteDatabase(databasePath);
  try {
    return await new TaskAuthority(handle.database).registerRepository(registration);
  } finally {
    handle.close();
  }
}

export async function inspectRepository(
  stateDirectory: string,
  repositoryId: string,
): Promise<RepositorySnapshot | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).lookupRepository(repositoryId);
  } finally {
    handle.close();
  }
}

export async function lookupTaskStatus(
  stateDirectory: string,
  taskId: string,
): Promise<TaskStatus | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).lookupStatus(taskId);
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

export async function recordExecutionObservation(
  stateDirectory: string,
  result: TaskResult,
  kind: Extract<TaskHistoryKind, "coordinator_restart" | "execution_owner_change">,
  executionOwner: string,
  previousExecutionOwner: string,
): Promise<void> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    const now = Date.now();
    await new TaskAuthority(handle.database).appendHistory({
      taskId: result.taskId,
      kind,
      activation: result.activeActivation,
      cycle: result.evidence.reviewCycles || null,
      role: "coordinator",
      model: null,
      executionOwner,
      previousExecutionOwner,
      startedAtEpochMs: now,
      endedAtEpochMs: now,
      outcome: "observed",
      failure: null,
      candidateSha: result.candidateSha,
      candidateFence: result.candidateFence,
      tokenUsage: null,
    });
  } finally {
    handle.close();
  }
}

export async function admitTask(
  contractPath: string,
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
    const repository = await authority.lookupRepository(contract.repositoryId);
    if (!repository) throw new Error(`repository is not registered: ${contract.repositoryId}`);
    const resolvedContract = resolveTaskContract(contract, repository);
    const writerIdentity = repositoryIdentity(repository.owner, repository.name);
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
    try {
      await verifyCommittedContract(
        contractPath,
        repository.path,
        resolvedContract,
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
        repository: repository,
        repositoryIdentity: writerIdentity,
        deadlineEpochMs,
      },
      { contractPath, rawContract },
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
    if (!existing.repository) throw new Error("admitted task has no repository snapshot");
    const resolvedContract = resolveTaskContract(contract, existing.repository);
    const forgePolicy = policy.forge;
    if (!forgePolicy) throw new Error("GitHub App credentials are required");
    await verifyCommittedContract(
      input.contractPath,
      existing.repository.path,
      resolvedContract,
      existing.deadlineEpochMs,
      policy.credentialFreeGitEnvironment,
    );
    return await executeWithServices({
      contract: resolvedContract,
      contractHash: existing.contractHash,
      repositoryIdentity: existing.writer.repositoryIdentity,
      repository: existing.repository.path,
      gitAuthor: existing.repository.gitAuthor,
      policy,
      forgePolicy,
      authority,
      deadlineEpochMs: existing.deadlineEpochMs,
      onProgress,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
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
  contract: ResolvedTaskContract;
  contractHash: string;
  repositoryIdentity: string;
  repository: string;
  gitAuthor: RepositorySnapshot["gitAuthor"];
  policy: RuntimePolicy;
  forgePolicy: NonNullable<RuntimePolicy["forge"]>;
  authority: TaskAuthority;
  deadlineEpochMs: number;
  onProgress?: (progress: TaskProgress) => void;
  signal?: AbortSignal;
}): Promise<TaskResult> {
  const {
    contract,
    contractHash,
    repositoryIdentity,
    repository,
    gitAuthor,
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
    gitAuthor,
    signal: options.signal,
  });
  const session = new CodexCodingSession(undefined, {
    environment: policy.workerEnvironment,
    executionStateDirectory: policy.stateDirectory,
  });
  const quality = new QualityGate({
    workspace,
    session,
    reviewer: policy.roles.reviewer,
    environment: policy.workerEnvironment,
    deadlineEpochMs,
    signal: options.signal,
  });
  const forge = new ForgeDelivery({
    repository,
    deadlineEpochMs,
    forge: forgePolicy,
    environment: policy.credentialFreeGitEnvironment,
    signal: options.signal,
  });
  const workflowInput: DeliveryRunInput = {
    contract,
    contractHash,
    repositoryIdentity,
    deadlineEpochMs,
    implementer: policy.roles.implementer,
    reviewer: policy.roles.reviewer,
    signal: options.signal,
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
