import { readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  contractIssues,
  hashTaskContract,
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
  listTasks,
  submitTask,
  taskEvidence,
  taskStatus,
} from "./server-client.js";
import { jsonFlag } from "./cli-parameters.js";

const execFile = promisify(execFileCallback);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const exactSha = /^[0-9a-f]{40}$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
  readonly baselineProfile: string;
  readonly candidateProfile: string;
  readonly reviewerProfile: string;
  readonly maxTasks: number;
  readonly pairs: readonly ProfileEvaluationPair[];
  readonly registrationPath?: string;
}

export interface ProfileEvaluationPlanInput {
  readonly schemaVersion?: 1;
  readonly id: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly subjectRole: "implementer";
  readonly baselineProfile?: string;
  readonly candidateProfile?: string;
  readonly reviewerProfile: string;
  readonly profiles?: {
    readonly baseline: string;
    readonly candidate: string;
  };
  readonly maxTasks: number;
  readonly pairs?: readonly ProfileEvaluationPair[];
  readonly cases?: readonly ProfileEvaluationPair[];
  readonly registrationPath?: string;
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
  readonly listTasks: typeof listTasks;
  readonly registerRepository: typeof registerRepository;
  readonly submitTask: typeof submitTask;
  readonly taskStatus: typeof taskStatus;
  readonly followTask: typeof followTask;
  readonly taskEvidence: typeof taskEvidence;
}

const defaultServices: ProfileEvaluationServices = {
  inspectRepository,
  listTasks,
  registerRepository,
  submitTask,
  taskStatus,
  followTask,
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

export async function readProfileEvaluationPlan(
  planPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  plan: ProfileEvaluationPlan;
  contracts: readonly TaskContract[];
  registration: RepositorySnapshot;
  repositoryRoot: string;
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
  for (const contract of contracts) validateContractRepository(contract, registration);
  for (const profile of [plan.baselineProfile, plan.candidateProfile, plan.reviewerProfile]) {
    validateCodexProfile(profile);
    await resolveCodexProfile(profile, environment);
  }
  return { plan, contracts, registration, repositoryRoot };
}

export function profileCommand(serverUrl: string, environment: NodeJS.ProcessEnv = process.env) {
  const evaluate = Command.make(
    "evaluate",
    {
      planPath: Argument.string("plan"),
      subjectRole: Flag.string("subject-role").pipe(Flag.withDefault("implementer")),
      json: jsonFlag(),
    },
    (options) =>
      Effect.promise(() =>
        runProfileEvaluateCommand(
          { planPath: options.planPath, subjectRole: options.subjectRole, json: options.json },
          serverUrl,
          environment,
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
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : renderReport(report));
  });
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
        let task = await services.taskStatus(serverUrl, contract.id);
        if (task) {
          await validateExistingTask(
            task,
            contract,
            resolve(loaded.repositoryRoot, contractPath),
            originalRegistration,
          );
        }
        if (!task) {
          await ensureRepositoryIdle(
            serverUrl,
            `${originalRegistration.owner}/${originalRegistration.name}`.toLowerCase(),
            services,
          );
          const evaluationRegistration = {
            ...originalRegistration,
            implementerProfile: profile,
            reviewerProfile: plan.reviewerProfile,
          };
          await services.registerRepository(serverUrl, evaluationRegistration);
          task = await services.submitTask(serverUrl, {
            contractPath: resolve(loaded.repositoryRoot, contractPath),
            repositoryId: plan.repositoryId,
          });
        }
        if (!isTerminalOrWaiting(task.state))
          task = await services.followTask(serverUrl, task.taskId, {
            timeoutMs: contract.budget.maxElapsedMs,
            signal,
          });
        if (!isTerminalOrWaiting(task.state))
          throw new Error(`Task ${task.taskId} did not reach a durable stopping state`);
        if (task.state === "waiting")
          throw new Error(`Task ${task.taskId} is waiting for an explicit retry`);
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
  } finally {
    await services.registerRepository(serverUrl, originalRegistration).catch((error) => {
      throw new Error(`evaluation Repository restoration failed: ${String(error)}`);
    });
  }
  return compareProfileEvaluation(plan, reports);
}

export function compareProfileEvaluation(
  plan: ProfileEvaluationPlan,
  reports: Record<"baseline" | "candidate", EvaluationTaskReport[]>,
): ProfileEvaluationReport {
  const baseline = profileReport(plan.baselineProfile, plan.reviewerProfile, reports.baseline);
  const candidate = profileReport(plan.candidateProfile, plan.reviewerProfile, reports.candidate);
  const reasons = [...new Set([...baseline.reasons, ...candidate.reasons])].toSorted();
  const comparable =
    reasons.length === 0 && baseline.correctness === "passed" && candidate.correctness === "passed";
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
  if (reasons.length === 0) {
    if (baseline.correctness === "passed" && candidate.correctness === "failed") {
      recommendation = "baseline";
    } else if (candidate.correctness === "passed" && baseline.correctness === "failed") {
      recommendation = "candidate";
    } else {
      const candidateBetter = strictlyLessOrEqual(candidate.metrics, baseline.metrics);
      const baselineBetter = strictlyLessOrEqual(baseline.metrics, candidate.metrics);
      if (candidateBetter && !baselineBetter) recommendation = "candidate";
      else if (baselineBetter && !candidateBetter) recommendation = "baseline";
    }
  }
  return {
    schemaVersion: 1,
    planId: plan.id,
    repositoryId: plan.repositoryId,
    subjectRole: plan.subjectRole,
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
      if (run.requestedProfile !== profile || run.effectiveProfile.profileName !== profile) {
        if (correctness !== "failed") correctness = "unknown";
        reasons.push(`${task.taskId}:implementer_profile_drift`);
      }
    }
    for (const run of evidence.roleRuns.reviewer) {
      // Reviewer profile is checked against the plan by the caller's fixed registration.
      if (
        run.requestedProfile !== reviewerProfile ||
        run.effectiveProfile.profileName !== reviewerProfile
      ) {
        if (correctness !== "failed") correctness = "unknown";
        reasons.push(`${task.taskId}:reviewer_profile_drift`);
      }
    }
    if (evidence.roleRuns.reviewer.length === 0)
      reasons.push(`${task.taskId}:reviewer_profile_unknown`);
  }
  if (tasks.length === 0) {
    correctness = "unknown";
    reasons.push(`${profile}:missing_tasks`);
  }
  return { profile, correctness, metrics: aggregateMetrics(tasks), reasons };
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
  const rawContract = await readUtf8(contractPath, "task contract");
  if (task.contractHash !== hashTaskContract(rawContract))
    throw new ProfileEvaluationValidationError(`${contract.id}: existing Task contract drifted`);
}

function normalizePlan(input: unknown): ProfileEvaluationPlan {
  if (!isRecord(input))
    throw new ProfileEvaluationValidationError("evaluation plan must be an object");
  if (input.profiles !== undefined && !isRecord(input.profiles))
    throw new ProfileEvaluationValidationError("evaluation plan profiles are invalid");
  const profiles = isRecord(input.profiles) ? input.profiles : undefined;
  const allowedKeys = new Set([
    "schemaVersion",
    "id",
    "planId",
    "repositoryId",
    "baseSha",
    "subjectRole",
    "baselineProfile",
    "candidateProfile",
    "reviewerProfile",
    "profiles",
    "maxTasks",
    "pairs",
    "cases",
    "registrationPath",
    "restoreRegistrationPath",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)))
    throw new ProfileEvaluationValidationError("evaluation plan has unexpected fields");
  if (input.pairs !== undefined && input.cases !== undefined)
    throw new ProfileEvaluationValidationError("evaluation plan must use one pair list");
  if (
    profiles &&
    Object.keys(profiles).some(
      (key) => key !== "baseline" && key !== "candidate" && key !== "reviewer",
    )
  )
    throw new ProfileEvaluationValidationError("evaluation plan profiles have unexpected fields");
  if (profiles && Object.values(profiles).some((profile) => typeof profile !== "string"))
    throw new ProfileEvaluationValidationError("evaluation plan profiles are invalid");
  const rawPairs = input.pairs ?? input.cases;
  if (!isRecord(input) || !Array.isArray(rawPairs))
    throw new ProfileEvaluationValidationError("plan must contain paired contracts");
  const baselineProfile = input.baselineProfile ?? profiles?.baseline;
  const candidateProfile = input.candidateProfile ?? profiles?.candidate;
  const schemaVersion = input.schemaVersion ?? 1;
  const reviewerProfileInput = input.reviewerProfile ?? profiles?.reviewer;
  if (
    schemaVersion !== 1 ||
    typeof (input.id ?? input.planId) !== "string" ||
    typeof input.repositoryId !== "string" ||
    typeof input.baseSha !== "string" ||
    input.subjectRole !== "implementer" ||
    typeof reviewerProfileValue(reviewerProfileInput) !== "string" ||
    typeof input.maxTasks !== "number" ||
    typeof baselineProfile !== "string" ||
    typeof candidateProfile !== "string"
  )
    throw new ProfileEvaluationValidationError("plan must name baseline and candidate profiles");
  const reviewerProfile = reviewerProfileValue(reviewerProfileInput);
  if (reviewerProfile === undefined)
    throw new ProfileEvaluationValidationError("plan must name a reviewer profile");
  const id = input.id ?? input.planId;
  const repositoryId = input.repositoryId;
  const baseSha = input.baseSha;
  const subjectRole = input.subjectRole;
  const maxTasks = input.maxTasks;
  const registrationPath = input.registrationPath ?? input.restoreRegistrationPath;
  if (
    typeof id !== "string" ||
    typeof repositoryId !== "string" ||
    typeof baseSha !== "string" ||
    subjectRole !== "implementer" ||
    typeof maxTasks !== "number"
  )
    throw new ProfileEvaluationValidationError("evaluation plan has invalid fields");
  if (registrationPath !== undefined && typeof registrationPath !== "string")
    throw new ProfileEvaluationValidationError("evaluation plan registrationPath is invalid");
  const pairs = rawPairs.map(parsePair);
  const plan: ProfileEvaluationPlan = {
    schemaVersion,
    id,
    repositoryId,
    baseSha,
    subjectRole,
    baselineProfile,
    candidateProfile,
    reviewerProfile,
    maxTasks,
    pairs,
    ...(registrationPath === undefined ? {} : { registrationPath }),
  };
  return plan;
}

function reviewerProfileValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePair(input: unknown): ProfileEvaluationPair {
  if (
    !isRecord(input) ||
    typeof (input.id ?? input.caseId) !== "string" ||
    typeof input.repetition !== "number" ||
    typeof (input.baselineContractPath ?? input.baselineContract ?? input.baseline) !== "string" ||
    typeof (input.candidateContractPath ?? input.candidateContract ?? input.candidate) !== "string"
  )
    throw new ProfileEvaluationValidationError("paired contract identity is invalid");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "caseId",
          "repetition",
          "baselineContractPath",
          "candidateContractPath",
          "baselineContract",
          "candidateContract",
          "baseline",
          "candidate",
        ].includes(key),
    )
  )
    throw new ProfileEvaluationValidationError("paired contract identity has unexpected fields");
  const id = typeof input.id === "string" ? input.id : input.caseId;
  const repetition = input.repetition;
  const baselineContractPath =
    input.baselineContractPath ?? input.baselineContract ?? input.baseline;
  const candidateContractPath =
    input.candidateContractPath ?? input.candidateContract ?? input.candidate;
  if (
    typeof id !== "string" ||
    typeof repetition !== "number" ||
    typeof baselineContractPath !== "string" ||
    typeof candidateContractPath !== "string"
  )
    throw new ProfileEvaluationValidationError("paired contract identity is invalid");
  return {
    id,
    repetition,
    baselineContractPath,
    candidateContractPath,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

async function ensureRepositoryIdle(
  serverUrl: string,
  repositoryIdentity: string,
  services: ProfileEvaluationServices,
): Promise<void> {
  const page = await services.listTasks(serverUrl, 200);
  const active = page.tasks.find(
    (task) =>
      task.writer.repositoryIdentity.toLowerCase() === repositoryIdentity &&
      task.state !== "reviewed_pr" &&
      task.state !== "merged" &&
      task.state !== "blocked",
  );
  if (active)
    throw new ProfileEvaluationValidationError(
      `cannot switch profiles while Task ${active.taskId} is active`,
    );
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
  const path = plan.registrationPath
    ? resolve(dirname(planPath), plan.registrationPath)
    : resolve(dirname(planPath), "repository.json");
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
function isTerminalOrWaiting(state: string): boolean {
  return (
    state === "reviewed_pr" || state === "merged" || state === "blocked" || state === "waiting"
  );
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
