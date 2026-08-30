import { readFile, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  contractIssues,
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
    contracts.push(baseline, candidate);
  }

  const registration = await readRestorationRegistration(plan, absolutePlanPath);
  await validateRegistration(plan, registration, repositoryRoot);
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
): Promise<void> {
  return runCommand("profile_evaluate_failed", async () => {
    if (options.subjectRole !== "implementer")
      throw new CliFailure("invalid_evaluation_subject_role", "validation", {
        subjectRole: options.subjectRole,
      });
    const loaded = await readProfileEvaluationPlan(options.planPath, environment);
    const current = await inspectRepository(serverUrl, loaded.plan.repositoryId);
    if (!current)
      throw new CliFailure("repository_not_found", "not_found", {
        repositoryId: loaded.plan.repositoryId,
      });
    if (
      current.owner !== loaded.registration.owner ||
      current.name !== loaded.registration.name ||
      current.baseBranch !== loaded.registration.baseBranch
    )
      throw new ProfileEvaluationValidationError(
        "plan registration does not match the registered Repository",
      );
    await ensureRepositoryIdle(
      serverUrl,
      `${loaded.registration.owner}/${loaded.registration.name}`.toLowerCase(),
    );
    const report = await executeProfileEvaluation(loaded, serverUrl, options.signal);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : renderReport(report));
  });
}

async function executeProfileEvaluation(
  loaded: Awaited<ReturnType<typeof readProfileEvaluationPlan>>,
  serverUrl: string,
  signal?: AbortSignal,
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
  let activeRegistration = originalRegistration;
  try {
    for (const pair of plan.pairs) {
      for (const side of ["baseline", "candidate"] as const) {
        throwIfAborted(signal);
        const contractPath =
          side === "baseline" ? pair.baselineContractPath : pair.candidateContractPath;
        const profile = side === "baseline" ? plan.baselineProfile : plan.candidateProfile;
        await ensureRepositoryIdle(
          serverUrl,
          `${originalRegistration.owner}/${originalRegistration.name}`.toLowerCase(),
        );
        activeRegistration = {
          ...originalRegistration,
          implementerProfile: profile,
          reviewerProfile: plan.reviewerProfile,
        };
        await registerRepository(serverUrl, activeRegistration);
        const contract = parseContract(
          await readUtf8(resolve(loaded.repositoryRoot, contractPath), "task contract"),
          "task contract",
        );
        let task = await taskStatus(serverUrl, contract.id);
        if (!task)
          task = await submitTask(serverUrl, {
            contractPath: resolve(loaded.repositoryRoot, contractPath),
            repositoryId: plan.repositoryId,
          });
        if (!isTerminalOrWaiting(task.state))
          task = await followTask(serverUrl, task.taskId, {
            timeoutMs: contract.budget.maxElapsedMs,
          });
        if (!isTerminalOrWaiting(task.state))
          throw new Error(`Task ${task.taskId} did not reach a durable stopping state`);
        if (task.state === "waiting")
          throw new Error(`Task ${task.taskId} is waiting for an explicit retry`);
        const evidence = await taskEvidence(serverUrl, task.taskId);
        if (!evidence) throw new Error(`Task evidence is unavailable for ${task.taskId}`);
        reports[side].push({
          id: `${pair.id}:${pair.repetition}:${side}`,
          pairId: pair.id,
          repetition: pair.repetition,
          taskId: task.taskId,
          evidence,
        } as EvaluationTaskReport);
      }
    }
  } finally {
    await registerRepository(serverUrl, originalRegistration).catch((error) => {
      throw new Error(`evaluation Repository restoration failed: ${String(error)}`);
    });
  }
  return makeReport(plan, reports);
}

function makeReport(
  plan: ProfileEvaluationPlan,
  reports: Record<"baseline" | "candidate", EvaluationTaskReport[]>,
): ProfileEvaluationReport {
  const baseline = profileReport(plan.baselineProfile, plan.reviewerProfile, reports.baseline);
  const candidate = profileReport(plan.candidateProfile, plan.reviewerProfile, reports.candidate);
  const reasons = [...new Set([...baseline.reasons, ...candidate.reasons])].toSorted();
  const comparison = {
    baseline: baseline.metrics,
    candidate: candidate.metrics,
    delta: metricDelta(baseline.metrics, candidate.metrics),
  };
  let recommendation: ProfileEvaluationReport["recommendation"] = "inconclusive";
  if (reasons.length === 0) {
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
      if (run.requestedProfile !== profile || run.effectiveProfile.profileName !== profile)
        reasons.push(`${task.taskId}:implementer_profile_drift`);
    }
    for (const run of evidence.roleRuns.reviewer) {
      // Reviewer profile is checked against the plan by the caller's fixed registration.
      if (
        run.requestedProfile !== reviewerProfile ||
        run.effectiveProfile.profileName !== reviewerProfile
      )
        reasons.push(`${task.taskId}:reviewer_profile_drift`);
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

function validatePlanShape(plan: ProfileEvaluationPlan): void {
  if (plan.subjectRole !== "implementer")
    throw new ProfileEvaluationValidationError("subjectRole must be implementer");
  if (!identifier.test(plan.id) || !identifier.test(plan.repositoryId))
    throw new ProfileEvaluationValidationError("plan identifiers are invalid");
  if (!exactSha.test(plan.baseSha))
    throw new ProfileEvaluationValidationError("plan baseSha must be a lowercase 40-character SHA");
  if (!Number.isSafeInteger(plan.maxTasks) || plan.maxTasks < 2 || plan.maxTasks > 200)
    throw new ProfileEvaluationValidationError("maxTasks must be between 2 and 200");
  if (plan.pairs.length === 0 || plan.pairs.length * 2 > plan.maxTasks)
    throw new ProfileEvaluationValidationError("plan exceeds its maximum-task bound");
  const ids = new Set<string>();
  for (const pair of plan.pairs) {
    if (!identifier.test(pair.id) || !Number.isSafeInteger(pair.repetition) || pair.repetition < 1)
      throw new ProfileEvaluationValidationError("pair identities are invalid");
    if (ids.has(pair.id) || ids.has(`${pair.id}:${pair.repetition}`))
      throw new ProfileEvaluationValidationError("paired-case identities must be unique");
    ids.add(pair.id);
    ids.add(`${pair.id}:${pair.repetition}`);
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
  const semantics = (contract: TaskContract) => ({
    baseSha: contract.baseSha,
    instructions: contract.instructions,
    acceptance: contract.acceptance,
    nonGoals: contract.nonGoals,
    budget: contract.budget,
    delivery: { title: contract.delivery.title, body: contract.delivery.body },
    authorization: { delivery: contract.authorization.delivery },
  });
  if (JSON.stringify(semantics(baseline)) !== JSON.stringify(semantics(candidate)))
    throw new ProfileEvaluationValidationError(`${pair.id}: paired contract semantics drift`);
}

function normalizePlan(input: unknown): ProfileEvaluationPlan {
  if (!isRecord(input))
    throw new ProfileEvaluationValidationError("evaluation plan must be an object");
  const profiles = isRecord(input.profiles) ? input.profiles : undefined;
  const rawPairs = input.pairs ?? input.cases;
  if (!isRecord(input) || !Array.isArray(rawPairs))
    throw new ProfileEvaluationValidationError("plan must contain paired contracts");
  const baselineProfile = input.baselineProfile ?? profiles?.baseline;
  const candidateProfile = input.candidateProfile ?? profiles?.candidate;
  const schemaVersion = input.schemaVersion ?? 1;
  if (
    schemaVersion !== 1 ||
    typeof input.id !== "string" ||
    typeof input.repositoryId !== "string" ||
    typeof input.baseSha !== "string" ||
    input.subjectRole !== "implementer" ||
    typeof reviewerProfileValue(input.reviewerProfile) !== "string" ||
    typeof input.maxTasks !== "number" ||
    typeof baselineProfile !== "string" ||
    typeof candidateProfile !== "string"
  )
    throw new ProfileEvaluationValidationError("plan must name baseline and candidate profiles");
  const reviewerProfile = reviewerProfileValue(input.reviewerProfile);
  if (reviewerProfile === undefined)
    throw new ProfileEvaluationValidationError("plan must name a reviewer profile");
  const pairs = rawPairs.map(parsePair);
  const plan: ProfileEvaluationPlan = {
    schemaVersion,
    id: input.id,
    repositoryId: input.repositoryId,
    baseSha: input.baseSha,
    subjectRole: input.subjectRole,
    baselineProfile,
    candidateProfile,
    reviewerProfile,
    maxTasks: input.maxTasks,
    pairs,
    ...(typeof input.registrationPath === "string"
      ? { registrationPath: input.registrationPath }
      : {}),
  };
  return plan;
}

function reviewerProfileValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

async function ensureRepositoryIdle(serverUrl: string, repositoryIdentity: string): Promise<void> {
  const page = await listTasks(serverUrl, 200);
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
    ) as RepositorySnapshot;
  } catch {
    throw new ProfileEvaluationValidationError("Repository registration is unreadable or invalid");
  }
}

async function validateRegistration(
  plan: ProfileEvaluationPlan,
  registration: RepositorySnapshot,
  repositoryRoot: string,
): void {
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
    if (tracked.stdout.trim() !== relativePath)
      throw new Error("file is not tracked");
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
