import { access, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  type RepositoryResource,
  type ResolvedTaskContract,
  type TaskEvent,
  type TaskListItem,
  type TaskResult,
  type ServerHealth,
  type ServerSnapshot,
  type TaskObservationEventInput,
  isTerminalState,
} from "@usine/task-authority";
import { CandidateWorkspace } from "@usine/candidate-workspace";
import {
  CodexCodingSession,
  codexAppServerProfilesFromEnvironment,
  type CodingSessionCleanup,
  type CodingSessionMcpServerResolution,
} from "@usine/coding-session";
import { executeDeliveryRun, type DeliveryRunInput } from "@usine/delivery-run";
import {
  ForgeDelivery,
  startGithubReadMcpHttp,
  type ForgePolicy,
  type GithubReadMcpHttpHandle,
  type GithubReadRole,
} from "@usine/forge-delivery";
import { QualityGate } from "@usine/quality-gate";
import { verifyCommittedContract } from "./verify-committed-contract.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import { deadlineExpired, remainingUntil } from "@usine/task-authority";

export {
  runtimePolicyFromEnvironment,
  forgePolicyFromEnvironment,
  githubReadPolicyFromEnvironment,
  ForgeProfileResolutionError,
  type ForgeProfileErrorCode,
  stateDirectoryFromEnvironment,
  type RuntimePolicy,
  type GithubReadPolicy,
} from "./runtime-policy.js";
export type { TaskExecutionInput } from "@usine/task-authority";
export * from "./http-api.js";

export function createRuntimeCodingSession(environment: NodeJS.ProcessEnv): CodingSessionCleanup {
  return new CodexCodingSession(undefined, {
    environment,
    appServerProfiles: codexAppServerProfilesFromEnvironment(environment),
  });
}

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

export async function inspectRepositoryResource(
  stateDirectory: string,
  repositoryId: string,
): Promise<RepositoryResource | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).lookupRepositoryResource(repositoryId);
  } finally {
    handle.close();
  }
}

export async function lookupRepositories(
  stateDirectory: string,
  limit = 100,
): Promise<RepositoryResource[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).listRepositories(limit);
  } finally {
    handle.close();
  }
}

export async function registerRepositoryResource(
  stateDirectory: string,
  registration: RepositorySnapshot,
): Promise<RepositoryResource> {
  await registerRepository(stateDirectory, registration);
  const resource = await inspectRepositoryResource(stateDirectory, registration.id);
  if (!resource) throw new Error("registered repository is missing");
  return resource;
}

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

export async function lookupTasks(stateDirectory: string, limit = 100): Promise<TaskListItem[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).listTasks(limit);
  } finally {
    handle.close();
  }
}

export async function lookupServerSnapshot(
  stateDirectory: string,
  limit = 100,
): Promise<ServerSnapshot> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: 1,
        revision: 0,
        server: { status: "ok", revision: 0 },
        repositories: [],
        tasks: [],
        codingSessions: [],
      };
    }
    throw error;
  }

  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).readServerSnapshot(limit);
  } finally {
    handle.close();
  }
}

export async function lookupServerHealth(stateDirectory: string): Promise<ServerHealth> {
  return (await lookupServerSnapshot(stateDirectory, 200)).server;
}

export async function lookupTaskEvents(
  stateDirectory: string,
  taskId: string,
  afterSequence = 0,
  limit = 200,
): Promise<{ taskId: string; events: TaskEvent[]; nextSequence: number } | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const authority = new TaskAuthority(handle.database);
    if (!(await authority.lookup(taskId))) return null;
    const events = await authority.listEvents(taskId, afterSequence, limit);
    return {
      taskId,
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
    };
  } finally {
    handle.close();
  }
}

export async function lookupRestartableTasks(stateDirectory: string): Promise<{
  restartable: Array<{ result: TaskResult; input: TaskExecutionInput }>;
  activeTaskCount: number;
}> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { restartable: [], activeTaskCount: 0 };
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).listRestartable();
  } finally {
    handle.close();
  }
}

export async function recordRecoveryObservation(
  stateDirectory: string,
  taskId: string,
  kind: "server_restart" | "execution_owner_changed",
  onEvent?: (event: TaskEvent) => void,
): Promise<void> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    const input: TaskObservationEventInput = {
      eventId: `recovery:${kind}:${randomUUID()}`,
      occurredAtEpochMs: Date.now(),
      data: { type: "recovery_observed", kind },
    };
    await new TaskAuthority(handle.database, { onEvent }).appendObservation(taskId, input);
  } finally {
    handle.close();
  }
}

export async function admitTask(
  contractPath: string,
  rawContract: string,
  contract: TaskContract,
  suppliedPolicy: RuntimePolicy,
  activeTaskCapacity?: number,
  onEvent?: (event: TaskEvent) => void,
): Promise<TaskResult> {
  const policy = suppliedPolicy;
  const stateDirectory = policy.stateDirectory;
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const contractHash = hashTaskContract(rawContract);
  const handle = openSqliteDatabase(databasePath);
  const database = handle.database;
  const authority = new TaskAuthority(database, { onEvent });
  try {
    const existing = await authority.lookupExisting(contract.id, contractHash);
    const registeredRepository = await authority.lookupRepository(contract.repositoryId);
    const repository = existing?.repository ?? registeredRepository;
    if (!repository) throw new Error(`repository is not registered: ${contract.repositoryId}`);
    if (!registeredRepository)
      throw new Error(`repository is not registered: ${contract.repositoryId}`);
    const resolvedContract = resolveTaskContract(contract, repository);
    const writerIdentity = repositoryIdentity(repository.owner, repository.name);
    const deadlineEpochMs = existing?.deadlineEpochMs ?? Date.now() + contract.budget.maxElapsedMs;
    if (existing && isTerminalState(existing.state)) return existing;
    const blockExpiredExisting = async (): Promise<TaskResult> => {
      if (!existing) throw new Error("cannot expire a task before admission");
      const blocked = await authority.block(
        { taskId: existing.taskId, revision: existing.revision },
        "elapsed budget exhausted",
      );
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
        repository: existing
          ? { ...registeredRepository, ...existing.repository }
          : registeredRepository,
        repositoryIdentity: writerIdentity,
        deadlineEpochMs,
      },
      { contractPath, rawContract },
      activeTaskCapacity,
    );
    if (deadlineExpired(admitted.deadlineEpochMs)) {
      const blocked = await authority.block(
        { taskId: admitted.taskId, revision: admitted.revision },
        "elapsed budget exhausted",
      );
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
  signal?: AbortSignal,
  onEvent?: (event: TaskEvent) => void,
): Promise<TaskResult> {
  if (signal?.aborted) throw new Error("task execution was aborted");
  const policy = suppliedPolicy;
  const stateDirectory = policy.stateDirectory;
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const handle = openSqliteDatabase(databasePath);
  const database = handle.database;
  const authority = new TaskAuthority(database, { onEvent });
  try {
    const existing = await authority.lookup(contract.id);
    if (!existing) throw new Error("task is not admitted");
    if (isTerminalState(existing.state)) return existing;
    if (hashTaskContract(input.rawContract) !== existing.contractHash)
      throw new Error("persisted task contract bytes do not match admission");
    if (!existing.repository) throw new Error("admitted task has no repository snapshot");
    const resolvedContract = resolveTaskContract(contract, existing.repository);
    const forgePolicy = policy.forge;
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
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const current = await authority.lookup(contract.id);
    if (current && !isTerminalState(current.state)) {
      const blocker = error instanceof Error ? error.message : String(error);
      const blocked = await authority.block(
        { taskId: current.taskId, revision: current.revision },
        blocker,
      );
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
  forgePolicy: ForgePolicy;
  authority: TaskAuthority;
  deadlineEpochMs: number;
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
    appServerProfiles: policy.appServerProfiles,
    roleOutputTransform: policy.roleOutputTransform,
    mcpServerFactory: async (request): Promise<CodingSessionMcpServerResolution> => {
      const readPolicy = policy.githubRead;
      const role: GithubReadRole = request.role;
      const serverName = `github_read_${role}`;
      if (!readPolicy) return { serverName, status: "unavailable", reason: "unavailable" };

      const tools = role === "implementer" ? readPolicy.implementerTools : readPolicy.reviewerTools;
      const existing = githubReadHandles.get(role);
      if (existing)
        return {
          serverName,
          status: "available",
          server: githubReadServerConfig(serverName, existing.url, tools, deadlineEpochMs),
        };
      try {
        const handle = await startGithubReadMcpHttp({
          repository: { owner: contract.repository.owner, name: contract.repository.name },
          issueNumber: contract.delivery.issue,
          role,
          tools,
          policy: readPolicy.policy,
          deadlineEpochMs,
          signal: options.signal,
          requestTimeoutMs: Math.min(10_000, remainingUntil(deadlineEpochMs)),
        });
        githubReadHandles.set(role, handle);
        return {
          serverName,
          status: "available",
          server: githubReadServerConfig(serverName, handle.url, tools, deadlineEpochMs),
        };
      } catch {
        return { serverName, status: "unavailable", reason: "unavailable" };
      }
    },
  });
  const githubReadHandles = new Map<GithubReadRole, GithubReadMcpHttpHandle>();
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
  try {
    return await executeDeliveryRun(workflowInput, {
      authority,
      workspace,
      session,
      quality,
      forge,
    });
  } finally {
    await Promise.allSettled([...githubReadHandles.values()].map((handle) => handle.close()));
  }
}

function githubReadServerConfig(
  name: string,
  url: string,
  enabledTools: readonly string[],
  deadlineEpochMs: number,
) {
  const remaining = remainingUntil(deadlineEpochMs);
  return {
    name,
    url,
    enabledTools,
    startupTimeoutMs: Math.min(5_000, remaining),
    toolTimeoutMs: Math.min(10_000, remaining),
    required: false,
  };
}

export {
  startUsineServer,
  TaskCapacityStartupError,
  type RunningUsineServer,
  type ServerExecutionContext,
  type TaskSubmission,
  type ServerExecution,
  type UsineServerOptions,
} from "./server.js";
