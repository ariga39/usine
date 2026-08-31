import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  contractIssues,
  hashTaskContract,
  isTerminalState,
  isWaitingState,
  repositoryRegistrationSchema,
  taskContractSchema,
  type RepositorySnapshot,
  type TaskContract,
} from "@usine/task-authority";
import { resolveCodexProfile, validateCodexProfile } from "@usine/runtime";
import { CliFailure, runCommand } from "./cli-failure.js";
import {
  followTask,
  inspectRepository,
  registerRepository,
  submitTask,
  retryTask,
  taskEvidence,
  taskStatus,
} from "./server-client.js";
import { jsonFlag } from "./cli-parameters.js";

const execFile = promisify(execFileCallback);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const exactSha = /^[0-9a-f]{40}$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const changedFactors = ["model_stack", "reasoning", "developer_instructions"] as const;
const usineSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type ProfileEvaluationChangedFactor = (typeof changedFactors)[number];

export interface ProfileEvaluationPair {
  readonly id: string;
  readonly repetition: number;
  readonly baselineContractPath: string;
  readonly candidateContractPath: string;
}

export interface ProfileEvaluationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly subjectRole: "implementer";
  readonly changedFactor: ProfileEvaluationChangedFactor;
  readonly baselineProfile: string;
  readonly candidateProfile: string;
  readonly reviewerProfile: string;
  readonly maxTasks: number;
  readonly usineBuild: string;
  readonly reportPath: string;
  readonly registrationPath: string;
  readonly pairs: readonly ProfileEvaluationPair[];
}

export interface EvaluationTaskReport {
  readonly id: string;
  readonly pairId: string;
  readonly repetition: number;
  readonly taskId: string;
  readonly evidence: import("./task-evidence.js").TaskEvidence;
}

export interface EvaluationMetricSet {
  readonly implementerActivations: number | null;
  readonly repairBatches: number | null;
  readonly interruptions: number | null;
  readonly elapsedMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolFailures: number | null;
}

export interface ProfileEvaluationReport {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly repositoryId: string;
  readonly subjectRole: "implementer";
  readonly changedFactor: ProfileEvaluationChangedFactor;
  readonly usineBuild: string;
  readonly reportPath: string;
  readonly baseline: EvaluationProfileReport;
  readonly candidate: EvaluationProfileReport;
  readonly comparison: {
    readonly baseline: EvaluationMetricSet;
    readonly candidate: EvaluationMetricSet;
    readonly delta: EvaluationMetricSet;
  };
  readonly recommendation: "baseline" | "candidate" | "inconclusive";
  readonly inconclusiveReasons: readonly string[];
}

export interface EvaluationProfileReport {
  readonly profile: string;
  readonly tasks: readonly EvaluationTaskReport[];
  readonly correctness: "passed" | "failed" | "unknown";
  readonly metrics: EvaluationMetricSet;
}

export interface ProfileEvaluateOptions {
  readonly planPath: string;
  readonly subjectRole: string;
  readonly json: boolean;
  readonly signal?: AbortSignal;
}

export interface ProfileEvaluationServices {
  readonly inspectRepository: typeof inspectRepository;
  readonly registerRepository: typeof registerRepository;
  readonly submitTask: typeof submitTask;
  readonly taskStatus: typeof taskStatus;
  readonly followTask: typeof followTask;
  readonly retryTask: typeof retryTask;
  readonly taskEvidence: typeof taskEvidence;
}

const defaultServices: ProfileEvaluationServices = {
  inspectRepository,
  registerRepository,
  submitTask,
  taskStatus,
  followTask,
  retryTask,
  taskEvidence,
};

export class ProfileEvaluationValidationError extends Error {
  readonly code = "invalid_evaluation_plan";
  readonly kind = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProfileEvaluationValidationError";
  }
}

export class ProfileEvaluationRestorationError extends Error {
  readonly code = "evaluation_repository_restore_failed";
  readonly kind = "server" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProfileEvaluationRestorationError";
  }
}

export class ProfileEvaluationCleanupError extends Error {
  readonly code = "evaluation_task_cleanup_failed";
  readonly kind = "server" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProfileEvaluationCleanupError";
  }
}

export async function readProfileEvaluationPlan(
  planPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  plan: ProfileEvaluationPlan;
  contracts: readonly TaskContract[];
  registration: RepositorySnapshot;
  repositoryRoot: string;
  profileSelections: {
    readonly baseline: Awaited<ReturnType<typeof resolveProfile>>;
    readonly candidate: Awaited<ReturnType<typeof resolveProfile>>;
    readonly reviewer: Awaited<ReturnType<typeof resolveProfile>>;
  };
}> {
  const absolutePlanPath = await realpath(resolve(planPath)).catch(() => {
    throw new ProfileEvaluationValidationError("evaluation plan is unreadable");
  });
  const rawPlan = await readUtf8(absolutePlanPath, "evaluation plan");
  const plan = normalizePlan(parseJson(rawPlan, "evaluation plan"));
  validatePlanShape(plan);
  const repositoryRoot = await repositoryRootFor(absolutePlanPath);
  await requireCommittedFile(repositoryRoot, absolutePlanPath, "evaluation plan");
  if (!(await isAncestor(repositoryRoot, plan.baseSha)))
    throw new ProfileEvaluationValidationError(
      "plan baseSha is not an ancestor of the evaluation Repository",
    );
  if ((await readUsineSourceCommit()) !== plan.usineBuild)
    throw new ProfileEvaluationValidationError(
      "plan is bound to a different Usine source checkout commit",
    );

  const pairs = [...plan.pairs];
  const contracts: TaskContract[] = [];
  const taskIds = new Set<string>();
  const contractPaths = new Set<string>();
  const deliveryBranches = new Set<string>();
  const deliveryIssues = new Set<number>();
  for (const pair of pairs) {
    const baselinePath = resolveRepositoryFile(
      repositoryRoot,
      pair.baselineContractPath,
      "baseline contract",
    );
    const candidatePath = resolveRepositoryFile(
      repositoryRoot,
      pair.candidateContractPath,
      "candidate contract",
    );
    if (contractPaths.has(baselinePath) || contractPaths.has(candidatePath))
      throw new ProfileEvaluationValidationError(
        `${pair.id}:${pair.repetition}: contract files must be unique`,
      );
    contractPaths.add(baselinePath);
    contractPaths.add(candidatePath);
    await requireCommittedFile(repositoryRoot, baselinePath, "baseline contract");
    await requireCommittedFile(repositoryRoot, candidatePath, "candidate contract");
    const baseline = parseContract(
      await readUtf8(baselinePath, "baseline contract"),
      "baseline contract",
    );
    const candidate = parseContract(
      await readUtf8(candidatePath, "candidate contract"),
      "candidate contract",
    );
    validatePair(plan, pair, baseline, candidate);
    if (taskIds.has(baseline.id) || taskIds.has(candidate.id) || baseline.id === candidate.id)
      throw new ProfileEvaluationValidationError(
        `${pair.id}:${pair.repetition}: Task IDs must be unique`,
      );
    taskIds.add(baseline.id);
    taskIds.add(candidate.id);
    if (
      deliveryBranches.has(baseline.delivery.branch) ||
      deliveryBranches.has(candidate.delivery.branch) ||
      baseline.delivery.branch === candidate.delivery.branch ||
      deliveryIssues.has(baseline.delivery.issue) ||
      deliveryIssues.has(candidate.delivery.issue) ||
      baseline.delivery.issue === candidate.delivery.issue
    )
      throw new ProfileEvaluationValidationError(
        `${pair.id}:${pair.repetition}: Task delivery identities must be unique`,
      );
    deliveryBranches.add(baseline.delivery.branch);
    deliveryBranches.add(candidate.delivery.branch);
    deliveryIssues.add(baseline.delivery.issue);
    deliveryIssues.add(candidate.delivery.issue);
    contracts.push(baseline, candidate);
  }

  const registration = await readRestorationRegistration(plan, absolutePlanPath);
  await validateRegistration(plan, registration, repositoryRoot);
  const reportPath = resolveRepositoryFile(repositoryRoot, plan.reportPath, "report");
  const registrationPath = resolve(dirname(absolutePlanPath), plan.registrationPath);
  if (
    reportPath === absolutePlanPath ||
    contractPaths.has(reportPath) ||
    reportPath === registrationPath
  )
    throw new ProfileEvaluationValidationError(
      "report path must not replace the plan, registration, or a contract",
    );
  for (const contract of contracts) validateContractRepository(contract, registration);
  validateCodexProfile(registration.implementerProfile);
  validateCodexProfile(registration.reviewerProfile);
  const profileSelections = {
    baseline: await resolveProfile(plan.baselineProfile, environment),
    candidate: await resolveProfile(plan.candidateProfile, environment),
    reviewer: await resolveProfile(plan.reviewerProfile, environment),
  };
  validateProfileFactor(plan, profileSelections.baseline, profileSelections.candidate);
  return { plan, contracts, registration, repositoryRoot, profileSelections };
}

export function profileCommand(
  serverUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  services: ProfileEvaluationServices = defaultServices,
) {
  const evaluate = Command.make(
    "evaluate",
    {
      planPath: Argument.string("plan"),
      subjectRole: Flag.string("subject-role").pipe(Flag.withDefault("implementer")),
      json: jsonFlag(),
    },
    (options) =>
      Effect.promise(() =>
        withProfileEvaluationSignals((signal) =>
          runProfileEvaluateCommand(
            {
              planPath: options.planPath,
              subjectRole: options.subjectRole,
              json: options.json,
              signal,
            },
            serverUrl,
            environment,
            services,
          ),
        ),
      ),
  );
  return Command.make("profile").pipe(Command.withSubcommands([evaluate]));
}

export async function runProfileEvaluateCommand(
  options: ProfileEvaluateOptions,
  serverUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  services: ProfileEvaluationServices = defaultServices,
): Promise<void> {
  return runCommand("profile_evaluate_failed", async () => {
    if (options.subjectRole !== "implementer")
      throw new CliFailure("invalid_evaluation_subject_role", "validation", {
        subjectRole: options.subjectRole,
      });
    const loaded = await readProfileEvaluationPlan(options.planPath, environment);
    const current = await services.inspectRepository(serverUrl, loaded.plan.repositoryId);
    if (!current)
      throw new CliFailure("repository_not_found", "not_found", {
        repositoryId: loaded.plan.repositoryId,
      });
    if (
      current.owner.toLowerCase() !== loaded.registration.owner.toLowerCase() ||
      current.name.toLowerCase() !== loaded.registration.name.toLowerCase() ||
      current.baseBranch !== loaded.registration.baseBranch
    )
      throw new ProfileEvaluationValidationError(
        "plan registration does not match the registered Repository",
      );
    const report = await executeProfileEvaluation(loaded, serverUrl, options.signal, services);
    const reportJson = `${JSON.stringify(report)}\n`;
    await writeEvaluationReport(loaded, reportJson);
    process.stdout.write(options.json ? reportJson : renderReport(report));
  });
}

async function writeEvaluationReport(
  loaded: Awaited<ReturnType<typeof readProfileEvaluationPlan>>,
  report: string,
): Promise<void> {
  const path = resolve(loaded.repositoryRoot, loaded.plan.reportPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, report, "utf8");
}

export async function executeProfileEvaluation(
  loaded: Awaited<ReturnType<typeof readProfileEvaluationPlan>>,
  serverUrl: string,
  signal?: AbortSignal,
  services: ProfileEvaluationServices = defaultServices,
): Promise<ProfileEvaluationReport> {
  const { plan, registration } = loaded;
  const reports: Record<"baseline" | "candidate", EvaluationTaskReport[]> = {
    baseline: [],
    candidate: [],
  };
  const originalRegistration = {
    ...registration,
    projectCheck: { ...registration.projectCheck },
    gitAuthor: { ...registration.gitAuthor },
  };
  throwIfAborted(signal);
  const existingTasks = await preflightExistingTasks(loaded, serverUrl, services);
  let inFlightTask: { taskId: string; deadlineEpochMs: number } | undefined;
  let cleanupError: unknown;
  let primaryError: unknown;
  let failed = false;
  let contractIndex = 0;
  try {
    for (const pair of plan.pairs) {
      for (const side of ["baseline", "candidate"] as const) {
        throwIfAborted(signal);
        const contractPath =
          side === "baseline" ? pair.baselineContractPath : pair.candidateContractPath;
        const profile = side === "baseline" ? plan.baselineProfile : plan.candidateProfile;
        const contract = loaded.contracts[contractIndex++];
        if (!contract) throw new Error(`validated contract is missing for ${pair.id}`);
        let task = existingTasks.get(contract.id) ?? null;
        if (!task) {
          const evaluationRegistration = {
            ...originalRegistration,
            implementerProfile: profile,
            reviewerProfile: plan.reviewerProfile,
          };
          await services.registerRepository(serverUrl, evaluationRegistration);
          try {
            task = await services.submitTask(serverUrl, {
              contractPath: resolve(loaded.repositoryRoot, contractPath),
              repositoryId: plan.repositoryId,
            });
          } catch (error) {
            let observed: import("@usine/task-authority").TaskResource | null;
            try {
              observed = await services.taskStatus(serverUrl, contract.id);
            } catch (observationError) {
              cleanupError = new ProfileEvaluationCleanupError(
                `Task ${contract.id} admission could not be resolved safely; Repository restoration was not attempted`,
                {
                  cause: new AggregateError([error, observationError], "Task admission ambiguous"),
                },
              );
              throw new AggregateError(
                [error, observationError],
                `Task ${contract.id} admission could not be resolved`,
              );
            }
            if (observed) {
              try {
                await validateExistingTask(
                  observed,
                  contract,
                  resolve(loaded.repositoryRoot, contractPath),
                  loaded.registration,
                );
              } catch (observationError) {
                cleanupError = new ProfileEvaluationCleanupError(
                  `Task ${contract.id} admission identity could not be validated safely; Repository restoration was not attempted`,
                  {
                    cause: new AggregateError(
                      [error, observationError],
                      "Task admission ambiguous",
                    ),
                  },
                );
                throw new AggregateError(
                  [error, observationError],
                  `Task ${contract.id} admission identity could not be validated`,
                );
              }
              if (!isTerminalState(observed.state))
                inFlightTask = {
                  taskId: observed.taskId,
                  deadlineEpochMs: observed.deadlineEpochMs,
                };
            }
            throw error;
          }
        }
        if (!isTerminalState(task.state))
          inFlightTask = { taskId: task.taskId, deadlineEpochMs: task.deadlineEpochMs };
        if (!isTerminalState(task.state) && !isWaitingState(task.state))
          task = await services.followTask(serverUrl, task.taskId, {
            timeoutMs: contract.budget.maxElapsedMs,
            signal,
          });
        if (!isTerminalState(task.state) && !isWaitingState(task.state))
          throw new Error(`Task ${task.taskId} did not reach a durable stopping state`);
        if (task.state === "waiting")
          throw new Error(`Task ${task.taskId} is waiting for an explicit retry`);
        inFlightTask = undefined;
        const evidence = await services.taskEvidence(serverUrl, task.taskId);
        if (!evidence) throw new Error(`Task evidence is unavailable for ${task.taskId}`);
        throwIfAborted(signal);
        reports[side].push({
          id: `${pair.id}:${pair.repetition}:${side}`,
          pairId: pair.id,
          repetition: pair.repetition,
          taskId: task.taskId,
          evidence,
        });
      }
    }
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  if (failed && inFlightTask)
    try {
      await waitForTerminalTask(inFlightTask, serverUrl, services);
      inFlightTask = undefined;
    } catch (error) {
      cleanupError = error;
    }
  let restorationError: unknown;
  if (cleanupError === undefined)
    try {
      await services.registerRepository(serverUrl, originalRegistration);
    } catch (error) {
      restorationError = error;
    }
  if (failed && (cleanupError !== undefined || restorationError !== undefined)) {
    const primaryMessage = primaryError instanceof Error ? `: ${primaryError.message}` : "";
    const cause = new AggregateError(
      [
        primaryError,
        ...(cleanupError === undefined ? [] : [cleanupError]),
        ...(restorationError === undefined ? [] : [restorationError]),
      ],
      cleanupError === undefined
        ? `evaluation and Repository restoration failed${primaryMessage}`
        : `evaluation cleanup failed before Repository restoration${primaryMessage}`,
    );
    if (cleanupError !== undefined)
      throw new ProfileEvaluationCleanupError(cause.message, { cause });
    throw new ProfileEvaluationRestorationError(cause.message, { cause });
  }
  if (failed) throw primaryError;
  if (restorationError !== undefined) {
    const cause = new AggregateError(
      [restorationError],
      "evaluation Repository restoration failed",
    );
    throw new ProfileEvaluationRestorationError(cause.message, { cause });
  }
  return compareProfileEvaluation(plan, reports, {
    baseline: expectedEvidenceProfile(loaded.profileSelections.baseline),
    candidate: expectedEvidenceProfile(loaded.profileSelections.candidate),
    reviewer: expectedEvidenceProfile(loaded.profileSelections.reviewer),
  });
}

async function waitForTerminalTask(
  task: { taskId: string; deadlineEpochMs: number },
  serverUrl: string,
  services: ProfileEvaluationServices,
): Promise<void> {
  while (true) {
    let current = await cleanupTaskStatus(task, serverUrl, services, "during cleanup");
    if (isTerminalState(current.state)) return;
    if (isWaitingState(current.state)) return await expireWaitingTask(task, serverUrl, services);
    const remainingMs = task.deadlineEpochMs - Date.now();
    if (remainingMs <= 0)
      return await rereadAtCleanupDeadline(task, serverUrl, services, undefined);
    try {
      current = await services.followTask(serverUrl, task.taskId, {
        timeoutMs: Math.min(remainingMs, Math.max(0, current.deadlineEpochMs - Date.now())),
      });
    } catch (error) {
      let reread: import("@usine/task-authority").TaskResource;
      try {
        reread = await cleanupTaskStatus(
          task,
          serverUrl,
          services,
          "after cleanup observation failed",
        );
      } catch (statusError) {
        throw new ProfileEvaluationCleanupError(
          `Task ${task.taskId} could not be rechecked after cleanup observation failed; Repository restoration was not attempted`,
          { cause: new AggregateError([error, statusError], "cleanup observation failed") },
        );
      }
      if (isTerminalState(reread.state)) return;
      if (isWaitingState(reread.state)) return await expireWaitingTask(task, serverUrl, services);
      if (Date.now() >= task.deadlineEpochMs)
        throw new ProfileEvaluationCleanupError(
          `Task ${task.taskId} did not reach a terminal state at its cleanup deadline; Repository restoration was not attempted`,
          { cause: error },
        );
      await waitForCleanupInterval(task.deadlineEpochMs);
      continue;
    }
    if (isTerminalState(current.state)) return;
    if (isWaitingState(current.state)) return await expireWaitingTask(task, serverUrl, services);
    if (Date.now() >= task.deadlineEpochMs)
      return await rereadAtCleanupDeadline(task, serverUrl, services, undefined);
    await waitForCleanupInterval(task.deadlineEpochMs);
  }
}

async function rereadAtCleanupDeadline(
  task: { taskId: string; deadlineEpochMs: number },
  serverUrl: string,
  services: ProfileEvaluationServices,
  followError: unknown,
): Promise<void> {
  let current: import("@usine/task-authority").TaskResource;
  try {
    current = await cleanupTaskStatus(task, serverUrl, services, "at its cleanup deadline");
  } catch (error) {
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} could not be rechecked at its cleanup deadline; Repository restoration was not attempted`,
      {
        cause:
          followError === undefined
            ? error
            : new AggregateError([followError, error], "cleanup observation failed"),
      },
    );
  }
  if (isTerminalState(current.state)) return;
  if (isWaitingState(current.state)) return await expireWaitingTask(task, serverUrl, services);
  throw new ProfileEvaluationCleanupError(
    `Task ${task.taskId} did not reach a terminal state at its cleanup deadline; Repository restoration was not attempted`,
    { cause: followError },
  );
}

async function cleanupTaskStatus(
  task: { taskId: string },
  serverUrl: string,
  services: ProfileEvaluationServices,
  point: string,
): Promise<import("@usine/task-authority").TaskResource> {
  try {
    const current = await services.taskStatus(serverUrl, task.taskId);
    if (current) return current;
  } catch (error) {
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} could not be observed ${point}; Repository restoration was not attempted`,
      { cause: error },
    );
  }
  throw new ProfileEvaluationCleanupError(
    `Task ${task.taskId} disappeared ${point}; Repository restoration was not attempted`,
  );
}

async function waitForCleanupInterval(deadlineEpochMs: number): Promise<void> {
  await new Promise<void>((complete) =>
    setTimeout(complete, Math.min(100, Math.max(0, deadlineEpochMs - Date.now()))),
  );
}

async function expireWaitingTask(
  task: { taskId: string; deadlineEpochMs: number },
  serverUrl: string,
  services: ProfileEvaluationServices,
): Promise<void> {
  await waitUntilDeadline(task.deadlineEpochMs);
  let waiting: import("@usine/task-authority").TaskResource | null;
  try {
    waiting = await services.taskStatus(serverUrl, task.taskId);
  } catch (error) {
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} could not be rechecked at its waiting deadline; Repository restoration was not attempted`,
      { cause: error },
    );
  }
  if (!waiting)
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} disappeared at its waiting deadline; Repository restoration was not attempted`,
    );
  if (isTerminalState(waiting.state)) return;
  if (!isWaitingState(waiting.state))
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} changed to nonterminal state ${waiting.state} at its waiting deadline; Repository restoration was not attempted`,
    );
  let expired: import("@usine/task-authority").TaskResource;
  try {
    expired = await services.retryTask(serverUrl, task.taskId);
  } catch (error) {
    const latest = await services.taskStatus(serverUrl, task.taskId).catch(() => null);
    if (latest && isTerminalState(latest.state)) return;
    throw new ProfileEvaluationCleanupError(
      `Task ${task.taskId} could not be expired through its existing retry path; Repository restoration was not attempted`,
      { cause: error },
    );
  }
  if (isTerminalState(expired.state)) return;
  throw new ProfileEvaluationCleanupError(
    `Task ${task.taskId} did not become terminal when its waiting deadline expired; Repository restoration was not attempted`,
  );
}

async function waitUntilDeadline(deadlineEpochMs: number): Promise<void> {
  while (true) {
    const remainingMs = deadlineEpochMs - Date.now();
    if (remainingMs <= 0) return;
    await new Promise<void>((complete) => setTimeout(complete, Math.min(remainingMs, 60_000)));
  }
}

function withProfileEvaluationSignals<A>(action: (signal: AbortSignal) => Promise<A>): Promise<A> {
  const controller = new AbortController();
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const onSignal = (): void => {
    cleanup();
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return action(controller.signal).finally(cleanup);
  } catch (error) {
    cleanup();
    return Promise.reject(error);
  }
}

async function preflightExistingTasks(
  loaded: Awaited<ReturnType<typeof readProfileEvaluationPlan>>,
  serverUrl: string,
  services: ProfileEvaluationServices,
): Promise<Map<string, import("@usine/task-authority").TaskResource>> {
  const tasks = new Map<string, import("@usine/task-authority").TaskResource>();
  let contractIndex = 0;
  for (const pair of loaded.plan.pairs) {
    for (const side of ["baseline", "candidate"] as const) {
      const contractPath =
        side === "baseline" ? pair.baselineContractPath : pair.candidateContractPath;
      const contract = loaded.contracts[contractIndex++];
      if (!contract) throw new Error(`validated contract is missing for ${pair.id}`);
      const task = await services.taskStatus(serverUrl, contract.id);
      if (task) {
        await validateExistingTask(
          task,
          contract,
          resolve(loaded.repositoryRoot, contractPath),
          loaded.registration,
        );
        if (isWaitingState(task.state))
          throw new ProfileEvaluationValidationError(
            `${contract.id}: existing Task is waiting; explicit retry is required before evaluation`,
          );
        tasks.set(contract.id, task);
      }
    }
  }
  return tasks;
}

export function compareProfileEvaluation(
  plan: ProfileEvaluationPlan,
  reports: Record<"baseline" | "candidate", EvaluationTaskReport[]>,
  expectedProfiles?: {
    readonly baseline: ExpectedEvidenceProfile;
    readonly candidate: ExpectedEvidenceProfile;
    readonly reviewer: ExpectedEvidenceProfile;
  },
): ProfileEvaluationReport {
  const baseline = profileReport(
    plan.baselineProfile,
    plan.reviewerProfile,
    reports.baseline,
    expectedProfiles?.baseline,
    expectedProfiles?.reviewer,
  );
  const candidate = profileReport(
    plan.candidateProfile,
    plan.reviewerProfile,
    reports.candidate,
    expectedProfiles?.candidate,
    expectedProfiles?.reviewer,
  );
  const driftReasons = validateEvidenceDrift(plan, reports);
  const bothPassed = baseline.correctness === "passed" && candidate.correctness === "passed";
  const comparisonReasons = bothPassed
    ? comparisonEvidenceReasons(baseline.metrics, candidate.metrics)
    : [];
  const reasons = [
    ...new Set([...baseline.reasons, ...candidate.reasons, ...driftReasons, ...comparisonReasons]),
  ].toSorted();
  const nonGateReasons = reasons.filter((reason) => !reason.endsWith(":hard_correctness_gate"));
  const comparable = bothPassed && reasons.length === 0;
  const comparison = comparable
    ? {
        baseline: baseline.metrics,
        candidate: candidate.metrics,
        delta: metricDelta(baseline.metrics, candidate.metrics),
      }
    : {
        baseline: unknownMetrics(),
        candidate: unknownMetrics(),
        delta: unknownMetrics(),
      };
  let recommendation: ProfileEvaluationReport["recommendation"] = "inconclusive";
  if (
    nonGateReasons.length === 0 &&
    baseline.correctness === "passed" &&
    candidate.correctness === "failed"
  ) {
    recommendation = "baseline";
  } else if (
    nonGateReasons.length === 0 &&
    baseline.correctness === "failed" &&
    candidate.correctness === "passed"
  ) {
    recommendation = "candidate";
  } else if (comparable) {
    const candidateBetter = strictlyLessOrEqual(candidate.metrics, baseline.metrics);
    const baselineBetter = strictlyLessOrEqual(baseline.metrics, candidate.metrics);
    if (candidateBetter && !baselineBetter) recommendation = "candidate";
    else if (baselineBetter && !candidateBetter) recommendation = "baseline";
  }
  return {
    schemaVersion: 1,
    planId: plan.id,
    repositoryId: plan.repositoryId,
    subjectRole: plan.subjectRole,
    changedFactor: plan.changedFactor,
    usineBuild: plan.usineBuild,
    reportPath: plan.reportPath,
    baseline: {
      profile: baseline.profile,
      tasks: reports.baseline,
      correctness: baseline.correctness,
      metrics: baseline.metrics,
    },
    candidate: {
      profile: candidate.profile,
      tasks: reports.candidate,
      correctness: candidate.correctness,
      metrics: candidate.metrics,
    },
    comparison,
    recommendation,
    inconclusiveReasons: reasons,
  };
}

function profileReport(
  profile: string,
  reviewerProfile: string,
  tasks: readonly EvaluationTaskReport[],
  expectedProfile?: ExpectedEvidenceProfile,
  expectedReviewer?: ExpectedEvidenceProfile,
) {
  const reasons: string[] = [];
  let correctness: EvaluationProfileReport["correctness"] = "passed";
  for (const task of tasks) {
    const evidence = task.evidence;
    if (evidence.task.relation !== "accepted_exact_sha") {
      if (evidence.task.relation === "blocked") correctness = "failed";
      else if (correctness !== "failed") correctness = "unknown";
      reasons.push(`${task.taskId}:hard_correctness_gate`);
    }
    if (evidence.roleRuns.implementer.length === 0) {
      correctness = correctness === "failed" ? correctness : "unknown";
      reasons.push(`${task.taskId}:implementer_profile_unknown`);
    }
    for (const run of evidence.roleRuns.implementer) {
      if (
        !matchesExpectedProfile(run, profile, expectedProfile) ||
        !hasRequiredEffectiveIdentity(run)
      ) {
        if (correctness !== "failed") correctness = "unknown";
        reasons.push(
          `${task.taskId}:${hasRequiredEffectiveIdentity(run) ? "implementer_profile_drift" : "implementer_profile_unknown"}`,
        );
      }
    }
    for (const run of evidence.roleRuns.reviewer) {
      if (
        !matchesExpectedProfile(run, reviewerProfile, expectedReviewer) ||
        !hasRequiredEffectiveIdentity(run)
      ) {
        if (correctness !== "failed") correctness = "unknown";
        reasons.push(
          `${task.taskId}:${hasRequiredEffectiveIdentity(run) ? "reviewer_profile_drift" : "reviewer_profile_unknown"}`,
        );
      }
    }
    if (reviewerEvidenceRequired(evidence) && evidence.roleRuns.reviewer.length === 0) {
      if (correctness !== "failed") correctness = "unknown";
      reasons.push(`${task.taskId}:reviewer_profile_unknown`);
    }
  }
  if (tasks.length === 0) {
    correctness = "unknown";
    reasons.push(`${profile}:missing_tasks`);
  }
  return { profile, correctness, metrics: aggregateMetrics(tasks), reasons };
}

function reviewerEvidenceRequired(evidence: EvaluationTaskReport["evidence"]): boolean {
  return (
    evidence.task.check?.status === "passed" ||
    evidence.task.review !== null ||
    evidence.task.state === "reviewed" ||
    evidence.task.state === "reviewed_pr" ||
    evidence.task.state === "merged"
  );
}

interface ExpectedEvidenceProfile {
  readonly configSha256: string;
  readonly model: string;
  readonly modelProvider: string | null;
  readonly reasoningEffort: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"]["reasoningEffort"];
  readonly developerInstructionsSha256: string | null;
  readonly adapter: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"]["adapter"];
}

function expectedEvidenceProfile(
  selection: Awaited<ReturnType<typeof resolveProfile>>,
): ExpectedEvidenceProfile {
  const provider = selection.config?.model_provider;
  return {
    configSha256: selection.configSha256 ?? "",
    model: selection.model,
    modelProvider: typeof provider === "string" ? provider : null,
    reasoningEffort: selection.modelReasoningEffort ?? null,
    developerInstructionsSha256: selection.developerInstructions
      ? createHash("sha256").update(selection.developerInstructions, "utf8").digest("hex")
      : null,
    adapter: selection.adapter,
  };
}

function matchesExpectedProfile(
  run: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number],
  expectedName: string,
  expected?: ExpectedEvidenceProfile,
): boolean {
  if (run.requestedProfile !== expectedName || run.effectiveProfile.profileName !== expectedName)
    return false;
  if (!expected) return true;
  const effective = run.effectiveProfile;
  return (
    effective.configSha256 === expected.configSha256 &&
    effective.model === expected.model &&
    effective.modelProvider === expected.modelProvider &&
    effective.reasoningEffort === expected.reasoningEffort &&
    effective.developerInstructionsSha256 === expected.developerInstructionsSha256 &&
    effective.adapter === expected.adapter
  );
}

function hasRequiredEffectiveIdentity(
  run: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number],
): boolean {
  const profile = run.effectiveProfile;
  return (
    run.requestedProfile !== null &&
    profile.profileName !== null &&
    profile.configSha256 !== null &&
    profile.adapter !== null &&
    profile.model !== null
  );
}

function validateEvidenceDrift(
  plan: ProfileEvaluationPlan,
  reports: Record<"baseline" | "candidate", EvaluationTaskReport[]>,
): string[] {
  const reasons: string[] = [];
  const allReviewerRuns = [...reports.baseline, ...reports.candidate].flatMap((task) =>
    task.evidence.roleRuns.reviewer.map((run) => ({ taskId: task.taskId, run })),
  );
  const reviewerReference = allReviewerRuns[0]?.run.effectiveProfile;
  if (reviewerReference) {
    for (const { taskId, run } of allReviewerRuns) {
      if (
        !hasRequiredEffectiveIdentity(run) ||
        !sameEffectiveIdentity(run.effectiveProfile, reviewerReference)
      )
        reasons.push(`${taskId}:reviewer_profile_drift`);
    }
  }

  const byPair = new Map<
    string,
    { baseline?: EvaluationTaskReport; candidate?: EvaluationTaskReport }
  >();
  for (const side of ["baseline", "candidate"] as const) {
    for (const report of reports[side]) {
      const key = `${report.pairId}:${report.repetition}`;
      const pair = byPair.get(key) ?? {};
      pair[side] = report;
      byPair.set(key, pair);
    }
  }
  for (const pair of byPair.values()) {
    if (!pair.baseline || !pair.candidate) continue;
    const baselineRuns = pair.baseline.evidence.roleRuns.implementer;
    const candidateRuns = pair.candidate.evidence.roleRuns.implementer;
    if (baselineRuns.length === 0 || candidateRuns.length === 0) continue;
    const baselineIdentity = stableImplementerIdentity(pair.baseline.taskId, baselineRuns, reasons);
    const candidateIdentity = stableImplementerIdentity(
      pair.candidate.taskId,
      candidateRuns,
      reasons,
    );
    if (
      baselineIdentity &&
      candidateIdentity &&
      !sameAllowedImplementerIdentity(plan.changedFactor, baselineIdentity, candidateIdentity)
    ) {
      reasons.push(`${pair.baseline.taskId}:implementer_profile_drift`);
      reasons.push(`${pair.candidate.taskId}:implementer_profile_drift`);
    }
  }
  return reasons;
}

type EffectiveImplementerProfile =
  EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"];

function stableImplementerIdentity(
  taskId: string,
  runs: readonly EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number][],
  reasons: string[],
): EffectiveImplementerProfile | null {
  if (runs.length === 0) return null;
  const first = runs[0]!;
  const activations = new Set<number>();
  let unknown = false;
  let drifted = false;
  for (const run of runs) {
    if (!hasRequiredEffectiveIdentity(run) || run.activation === null) {
      unknown = true;
      continue;
    }
    if (
      activations.has(run.activation) ||
      !sameEffectiveIdentity(run.effectiveProfile, first.effectiveProfile)
    )
      drifted = true;
    activations.add(run.activation);
  }
  if (unknown) reasons.push(`${taskId}:implementer_profile_unknown`);
  if (drifted) reasons.push(`${taskId}:implementer_profile_drift`);
  return unknown || drifted ? null : first.effectiveProfile;
}

const effectiveIdentityFields = [
  "profileName",
  "configSha256",
  "adapter",
  "model",
  "modelProvider",
  "reasoningEffort",
  "developerInstructionsSha256",
] as const;

function sameEffectiveIdentity(
  left: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"],
  right: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"],
): boolean {
  return effectiveIdentityFields.every((field) => left[field] === right[field]);
}

function sameAllowedImplementerIdentity(
  changedFactor: ProfileEvaluationChangedFactor,
  baseline: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"],
  candidate: EvaluationTaskReport["evidence"]["roleRuns"]["implementer"][number]["effectiveProfile"],
): boolean {
  const fixedFields = {
    model_stack: ["adapter", "reasoningEffort", "developerInstructionsSha256"] as const,
    reasoning: ["adapter", "model", "modelProvider", "developerInstructionsSha256"] as const,
    developer_instructions: ["adapter", "model", "modelProvider", "reasoningEffort"] as const,
  }[changedFactor];
  return fixedFields.every((field) => baseline[field] === candidate[field]);
}

function aggregateMetrics(tasks: readonly EvaluationTaskReport[]): EvaluationMetricSet {
  const implementerRuns = tasks.flatMap((task) => task.evidence.roleRuns.implementer);
  if (implementerRuns.length === 0)
    return {
      implementerActivations: null,
      repairBatches: null,
      interruptions: null,
      elapsedMs: null,
      inputTokens: null,
      outputTokens: null,
      toolFailures: null,
    };
  const activationValues = tasks.map((task) =>
    task.evidence.roleRuns.implementer.length > 0
      ? task.evidence.roleRuns.implementer.length
      : null,
  );
  return {
    implementerActivations: sum(activationValues),
    repairBatches: sum(tasks.map((task) => task.evidence.task.repairBatches)),
    interruptions: sum(implementerRuns.map((run) => (run.effort.failureClass === null ? 0 : 1))),
    elapsedMs: sum(implementerRuns.map((run) => run.effort.elapsedMs)),
    inputTokens: sum(implementerRuns.map((run) => run.usage?.inputTokens ?? null)),
    outputTokens: sum(implementerRuns.map((run) => run.usage?.outputTokens ?? null)),
    toolFailures: sum(
      implementerRuns.map(
        (run) =>
          run.effort.observations.filter(
            (observation) =>
              (observation.type === "tool_completed" ||
                observation.type === "mcp_tool_completed") &&
              observation.outcome === "failed",
          ).length,
      ),
    ),
  };
}

function comparisonEvidenceReasons(
  baseline: EvaluationMetricSet,
  candidate: EvaluationMetricSet,
): string[] {
  const reasons: string[] = [];
  for (const key of metricKeys) {
    if (baseline[key] === null || candidate[key] === null)
      reasons.push(`comparison:${key}:missing_evidence`);
  }
  return reasons;
}

const metricKeys: readonly (keyof EvaluationMetricSet)[] = [
  "implementerActivations",
  "repairBatches",
  "interruptions",
  "elapsedMs",
  "inputTokens",
  "outputTokens",
  "toolFailures",
];

function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function metricDelta(
  baseline: EvaluationMetricSet,
  candidate: EvaluationMetricSet,
): EvaluationMetricSet {
  return {
    implementerActivations: difference(
      baseline.implementerActivations,
      candidate.implementerActivations,
    ),
    repairBatches: difference(baseline.repairBatches, candidate.repairBatches),
    interruptions: difference(baseline.interruptions, candidate.interruptions),
    elapsedMs: difference(baseline.elapsedMs, candidate.elapsedMs),
    inputTokens: difference(baseline.inputTokens, candidate.inputTokens),
    outputTokens: difference(baseline.outputTokens, candidate.outputTokens),
    toolFailures: difference(baseline.toolFailures, candidate.toolFailures),
  };
}

function strictlyLessOrEqual(left: EvaluationMetricSet, right: EvaluationMetricSet): boolean {
  return (
    left.implementerActivations !== null &&
    right.implementerActivations !== null &&
    left.implementerActivations <= right.implementerActivations &&
    left.repairBatches !== null &&
    right.repairBatches !== null &&
    left.repairBatches <= right.repairBatches &&
    left.interruptions !== null &&
    right.interruptions !== null &&
    left.interruptions <= right.interruptions &&
    left.elapsedMs !== null &&
    right.elapsedMs !== null &&
    left.elapsedMs <= right.elapsedMs &&
    left.inputTokens !== null &&
    right.inputTokens !== null &&
    left.inputTokens <= right.inputTokens &&
    left.outputTokens !== null &&
    right.outputTokens !== null &&
    left.outputTokens <= right.outputTokens &&
    left.toolFailures !== null &&
    right.toolFailures !== null &&
    left.toolFailures <= right.toolFailures
  );
}

function difference(baseline: number | null, candidate: number | null): number | null {
  return baseline === null || candidate === null ? null : candidate - baseline;
}

function unknownMetrics(): EvaluationMetricSet {
  return {
    implementerActivations: null,
    repairBatches: null,
    interruptions: null,
    elapsedMs: null,
    inputTokens: null,
    outputTokens: null,
    toolFailures: null,
  };
}

function validatePlanShape(plan: ProfileEvaluationPlan): void {
  if (plan.subjectRole !== "implementer")
    throw new ProfileEvaluationValidationError("subjectRole must be implementer");
  if (!identifier.test(plan.id) || !identifier.test(plan.repositoryId))
    throw new ProfileEvaluationValidationError("plan identifiers are invalid");
  if (!exactSha.test(plan.baseSha))
    throw new ProfileEvaluationValidationError("plan baseSha must be a lowercase 40-character SHA");
  if (!isChangedFactor(plan.changedFactor))
    throw new ProfileEvaluationValidationError("plan changedFactor is invalid");
  if (!exactSha.test(plan.usineBuild))
    throw new ProfileEvaluationValidationError(
      "plan usineBuild must be a lowercase 40-character SHA",
    );
  if (plan.reportPath.trim() === "" || isAbsolute(plan.reportPath))
    throw new ProfileEvaluationValidationError("reportPath must be repository-relative");
  if (plan.registrationPath.trim() === "")
    throw new ProfileEvaluationValidationError("registrationPath must not be blank");
  if (!Number.isSafeInteger(plan.maxTasks) || plan.maxTasks < 2 || plan.maxTasks > 200)
    throw new ProfileEvaluationValidationError("maxTasks must be between 2 and 200");
  if (plan.baselineProfile === plan.candidateProfile)
    throw new ProfileEvaluationValidationError(
      "baseline and candidate profiles must be different evaluation factors",
    );
  if (plan.pairs.length === 0 || plan.pairs.length * 2 > plan.maxTasks)
    throw new ProfileEvaluationValidationError("plan exceeds its maximum-task bound");
  const ids = new Set<string>();
  for (const pair of plan.pairs) {
    if (!identifier.test(pair.id) || !Number.isSafeInteger(pair.repetition) || pair.repetition < 1)
      throw new ProfileEvaluationValidationError("pair identities are invalid");
    const identity = `${pair.id}:${pair.repetition}`;
    if (ids.has(identity))
      throw new ProfileEvaluationValidationError("paired-case identities must be unique");
    ids.add(identity);
    for (const path of [pair.baselineContractPath, pair.candidateContractPath])
      if (isAbsolute(path) || path.trim() === "" || relative(".", path).startsWith(".."))
        throw new ProfileEvaluationValidationError("contract paths must be repository-relative");
  }
  for (const profile of [plan.baselineProfile, plan.candidateProfile, plan.reviewerProfile])
    if (!profileName.test(profile))
      throw new ProfileEvaluationValidationError("profile names are invalid");
}

async function readUsineSourceCommit(): Promise<string> {
  try {
    const sourceCommit = (
      await execFile("git", ["-C", usineSourceRoot, "rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (!exactSha.test(sourceCommit))
      throw new Error("Usine source checkout is not an exact commit");
    return sourceCommit;
  } catch {
    throw new ProfileEvaluationValidationError("Usine source checkout commit is unavailable");
  }
}

async function resolveProfile(profile: string, environment: NodeJS.ProcessEnv) {
  try {
    const selection = await resolveCodexProfile(profile, environment);
    if (!selection.config)
      throw new ProfileEvaluationValidationError(
        `${profile}: resolved profile configuration is unavailable`,
      );
    return { ...selection, adapter: adapterForProfile(profile, environment) };
  } catch (error) {
    if (error instanceof ProfileEvaluationValidationError) throw error;
    throw new ProfileEvaluationValidationError(
      `${profile}: resolved profile configuration is unavailable`,
    );
  }
}

function adapterForProfile(profile: string, environment: NodeJS.ProcessEnv): "sdk" | "app-server" {
  const configured = environment.USINE_CODEX_APP_SERVER_PROFILES?.trim();
  if (!configured) return "sdk";
  const profiles = configured.split(",").map((entry) => entry.trim());
  if (profiles.some((entry) => !profileName.test(entry)))
    throw new ProfileEvaluationValidationError("USINE_CODEX_APP_SERVER_PROFILES is invalid");
  return profiles.includes(profile) ? "app-server" : "sdk";
}

function validateProfileFactor(
  plan: ProfileEvaluationPlan,
  baseline: Awaited<ReturnType<typeof resolveProfile>>,
  candidate: Awaited<ReturnType<typeof resolveProfile>>,
): void {
  const baselineFields = profileFields(baseline);
  const candidateFields = profileFields(candidate);
  if (plan.baselineProfile === plan.candidateProfile)
    throw new ProfileEvaluationValidationError("baseline and candidate profiles must be distinct");
  const factorFields = {
    model_stack: ["model", "modelProvider", "modelProviders", "modelCatalogJson"] as const,
    reasoning: ["reasoningEffort"] as const,
    developer_instructions: ["developerInstructions"] as const,
  }[plan.changedFactor];
  const allFields = [
    "model",
    "modelProvider",
    "modelProviders",
    "modelCatalogJson",
    "adapter",
    "reasoningEffort",
    "developerInstructions",
    "reasoningSummary",
    "verbosity",
    "personality",
    "serviceTier",
  ] as const;
  const differs = (field: (typeof allFields)[number]) =>
    stableJson(baselineFields[field]) !== stableJson(candidateFields[field]);
  if (!factorFields.some(differs))
    throw new ProfileEvaluationValidationError(
      `baseline and candidate profiles do not differ in changedFactor ${plan.changedFactor}`,
    );
  const factorFieldSet = new Set<string>(factorFields);
  const unrelated = allFields.filter((field) => !factorFieldSet.has(field) && differs(field));
  if (unrelated.length > 0)
    throw new ProfileEvaluationValidationError(
      `profiles differ outside changedFactor ${plan.changedFactor}: ${unrelated.join(",")}`,
    );
}

interface ProfileFields {
  readonly model: string;
  readonly modelProvider: unknown;
  readonly modelProviders: unknown;
  readonly modelCatalogJson: unknown;
  readonly adapter: "sdk" | "app-server";
  readonly reasoningEffort: unknown;
  readonly developerInstructions: unknown;
  readonly reasoningSummary: unknown;
  readonly verbosity: unknown;
  readonly personality: unknown;
  readonly serviceTier: unknown;
}

function profileFields(selection: Awaited<ReturnType<typeof resolveProfile>>): ProfileFields {
  const config = selection.config;
  return {
    model: selection.model,
    modelProvider: config?.model_provider ?? null,
    modelProviders: config?.model_providers ?? null,
    modelCatalogJson: config?.model_catalog_json ?? null,
    adapter: selection.adapter,
    reasoningEffort: selection.modelReasoningEffort ?? null,
    developerInstructions: selection.developerInstructions ?? null,
    reasoningSummary: config?.model_reasoning_summary ?? null,
    verbosity: config?.model_verbosity ?? null,
    personality: config?.personality ?? null,
    serviceTier: config?.service_tier ?? null,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function validatePair(
  plan: ProfileEvaluationPlan,
  pair: ProfileEvaluationPair,
  baseline: TaskContract,
  candidate: TaskContract,
): void {
  if (baseline.baseSha !== plan.baseSha || candidate.baseSha !== plan.baseSha)
    throw new ProfileEvaluationValidationError(`${pair.id}: pair baseSha drifts from the plan`);
  if (baseline.authorization.merge === true || candidate.authorization.merge === true)
    throw new ProfileEvaluationValidationError(
      `${pair.id}: evaluation Tasks must not grant merge authority`,
    );
  if (baseline.repositoryId !== plan.repositoryId || candidate.repositoryId !== plan.repositoryId)
    throw new ProfileEvaluationValidationError(
      `${pair.id}: contract Repository drifts from the plan`,
    );
  if (JSON.stringify(contractSemantics(baseline)) !== JSON.stringify(contractSemantics(candidate)))
    throw new ProfileEvaluationValidationError(`${pair.id}: paired contract semantics drift`);
}

function contractSemantics(contract: TaskContract) {
  return {
    baseSha: contract.baseSha,
    instructions: contract.instructions,
    acceptance: contract.acceptance,
    nonGoals: contract.nonGoals,
    budget: contract.budget,
    delivery: { title: contract.delivery.title, body: contract.delivery.body },
    authorization: { delivery: contract.authorization.delivery },
  };
}

function validateContractRepository(
  contract: TaskContract,
  registration: RepositorySnapshot,
): void {
  const url = new URL(contract.authorization.source);
  const [, owner, name] = url.pathname.split("/");
  if (
    owner?.toLowerCase() !== registration.owner.toLowerCase() ||
    name?.toLowerCase() !== registration.name.toLowerCase()
  )
    throw new ProfileEvaluationValidationError(
      `${contract.id}: authorization does not name the evaluation Repository`,
    );
}

async function validateExistingTask(
  task: import("@usine/task-authority").TaskResource,
  contract: TaskContract,
  contractPath: string,
  registration: RepositorySnapshot,
): Promise<void> {
  if (task.taskId !== contract.id)
    throw new ProfileEvaluationValidationError(`${contract.id}: existing Task identity drifted`);
  if (task.mergeAuthorized)
    throw new ProfileEvaluationValidationError(
      `${contract.id}: existing Task grants merge authority`,
    );
  if (
    task.writer.repositoryIdentity.toLowerCase() !==
    `${registration.owner}/${registration.name}`.toLowerCase()
  )
    throw new ProfileEvaluationValidationError(`${contract.id}: existing Task Repository drifted`);
  if (
    !task.repository ||
    task.repository.id !== registration.id ||
    task.repository.owner.toLowerCase() !== registration.owner.toLowerCase() ||
    task.repository.name.toLowerCase() !== registration.name.toLowerCase() ||
    task.repository.baseBranch !== registration.baseBranch
  )
    throw new ProfileEvaluationValidationError(`${contract.id}: existing Task snapshot drifted`);
  const rawContract = await readUtf8(contractPath, "task contract");
  if (task.contractHash !== hashTaskContract(rawContract))
    throw new ProfileEvaluationValidationError(`${contract.id}: existing Task contract drifted`);
}

function normalizePlan(input: unknown): ProfileEvaluationPlan {
  if (!isRecord(input))
    throw new ProfileEvaluationValidationError("evaluation plan must be an object");
  const allowedKeys = new Set([
    "schemaVersion",
    "id",
    "repositoryId",
    "baseSha",
    "subjectRole",
    "changedFactor",
    "baselineProfile",
    "candidateProfile",
    "reviewerProfile",
    "maxTasks",
    "usineBuild",
    "reportPath",
    "pairs",
    "registrationPath",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)))
    throw new ProfileEvaluationValidationError("evaluation plan has unexpected fields");
  if (!Array.isArray(input.pairs))
    throw new ProfileEvaluationValidationError("plan must contain paired contracts");
  if (
    input.schemaVersion !== 1 ||
    typeof input.id !== "string" ||
    typeof input.repositoryId !== "string" ||
    typeof input.baseSha !== "string" ||
    input.subjectRole !== "implementer" ||
    !isChangedFactor(input.changedFactor) ||
    typeof input.baselineProfile !== "string" ||
    typeof input.candidateProfile !== "string" ||
    typeof input.reviewerProfile !== "string" ||
    typeof input.maxTasks !== "number" ||
    typeof input.usineBuild !== "string" ||
    typeof input.reportPath !== "string" ||
    typeof input.registrationPath !== "string"
  )
    throw new ProfileEvaluationValidationError("evaluation plan has missing or invalid fields");
  const plan: ProfileEvaluationPlan = {
    schemaVersion: 1,
    id: input.id,
    repositoryId: input.repositoryId,
    baseSha: input.baseSha,
    subjectRole: "implementer",
    changedFactor: input.changedFactor,
    baselineProfile: input.baselineProfile,
    candidateProfile: input.candidateProfile,
    reviewerProfile: input.reviewerProfile,
    maxTasks: input.maxTasks,
    usineBuild: input.usineBuild,
    reportPath: input.reportPath,
    registrationPath: input.registrationPath,
    pairs: input.pairs.map(parsePair),
  };
  return plan;
}

function isChangedFactor(value: unknown): value is ProfileEvaluationChangedFactor {
  return value === "model_stack" || value === "reasoning" || value === "developer_instructions";
}

function parsePair(input: unknown): ProfileEvaluationPair {
  if (
    !isRecord(input) ||
    typeof input.id !== "string" ||
    typeof input.repetition !== "number" ||
    typeof input.baselineContractPath !== "string" ||
    typeof input.candidateContractPath !== "string"
  )
    throw new ProfileEvaluationValidationError("paired contract identity is invalid");
  if (
    Object.keys(input).some(
      (key) => !["id", "repetition", "baselineContractPath", "candidateContractPath"].includes(key),
    )
  )
    throw new ProfileEvaluationValidationError("paired contract identity has unexpected fields");
  return {
    id: input.id,
    repetition: input.repetition,
    baselineContractPath: input.baselineContractPath,
    candidateContractPath: input.candidateContractPath,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseContract(raw: string, label: string): TaskContract {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ProfileEvaluationValidationError(`${label} is not JSON`);
  }
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success)
    throw new ProfileEvaluationValidationError(
      `${label} is invalid: ${JSON.stringify(contractIssues(parsed.error))}`,
    );
  return parsed.data;
}

async function readRestorationRegistration(
  plan: ProfileEvaluationPlan,
  planPath: string,
): Promise<RepositorySnapshot> {
  const path = resolve(dirname(planPath), plan.registrationPath);
  try {
    return repositoryRegistrationSchema.parse(
      JSON.parse(await readUtf8(path, "Repository registration")),
    );
  } catch {
    throw new ProfileEvaluationValidationError("Repository registration is unreadable or invalid");
  }
}

async function validateRegistration(
  plan: ProfileEvaluationPlan,
  registration: RepositorySnapshot,
  repositoryRoot: string,
): Promise<void> {
  if (registration.id !== plan.repositoryId)
    throw new ProfileEvaluationValidationError(
      "restoration registration Repository ID differs from the plan",
    );
  if ((await realpath(registration.path).catch(() => registration.path)) !== repositoryRoot)
    throw new ProfileEvaluationValidationError(
      "restoration registration path differs from the plan Repository",
    );
  if (!registration.implementerProfile || !registration.reviewerProfile)
    throw new ProfileEvaluationValidationError(
      "restoration registration must identify the prior profiles",
    );
}

async function repositoryRootFor(path: string): Promise<string> {
  try {
    return (
      await execFile("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"])
    ).stdout.trim();
  } catch {
    throw new ProfileEvaluationValidationError("evaluation plan is not inside a Git Repository");
  }
}

async function isAncestor(repositoryRoot: string, sha: string): Promise<boolean> {
  try {
    await execFile("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function requireCommittedFile(
  repositoryRoot: string,
  path: string,
  label: string,
): Promise<void> {
  const relativePath = relative(repositoryRoot, path);
  try {
    const tracked = await execFile("git", [
      "-C",
      repositoryRoot,
      "ls-files",
      "--error-unmatch",
      "--",
      relativePath,
    ]);
    if (tracked.stdout.trim() !== relativePath) throw new Error("file is not tracked");
    await execFile("git", ["-C", repositoryRoot, "diff", "--quiet", "HEAD", "--", relativePath]);
  } catch (error) {
    throw new ProfileEvaluationValidationError(
      `${label} must be committed and unchanged (${error instanceof Error ? error.message : "git check failed"})`,
    );
  }
}

function resolveRepositoryFile(root: string, path: string, label: string): string {
  const resolved = resolve(root, path);
  if (
    relative(root, resolved).startsWith("..") ||
    isAbsolute(relative(root, resolved)) ||
    resolved === root
  )
    throw new ProfileEvaluationValidationError(`${label} must be inside the evaluation Repository`);
  return resolved;
}

async function readUtf8(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ProfileEvaluationValidationError(`${label} is unreadable`);
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProfileEvaluationValidationError(`${label} is not JSON`);
  }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("profile evaluation cancelled");
}

function renderReport(report: ProfileEvaluationReport): string {
  return [
    `Profile evaluation ${report.planId}: ${report.recommendation}`,
    `Baseline (${report.baseline.profile}): ${report.baseline.correctness}`,
    `Candidate (${report.candidate.profile}): ${report.candidate.correctness}`,
    `Comparison: ${JSON.stringify(report.comparison)}`,
    ...(report.inconclusiveReasons.length > 0
      ? [`Inconclusive reasons: ${report.inconclusiveReasons.join(", ")}`]
      : []),
    "",
  ].join("\n");
}
