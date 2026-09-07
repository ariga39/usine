import { constants } from "node:fs";
import { access, lstat, mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  applyMigrations,
  contractIssues,
  hashTaskContract,
  openSqliteDatabase,
  resolveTaskContract,
  repositoryIdentity,
  TaskAuthority,
  TaskIdCursorError,
  type TaskContract,
  type TaskExecutionInput,
  type RepositoryRegistration,
  type RepositorySnapshot,
  type RepositoryResource,
  type ResolvedTaskContract,
  type TaskEvent,
  type TaskListPage,
  type TaskListPageRequest,
  type TaskResult,
  deriveUsageReport,
  MAX_USAGE_REPORT_PAGE_SIZE,
  type UsageReportPage,
  type UsageReportPageRequest,
  type UsageReportScope,
  taskContractSchema,
  type ServerHealth,
  type ServerSnapshot,
  type TaskObservationEventInput,
  isTerminalState,
  isWaitingState,
} from "@usine/task-authority";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import {
  CodexCodingSession,
  codingSessionAdapterSelectionEnvironment,
  explicitWorkerEnvironment,
  type CodingSessionMcpServerResolution,
  type CodingSessionObservation,
} from "@usine/coding-session";
import { executeDeliveryRun, type DeliveryRunInput } from "@usine/delivery-run";
import {
  ForgeDelivery,
  startGithubReadMcpHttp,
  type ForgePolicy,
  type GithubReadMcpHttpHandle,
  type GithubReadRole,
} from "@usine/forge-delivery";
import { QualityGate, type ReviewAttemptObservation } from "@usine/quality-gate";
import { readCommittedContract, verifyCommittedContract } from "./verify-committed-contract.js";
import {
  sessionArchiveOptionsFromEnvironment,
  stateDirectoryFromEnvironment,
  type RuntimePolicy,
} from "./runtime-policy.js";
import { deadlineExpired, remainingUntil } from "@usine/task-authority";
import { ensurePrivateStateDatabase, ensurePrivateStateDirectory } from "./private-state.js";

export {
  lookupCampaignEvidence,
  CampaignEvidenceCursorError,
  MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
  type CampaignEvidenceRequest,
} from "./campaign-evidence.js";

/** Maximum UTF-8 bytes read from one submitted Task Contract file. */
export const MAX_TASK_CONTRACT_BYTES = 1_048_576;

/** Host-owned deadline for resolving one committed Task Contract object. */
const TASK_CONTRACT_INGESTION_TIMEOUT_MS = 30_000;

export class TaskContractInputError extends Error {
  readonly code = "validation";

  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }> = [],
  ) {
    super(message);
    this.name = "TaskContractInputError";
  }
}

export function parseTaskContract(rawContract: string): TaskContract {
  let input: unknown;
  try {
    input = JSON.parse(rawContract);
  } catch {
    throw new TaskContractInputError("task contract must be JSON", [
      { path: "", message: "contract input is unreadable or invalid JSON" },
    ]);
  }
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    const issues = contractIssues(parsed.error);
    throw new TaskContractInputError(`invalid task contract: ${JSON.stringify(issues)}`, issues);
  }
  return parsed.data;
}

export async function readTaskContract(
  contractPath: string,
): Promise<{ readonly rawContract: string; readonly contract: TaskContract }> {
  const rawContract = await readBoundedTaskContractFile(contractPath);
  return { rawContract, contract: parseTaskContract(rawContract) };
}

async function readBoundedTaskContractFile(contractPath: string): Promise<string> {
  let file: FileHandle | undefined;
  try {
    const source = await lstat(contractPath);
    if (!source.isFile()) throw new TaskContractInputError("task contract must be a regular file");

    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const nonBlocking = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
    file = await open(contractPath, constants.O_RDONLY | noFollow | nonBlocking);
    const opened = await file.stat();
    if (!opened.isFile()) throw new TaskContractInputError("task contract must be a regular file");
    if (opened.size > MAX_TASK_CONTRACT_BYTES)
      throw new TaskContractInputError(
        `task contract exceeds the ${MAX_TASK_CONTRACT_BYTES}-byte limit`,
      );

    const bytes = Buffer.allocUnsafe(MAX_TASK_CONTRACT_BYTES);
    let length = 0;
    while (length < MAX_TASK_CONTRACT_BYTES) {
      const read = await file.read(bytes, length, MAX_TASK_CONTRACT_BYTES - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if ((await file.stat()).size > MAX_TASK_CONTRACT_BYTES)
      throw new TaskContractInputError(
        `task contract exceeds the ${MAX_TASK_CONTRACT_BYTES}-byte limit`,
      );
    return bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    if (error instanceof TaskContractInputError) throw error;
    throw new TaskContractInputError("task contract is unreadable");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export {
  runtimePolicyFromEnvironment,
  forgePolicyFromEnvironment,
  githubReadPolicyFromEnvironment,
  ForgeProfileResolutionError,
  type ForgeProfileErrorCode,
  stateDirectoryFromEnvironment,
  sessionArchiveOptionsFromEnvironment,
  type RuntimePolicy,
  type GithubReadPolicy,
} from "./runtime-policy.js";
export { resolveCodexProfile, validateCodexProfile } from "@usine/coding-session";
export {
  codingSessionAdapterForProfile,
  codingSessionAdapterProfilesFromEnvironment,
  CodingSessionAdapterConfigurationError,
  normalizeCodingSessionAdapterProfiles,
  type CodingSessionAdapterName,
  type CodingSessionAdapterProfiles,
} from "@usine/coding-session";
export type { TaskExecutionInput } from "@usine/task-authority";
export type { ReviewAttemptObservation } from "@usine/quality-gate";
export {
  CampaignContentConflictError,
  CampaignHandoffError,
  GoalContractInputError,
  lookupCampaign,
  handoffCampaign,
  checkpointCampaign,
  CampaignCheckpointError,
  abandonCampaign,
  CampaignAbandonmentError,
  CampaignStateQuarantinedError,
  isCampaignStateQuarantinedError,
  readGoalContract,
  proposeCampaign,
} from "./campaign.js";
export type { CampaignResource, GoalContract } from "@usine/task-authority";
export {
  createCampaignOutcomeAssessor,
  type CampaignAssessmentRequest,
  type CampaignAssessmentDraft,
  type CampaignOutcomeAssessor,
} from "./campaign-assessor.js";
export type {
  CampaignReplacementDraft,
  CampaignReplacementGenerator,
  CampaignReplacementRequest,
  CampaignReplacementRepository,
} from "./campaign-replacement.js";
export * from "./http-api.js";
export {
  cleanupSessionArchives,
  exportSessionArchive,
  listSessionArchives,
  readSessionArchive,
  readSessionArchiveManifest,
  SessionArchiveError,
  type SessionArchive,
  type SessionArchiveCleanupSelection,
  type SessionArchiveManifest,
} from "@usine/coding-session";

export interface ReviewerQualityGateInput {
  readonly contract: ResolvedTaskContract;
  readonly candidateSha: string;
  readonly check: import("@usine/task-authority").CheckResult;
  readonly profile: string;
  readonly repository: RepositorySnapshot;
  readonly environment: NodeJS.ProcessEnv;
  readonly deadlineEpochMs: number;
  readonly cycle: number;
  readonly signal?: AbortSignal;
  readonly onObservation?: (observation: CodingSessionObservation) => Promise<void> | void;
}

export async function reviewCandidateWithProfile(
  input: ReviewerQualityGateInput,
): Promise<ReviewAttemptObservation> {
  const stateDirectory = stateDirectoryFromEnvironment(input.environment);
  await ensurePrivateStateDirectory(stateDirectory);
  const workspace = new CandidateWorkspace({
    repository: input.repository.path,
    stateDirectory,
    deadlineEpochMs: input.deadlineEpochMs,
    credentialFreeGit: credentialFreeGitEnvironment(input.environment),
    gitAuthor: input.repository.gitAuthor,
    signal: input.signal,
  });
  const session = new CodexCodingSession(undefined, {
    environment: explicitWorkerEnvironment(input.environment),
    adapterSelectionEnvironment: codingSessionAdapterSelectionEnvironment(input.environment),
    openCode2StateDirectory: stateDirectory,
    sessionArchive: sessionArchiveOptionsFromEnvironment(input.environment, stateDirectory),
  });
  return new QualityGate({
    workspace,
    session,
    reviewer: { role: "reviewer", profile: input.profile, sandbox: "read-only" },
    environment: explicitWorkerEnvironment(input.environment),
    deadlineEpochMs: input.deadlineEpochMs,
    signal: input.signal,
  }).reviewWithObservation(
    input.contract,
    input.candidateSha,
    input.check,
    input.cycle,
    input.onObservation,
  );
}

export async function registerRepository(
  stateDirectory: string,
  registration: RepositoryRegistration,
): Promise<RepositorySnapshot> {
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
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
  registration: RepositoryRegistration,
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

export async function lookupTaskPage(
  stateDirectory: string,
  request: TaskListPageRequest,
): Promise<TaskListPage> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (request.cursor !== null) throw new TaskIdCursorError();
      return { tasks: [], cursor: request.cursor, nextCursor: null };
    }
    throw error;
  }

  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).listTaskPage(request);
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

export async function lookupUsageReport(
  stateDirectory: string,
  scope: UsageReportScope,
  request: UsageReportPageRequest = { cursor: null, limit: MAX_USAGE_REPORT_PAGE_SIZE },
): Promise<UsageReportPage> {
  const empty = (): UsageReportPage => ({
    schemaVersion: 1,
    scope,
    cursor: request.cursor,
    nextCursor: null,
    coverage: "complete",
    invocations: [],
    aggregates: [],
  });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const page = await new TaskAuthority(handle.database).listUsageReportSources(scope, request);
    const report = deriveUsageReport(page.sources, scope);
    return {
      ...report,
      cursor: page.cursor,
      nextCursor: page.nextCursor,
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

export async function lookupTaskExecution(
  stateDirectory: string,
  taskId: string,
): Promise<{ result: TaskResult; input: TaskExecutionInput } | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    return await new TaskAuthority(handle.database).lookupExecution(taskId);
  } finally {
    handle.close();
  }
}

export async function retryTask(
  stateDirectory: string,
  taskId: string,
  budget: number,
  onEvent?: (event: TaskEvent) => void,
): Promise<TaskResult> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  try {
    return await new TaskAuthority(handle.database, { onEvent }).retryTask(taskId, budget);
  } finally {
    handle.close();
  }
}

export async function recordRecoveryObservation(
  stateDirectory: string,
  taskId: string,
  kind: "server_restart",
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
  provisionalContract: TaskContract,
  suppliedPolicy: RuntimePolicy,
  activeTaskCapacity?: number,
  onEvent?: (event: TaskEvent) => void,
): Promise<{ result: TaskResult; input: TaskExecutionInput; contract: TaskContract }> {
  const policy = suppliedPolicy;
  const stateDirectory = policy.stateDirectory;
  await mkdir(stateDirectory, { recursive: true });
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  await applyMigrations(databasePath);
  const handle = openSqliteDatabase(databasePath);
  const database = handle.database;
  const authority = new TaskAuthority(database, { onEvent });
  try {
    const registeredRepository = await authority.lookupRepository(provisionalContract.repositoryId);
    if (!registeredRepository)
      throw new Error(`repository is not registered: ${provisionalContract.repositoryId}`);
    const readDeadlineEpochMs = Date.now() + TASK_CONTRACT_INGESTION_TIMEOUT_MS;
    const committed = await readCommittedContract(
      contractPath,
      registeredRepository.path,
      readDeadlineEpochMs,
      policy.credentialFreeGitEnvironment,
      MAX_TASK_CONTRACT_BYTES,
    );
    const contract = parseTaskContract(committed.rawContract);
    if (contract.campaign)
      throw new Error("Campaign Tasks are admitted by the Campaign coordinator");
    if (contract.repositoryId !== provisionalContract.repositoryId)
      throw new Error(
        "committed task contract repository ID does not match the submitted contract",
      );
    const contractHash = hashTaskContract(committed.rawContract);
    const existing = await authority.lookupExisting(contract.id, contractHash);
    const repository = existing?.repository ?? registeredRepository;
    const resolvedContract = resolveTaskContract(contract, repository);
    const writerIdentity = repositoryIdentity(repository.owner, repository.name);
    const deadlineEpochMs = existing?.deadlineEpochMs ?? Date.now() + contract.budget.maxElapsedMs;
    const input = { contractPath, rawContract: committed.rawContract };
    if (existing && isTerminalState(existing.state)) return { result: existing, input, contract };
    const blockExpiredExisting = async (): Promise<TaskResult> => {
      if (!existing) throw new Error("cannot expire a task before admission");
      const blocked = await authority.block(
        { taskId: existing.taskId, revision: existing.revision },
        "elapsed budget exhausted",
      );
      return blocked;
    };
    if (existing && deadlineExpired(deadlineEpochMs))
      return { result: await blockExpiredExisting(), input, contract };
    try {
      await verifyCommittedContract(
        committed,
        resolvedContract,
        deadlineEpochMs,
        policy.credentialFreeGitEnvironment,
      );
    } catch (error) {
      if (existing && deadlineExpired(deadlineEpochMs))
        return { result: await blockExpiredExisting(), input, contract };
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
      input,
      activeTaskCapacity,
    );
    if (deadlineExpired(admitted.deadlineEpochMs)) {
      const blocked = await authority.block(
        { taskId: admitted.taskId, revision: admitted.revision },
        "elapsed budget exhausted",
      );
      return { result: blocked, input, contract };
    }
    return { result: admitted, input, contract };
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
  executionOwnerId?: string,
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
    if (
      isTerminalState(existing.state) ||
      (isWaitingState(existing.state) && existing.waiting?.reason !== "review_interruption")
    )
      return existing;
    if (hashTaskContract(input.rawContract) !== existing.contractHash)
      throw new Error("persisted task contract bytes do not match admission");
    if (!existing.repository) throw new Error("admitted task has no repository snapshot");
    const resolvedContract = resolveTaskContract(contract, existing.repository);
    const forgePolicy = policy.forge;
    if (input.contractPath !== null) {
      const committed = await readCommittedContract(
        input.contractPath,
        existing.repository.path,
        existing.deadlineEpochMs,
        policy.credentialFreeGitEnvironment,
        MAX_TASK_CONTRACT_BYTES,
      );
      if (committed.rawContract !== input.rawContract)
        throw new Error("persisted task contract bytes do not match the committed contract");
      await verifyCommittedContract(
        committed,
        resolvedContract,
        existing.deadlineEpochMs,
        policy.credentialFreeGitEnvironment,
      );
    }
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
      executionOwnerId,
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
  executionOwnerId?: string;
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
    executionOwnerId,
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
    adapterSelectionEnvironment: policy.adapterSelectionEnvironment,
    codexPathOverride: policy.codexPathOverride,
    openCode2StateDirectory: policy.stateDirectory,
    roleOutputTransform: policy.roleOutputTransform,
    sessionArchive: policy.sessionArchive,
    mcpServerFactory: async (request): Promise<CodingSessionMcpServerResolution> => {
      const readPolicy = policy.githubRead;
      if (request.role === "assessor" || request.role === "replacement-planner")
        return { serverName: `github_read_${request.role}`, status: "unavailable" };
      const role: GithubReadRole = request.role;
      const serverName = `github_read_${role}`;
      if (!readPolicy || contract.delivery.issue === undefined)
        return { serverName, status: "unavailable", reason: "unavailable" };
      const issueNumber = contract.delivery.issue;

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
          issueNumber,
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
    executionOwnerId,
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
