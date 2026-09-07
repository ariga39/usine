import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
  resolveTaskContract,
  repositoryRegistrationSchema,
  taskContractSchema,
  type RepositorySnapshot,
  type ReviewVerdict,
  type TaskContract,
} from "@usine/task-authority";
import {
  codingSessionAdapterForProfile,
  CodingSessionAdapterConfigurationError,
  reviewCandidateWithProfile,
  codingSessionAdapterProfilesFromEnvironment,
  readSessionArchiveManifest,
  resolveCodexProfile,
  stateDirectoryFromEnvironment,
  type ReviewerQualityGateInput,
  type ReviewAttemptObservation,
  type SessionArchiveManifest,
} from "@usine/runtime";
import { runCommand } from "./cli-failure.js";
import {
  admitProfilePair,
  profilePairFieldSnapshot,
  type ProfilePairChangedFactor,
} from "./profile-pair-admission.js";

type EffectiveSessionProfile = NonNullable<ReviewAttemptObservation["effectiveProfile"]>;
type CheckResult = ReviewerQualityGateInput["check"];

const execFile = promisify(execFileCallback);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const exactSha = /^[0-9a-f]{40}$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const archiveIdPattern = /^archive_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usineSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const reviewerEvaluationCaseSchema = Schema.Struct({
  id: Schema.String,
  repetition: Schema.Number,
  contractPath: Schema.String,
  candidateSha: Schema.String,
  checkPath: Schema.String,
  labelPath: Schema.String,
});

const reviewerEvaluationCheckSchema = Schema.Struct({
  sha: Schema.String,
  status: Schema.String,
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

const reviewerEvaluationLabelSchema = Schema.Struct({
  verdict: Schema.Literals(["approved", "changes_requested"]),
  rationale: Schema.String,
  reference: Schema.String,
  protected: Schema.optionalKey(Schema.Boolean),
});

const reviewerEvaluationPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  repositoryId: Schema.String,
  baseSha: Schema.String,
  subjectRole: Schema.Literal("reviewer"),
  changedFactor: Schema.Literals(["model_stack", "reasoning", "developer_instructions"]),
  baselineProfile: Schema.String,
  candidateProfile: Schema.String,
  maxRuns: Schema.Number,
  usineBuild: Schema.String,
  reportPath: Schema.String,
  registrationPath: Schema.String,
  cases: Schema.Array(reviewerEvaluationCaseSchema),
});

const decodeReviewerEvaluationPlan = Schema.decodeUnknownSync(reviewerEvaluationPlanSchema, {
  onExcessProperty: "error",
});
const decodeReviewerEvaluationCheck = Schema.decodeUnknownSync(reviewerEvaluationCheckSchema, {
  onExcessProperty: "error",
});
const decodeReviewerEvaluationLabel = Schema.decodeUnknownSync(reviewerEvaluationLabelSchema, {
  onExcessProperty: "error",
});

export type ReviewerEvaluationChangedFactor = ProfilePairChangedFactor;

export interface ReviewerEvaluationCase {
  readonly id: string;
  readonly repetition: number;
  readonly contractPath: string;
  readonly candidateSha: string;
  readonly checkPath: string;
  readonly labelPath: string;
}

export interface ReviewerEvaluationPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly subjectRole: "reviewer";
  readonly changedFactor: ReviewerEvaluationChangedFactor;
  readonly baselineProfile: string;
  readonly candidateProfile: string;
  readonly maxRuns: number;
  readonly usineBuild: string;
  readonly reportPath: string;
  readonly registrationPath: string;
  readonly cases: readonly ReviewerEvaluationCase[];
}

export interface ReviewerEvaluationLabel {
  readonly verdict: "approved" | "changes_requested";
  readonly rationale: string;
  readonly reference: string;
  readonly protected: boolean;
}

export interface ReviewerEvaluationCaseInput {
  readonly case: ReviewerEvaluationCase;
  readonly contract: ReviewerQualityGateInput["contract"];
  readonly candidateSha: string;
  readonly check: ReviewerQualityGateInput["check"];
  readonly label: ReviewerEvaluationLabel;
}

export interface ReviewerEvaluationRunReport {
  readonly caseId: string;
  readonly repetition: number;
  readonly profile: string;
  readonly candidateSha: string;
  readonly expected: ReviewerEvaluationLabel;
  readonly observed: {
    readonly sha: string | null;
    readonly verdict: ReviewVerdict["verdict"] | null;
    readonly findingCount: number | null;
  };
  readonly correctness: "correct" | "incorrect" | "inconclusive";
  readonly hardRegression: boolean;
  readonly elapsedMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolFailures: number | null;
  readonly requestedProfile: string | null;
  readonly effectiveProfile: EffectiveSessionProfile | null;
  readonly archive: ReviewAttemptObservation["archive"] | null;
  readonly inconclusiveReason: string | null;
}

export interface ReviewerEvaluationMetricSet {
  readonly correctVerdicts: number | null;
  readonly falseApprovals: number | null;
  readonly falseChangesRequested: number | null;
  readonly inconclusive: number | null;
  readonly elapsedMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolFailures: number | null;
}

export interface ReviewerEvaluationProfileReport {
  readonly profile: string;
  readonly correctness: "passed" | "failed" | "unknown";
  readonly metrics: ReviewerEvaluationMetricSet;
  readonly runs: readonly ReviewerEvaluationRunReport[];
}

export interface ReviewerEvaluationReport {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly repositoryId: string;
  readonly subjectRole: "reviewer";
  readonly changedFactor: ReviewerEvaluationChangedFactor;
  readonly usineBuild: string;
  readonly reportPath: string;
  readonly baseline: ReviewerEvaluationProfileReport;
  readonly candidate: ReviewerEvaluationProfileReport;
  readonly comparison: {
    readonly baseline: ReviewerEvaluationMetricSet;
    readonly candidate: ReviewerEvaluationMetricSet;
    readonly delta: ReviewerEvaluationMetricSet;
  };
  readonly recommendation: "baseline" | "candidate" | "inconclusive";
  readonly inconclusiveReasons: readonly string[];
}

export interface ReviewerEvaluationReviewInput {
  readonly contract: ReviewerQualityGateInput["contract"];
  readonly candidateSha: string;
  readonly check: ReviewerQualityGateInput["check"];
  readonly profile: string;
  readonly repository: ReviewerQualityGateInput["repository"];
  readonly environment: NodeJS.ProcessEnv;
  readonly deadlineEpochMs: number;
  readonly cycle: number;
  readonly signal?: AbortSignal;
  readonly onObservation?: ReviewerQualityGateInput["onObservation"];
}

export interface ReviewerEvaluationArchiveManifest {
  readonly archiveId: string;
  readonly taskId: string;
  readonly role: "implementer" | "reviewer";
  readonly captureStatus: "stored" | "truncated" | "failed" | "pruned";
  readonly completeness: "complete" | "partial";
}

export interface ReviewerEvaluationServices {
  review(input: ReviewerEvaluationReviewInput): Promise<ReviewAttemptObservation>;
  readonly readArchiveManifest?: (
    archiveId: string,
    environment: NodeJS.ProcessEnv,
    expectedTaskId: string,
  ) => Promise<ReviewerEvaluationArchiveManifest | null>;
}

const defaultServices: ReviewerEvaluationServices = {
  review: reviewCandidateWithProfile,
  readArchiveManifest: async (archiveId, environment, _expectedTaskId) => {
    try {
      return toReviewerArchiveManifest(
        await readSessionArchiveManifest(stateDirectoryFromEnvironment(environment), archiveId),
      );
    } catch {
      return null;
    }
  },
};

export class ReviewerEvaluationValidationError extends Error {
  readonly code = "invalid_reviewer_evaluation_plan";
  readonly kind = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReviewerEvaluationValidationError";
  }
}

export async function readReviewerEvaluationPlan(
  planPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  plan: ReviewerEvaluationPlan;
  cases: readonly ReviewerEvaluationCaseInput[];
  registration: RepositorySnapshot;
  repositoryRoot: string;
  protectedPaths: readonly string[];
  profileSelections: {
    readonly baseline: Awaited<ReturnType<typeof resolveReviewerProfile>>;
    readonly candidate: Awaited<ReturnType<typeof resolveReviewerProfile>>;
  };
}> {
  const requestedPlanPath = resolve(planPath);
  const repositoryRoot = await repositoryRootFor(requestedPlanPath);
  const evaluationHead = await readHeadCommit(repositoryRoot);
  const absolutePlanPath = requestedPlanPath;
  const plan = normalizePlan(
    parseJson(
      await readCommittedUtf8(repositoryRoot, absolutePlanPath, "evaluation plan", evaluationHead),
    ),
  );
  validatePlanShape(plan);
  if (!(await isAncestor(repositoryRoot, plan.baseSha, evaluationHead)))
    throw new ReviewerEvaluationValidationError(
      "plan baseSha is not an ancestor of the evaluation Repository",
    );
  if ((await readUsineSourceCommit()) !== plan.usineBuild)
    throw new ReviewerEvaluationValidationError(
      "plan is bound to a different Usine source checkout commit",
    );

  const registrationPath = resolveCaseFile(
    repositoryRoot,
    resolve(dirname(absolutePlanPath), plan.registrationPath),
    "Repository registration",
  );
  const registration = await readRegistration(repositoryRoot, registrationPath);
  await validateRegistration(plan, registration, repositoryRoot);
  const reportPath = resolveCaseFile(repositoryRoot, plan.reportPath, "report");
  const protectedPaths = new Set([absolutePlanPath, registrationPath]);
  if (protectedPaths.has(reportPath))
    throw new ReviewerEvaluationValidationError(
      "report path must not replace the plan or Repository registration",
    );

  const cases: ReviewerEvaluationCaseInput[] = [];
  for (const item of plan.cases) {
    const contractPath = resolveCaseFile(repositoryRoot, item.contractPath, "Task Contract");
    const checkPath = resolveCaseFile(repositoryRoot, item.checkPath, "check evidence");
    const labelPath = resolveCaseFile(repositoryRoot, item.labelPath, "external label");
    protectedPaths.add(contractPath);
    protectedPaths.add(checkPath);
    protectedPaths.add(labelPath);
    if ([contractPath, checkPath, labelPath].includes(reportPath))
      throw new ReviewerEvaluationValidationError(
        `${item.id}:${item.repetition}: report path collides with case evidence`,
      );
    const contract = parseContract(
      await readCommittedUtf8(repositoryRoot, contractPath, "Task Contract", evaluationHead),
    );
    if (contract.repositoryId !== plan.repositoryId || contract.baseSha !== plan.baseSha)
      throw new ReviewerEvaluationValidationError(
        `${item.id}:${item.repetition}: Task Contract identity drifts from the plan`,
      );
    if (contract.authorization.merge === true)
      throw new ReviewerEvaluationValidationError(
        `${item.id}:${item.repetition}: evaluation contract must not grant merge authority`,
      );
    validateContractRepository(contract, registration, item.id);
    const candidateSha = await validateCandidate(repositoryRoot, plan.baseSha, item);
    const resolvedContract = resolveTaskContract(contract, registration);
    const check = parseCheck(
      await readCommittedUtf8(repositoryRoot, checkPath, "check evidence", evaluationHead),
      resolvedContract.projectCheck.command,
    );
    if (check.status !== "passed" || check.sha !== candidateSha)
      throw new ReviewerEvaluationValidationError(
        `${item.id}:${item.repetition}: check evidence must be passing for the exact Candidate SHA`,
      );
    const label = parseLabel(
      await readCommittedUtf8(repositoryRoot, labelPath, "external label", evaluationHead),
    );
    cases.push({
      case: item,
      contract: resolvedContract,
      candidateSha,
      check,
      label,
    });
  }

  await validateReportPath(repositoryRoot, reportPath, protectedPaths);

  const profileSelections = {
    baseline: await resolveReviewerProfile(plan.baselineProfile, environment),
    candidate: await resolveReviewerProfile(plan.candidateProfile, environment),
  };
  await requireHeadCommit(repositoryRoot, evaluationHead);
  validateProfileFactor(plan, profileSelections.baseline, profileSelections.candidate);
  return {
    plan,
    cases,
    registration,
    repositoryRoot,
    protectedPaths: [...protectedPaths],
    profileSelections,
  };
}

export async function runReviewerProfileEvaluateCommand(
  options: { readonly planPath: string; readonly json: boolean; readonly signal?: AbortSignal },
  environment: NodeJS.ProcessEnv = process.env,
  services: ReviewerEvaluationServices = defaultServices,
): Promise<void> {
  return runCommand("reviewer_profile_evaluate_failed", async () => {
    const loaded = await readReviewerEvaluationPlan(options.planPath, environment);
    const report = await executeReviewerProfileEvaluation(
      loaded,
      environment,
      options.signal,
      services,
    );
    const reportJson = `${JSON.stringify(report)}\n`;
    const path = resolve(loaded.repositoryRoot, loaded.plan.reportPath);
    await writeEvaluationReport(path, reportJson, loaded.repositoryRoot, loaded.protectedPaths);
    process.stdout.write(options.json ? reportJson : renderReport(report));
  });
}

export async function executeReviewerProfileEvaluation(
  loaded: Awaited<ReturnType<typeof readReviewerEvaluationPlan>>,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  services: ReviewerEvaluationServices = defaultServices,
): Promise<ReviewerEvaluationReport> {
  const reports: Record<"baseline" | "candidate", ReviewerEvaluationRunReport[]> = {
    baseline: [],
    candidate: [],
  };
  for (const item of loaded.cases) {
    for (const side of ["baseline", "candidate"] as const) {
      throwIfAborted(signal);
      const profile =
        side === "baseline" ? loaded.plan.baselineProfile : loaded.plan.candidateProfile;
      const startedAt = Date.now();
      let observation: ReviewAttemptObservation | null = null;
      let failure: string | null = null;
      let toolFailures = 0;
      try {
        observation = await services.review({
          contract: item.contract,
          candidateSha: item.candidateSha,
          check: item.check,
          profile,
          repository: loaded.registration,
          environment,
          deadlineEpochMs: startedAt + item.contract.budget.maxElapsedMs,
          cycle: item.case.repetition,
          signal,
          onObservation: (event) => {
            if (
              (event.type === "tool_completed" || event.type === "mcp_tool_completed") &&
              event.outcome === "failed"
            )
              toolFailures += 1;
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error instanceof Error ? error.message : "review execution failed";
      }
      reports[side].push(
        runReport(item, profile, observation, failure, Date.now() - startedAt, toolFailures),
      );
    }
  }
  await revalidateArchiveEvidence(loaded, environment, reports, services);
  return compareReviewerProfileEvaluation(loaded.plan, reports, {
    baseline: expectedProfile(loaded.profileSelections.baseline),
    candidate: expectedProfile(loaded.profileSelections.candidate),
  });
}

async function revalidateArchiveEvidence(
  loaded: Awaited<ReturnType<typeof readReviewerEvaluationPlan>>,
  environment: NodeJS.ProcessEnv,
  reports: Record<"baseline" | "candidate", ReviewerEvaluationRunReport[]>,
  services: ReviewerEvaluationServices,
): Promise<void> {
  const readManifest = services.readArchiveManifest ?? defaultServices.readArchiveManifest!;
  for (const side of ["baseline", "candidate"] as const) {
    for (const [index, run] of reports[side].entries()) {
      const archiveId = run.archive?.archiveId;
      if (!archiveId) continue;
      const item = loaded.cases[index];
      if (!item) continue;
      let manifest: ReviewerEvaluationArchiveManifest | null = null;
      try {
        manifest = await readManifest(archiveId, environment, item.contract.id);
      } catch {
        manifest = null;
      }
      const currentArchive =
        manifest &&
        manifest.archiveId === archiveId &&
        manifest.taskId === item.contract.id &&
        manifest.role === "reviewer"
          ? {
              archiveId: manifest.archiveId,
              status: manifest.captureStatus,
              completeness: manifest.completeness,
            }
          : null;
      reports[side][index] = withArchiveEvidence(run, currentArchive);
    }
  }
}

export function compareReviewerProfileEvaluation(
  plan: ReviewerEvaluationPlan,
  reports: Record<"baseline" | "candidate", ReviewerEvaluationRunReport[]>,
  expectedProfiles?: {
    readonly baseline: ExpectedReviewerProfile;
    readonly candidate: ExpectedReviewerProfile;
  },
): ReviewerEvaluationReport {
  const baseline = profileReport(
    plan.baselineProfile,
    reports.baseline,
    expectedProfiles?.baseline,
  );
  const candidate = profileReport(
    plan.candidateProfile,
    reports.candidate,
    expectedProfiles?.candidate,
  );
  const reasons = [...new Set([...baseline.reasons, ...candidate.reasons])].toSorted();
  const bothPassed = baseline.correctness === "passed" && candidate.correctness === "passed";
  if (
    bothPassed &&
    (!hasCompleteMetrics(baseline.metrics) || !hasCompleteMetrics(candidate.metrics))
  )
    reasons.push("comparison:missing_metrics");
  const recommendationReasons = reasons.filter(
    (reason) => !reason.endsWith(":protected_false_approval"),
  );
  const comparable = bothPassed && reasons.length === 0;
  const comparison = comparable
    ? {
        baseline: baseline.metrics,
        candidate: candidate.metrics,
        delta: metricDelta(baseline.metrics, candidate.metrics),
      }
    : { baseline: unknownMetrics(), candidate: unknownMetrics(), delta: unknownMetrics() };
  let recommendation: ReviewerEvaluationReport["recommendation"] = "inconclusive";
  if (
    recommendationReasons.length === 0 &&
    baseline.correctness === "passed" &&
    candidate.correctness === "failed"
  )
    recommendation = "baseline";
  else if (
    recommendationReasons.length === 0 &&
    baseline.correctness === "failed" &&
    candidate.correctness === "passed"
  )
    recommendation = "candidate";
  else if (comparable) {
    const candidateBetter = strictlyLessOrEqual(candidate.metrics, baseline.metrics);
    const baselineBetter = strictlyLessOrEqual(baseline.metrics, candidate.metrics);
    if (candidateBetter && !baselineBetter) recommendation = "candidate";
    else if (baselineBetter && !candidateBetter) recommendation = "baseline";
  }
  return {
    schemaVersion: 1,
    planId: plan.id,
    repositoryId: plan.repositoryId,
    subjectRole: "reviewer",
    changedFactor: plan.changedFactor,
    usineBuild: plan.usineBuild,
    reportPath: plan.reportPath,
    baseline: {
      profile: baseline.profile,
      correctness: baseline.correctness,
      metrics: baseline.metrics,
      runs: reports.baseline,
    },
    candidate: {
      profile: candidate.profile,
      correctness: candidate.correctness,
      metrics: candidate.metrics,
      runs: reports.candidate,
    },
    comparison,
    recommendation,
    inconclusiveReasons: reasons,
  };
}

interface ExpectedReviewerProfile {
  readonly configSha256: string;
  readonly model: string;
  readonly modelProvider: string | null;
  readonly reasoningEffort: EffectiveSessionProfile["reasoningEffort"];
  readonly developerInstructionsSha256: string | null;
  readonly adapter: EffectiveSessionProfile["adapter"];
}

function expectedProfile(
  selection: Awaited<ReturnType<typeof resolveReviewerProfile>>,
): ExpectedReviewerProfile {
  return {
    configSha256: selection.configSha256 ?? "",
    model: selection.model,
    modelProvider:
      typeof selection.config?.model_provider === "string" ? selection.config.model_provider : null,
    reasoningEffort: selection.modelReasoningEffort ?? null,
    developerInstructionsSha256: selection.developerInstructions
      ? createHash("sha256").update(selection.developerInstructions, "utf8").digest("hex")
      : null,
    adapter: selection.adapter,
  };
}

function profileReport(
  profile: string,
  runs: readonly ReviewerEvaluationRunReport[],
  expected?: ExpectedReviewerProfile,
): {
  profile: string;
  correctness: ReviewerEvaluationProfileReport["correctness"];
  metrics: ReviewerEvaluationMetricSet;
  reasons: string[];
} {
  let correctness: ReviewerEvaluationProfileReport["correctness"] = "passed";
  const reasons: string[] = [];
  for (const run of runs) {
    if (run.correctness === "incorrect") correctness = "failed";
    else if (run.correctness === "inconclusive" && correctness !== "failed")
      correctness = "unknown";
    if (run.inconclusiveReason) reasons.push(`${run.caseId}:${run.inconclusiveReason}`);
    if (run.hardRegression) reasons.push(`${run.caseId}:protected_false_approval`);
    const archiveReason = archiveEvidenceReason(run.archive);
    if (archiveReason) {
      if (correctness !== "failed") correctness = "unknown";
      reasons.push(`${run.caseId}:${archiveReason}`);
    }
    if (expected && !matchesExpectedProfile(run, profile, expected)) {
      if (correctness !== "failed") correctness = "unknown";
      reasons.push(`${run.caseId}:${profileEvidenceReason(run)}`);
    }
  }
  if (runs.length === 0) {
    correctness = "unknown";
    reasons.push(`${profile}:missing_runs`);
  }
  return { profile, correctness, metrics: aggregateMetrics(runs), reasons };
}

function profileEvidenceReason(
  run: ReviewerEvaluationRunReport,
): "reviewer_profile_missing" | "reviewer_profile_drift" {
  return run.requestedProfile === null || run.effectiveProfile === null
    ? "reviewer_profile_missing"
    : "reviewer_profile_drift";
}

function matchesExpectedProfile(
  run: ReviewerEvaluationRunReport,
  profile: string,
  expected: ExpectedReviewerProfile,
): boolean {
  const effective = run.effectiveProfile;
  return (
    run.requestedProfile === profile &&
    effective !== null &&
    effective.profileName === profile &&
    effective.configSha256 === expected.configSha256 &&
    effective.model === expected.model &&
    effective.modelProvider === expected.modelProvider &&
    effective.reasoningEffort === expected.reasoningEffort &&
    effective.developerInstructionsSha256 === expected.developerInstructionsSha256 &&
    effective.adapter === expected.adapter
  );
}

function aggregateMetrics(
  runs: readonly ReviewerEvaluationRunReport[],
): ReviewerEvaluationMetricSet {
  return {
    correctVerdicts: sum(
      runs.map((run) =>
        run.correctness === "correct" ? 1 : run.correctness === "incorrect" ? 0 : null,
      ),
    ),
    falseApprovals: sum(
      runs.map((run) =>
        run.correctness === "inconclusive"
          ? null
          : run.observed.verdict === "approved" && run.expected.verdict !== "approved"
            ? 1
            : 0,
      ),
    ),
    falseChangesRequested: sum(
      runs.map((run) =>
        run.correctness === "inconclusive"
          ? null
          : run.observed.verdict === "changes_requested" &&
              run.expected.verdict !== "changes_requested"
            ? 1
            : 0,
      ),
    ),
    inconclusive: sum(runs.map((run) => (run.correctness === "inconclusive" ? 1 : 0))),
    elapsedMs: sum(runs.map((run) => run.elapsedMs)),
    inputTokens: sum(runs.map((run) => run.inputTokens)),
    outputTokens: sum(runs.map((run) => run.outputTokens)),
    toolFailures: sum(runs.map((run) => run.toolFailures)),
  };
}

function runReport(
  item: ReviewerEvaluationCaseInput,
  profile: string,
  observation: ReviewAttemptObservation | null,
  failure: string | null,
  elapsedMs: number,
  observedToolFailures: number,
): ReviewerEvaluationRunReport {
  const verdict = observation?.review?.verdict ?? null;
  const actualSha = observation?.review?.sha ?? null;
  const correct = actualSha === item.candidateSha && verdict === item.label.verdict;
  const archiveReason = archiveEvidenceReason(observation?.archive ?? null);
  const incomplete =
    observation === null ||
    verdict === "inconclusive" ||
    actualSha !== item.candidateSha ||
    archiveReason !== null;
  const hardRegression =
    actualSha === item.candidateSha &&
    item.label.protected &&
    verdict === "approved" &&
    item.label.verdict !== "approved";
  const inconclusiveReason = failure
    ? "provider_failure"
    : actualSha !== null && actualSha !== item.candidateSha
      ? "stale_candidate_sha"
      : verdict === "inconclusive"
        ? "inconclusive_verdict"
        : observation === null
          ? "review_evidence_unavailable"
          : archiveReason;
  return {
    caseId: item.case.id,
    repetition: item.case.repetition,
    profile,
    candidateSha: item.candidateSha,
    expected: item.label,
    observed: {
      sha: actualSha,
      verdict,
      findingCount: observation?.review?.findings.length ?? null,
    },
    correctness: incomplete ? "inconclusive" : correct ? "correct" : "incorrect",
    hardRegression,
    elapsedMs,
    inputTokens: observation?.usage?.inputTokens ?? null,
    outputTokens: observation?.usage?.outputTokens ?? null,
    toolFailures: observation === null ? null : observedToolFailures,
    requestedProfile: safeProfileIdentity(observation?.requestedProfile),
    effectiveProfile: observation?.effectiveProfile
      ? sanitizeEffectiveProfile(observation.effectiveProfile)
      : null,
    archive: sanitizeArchiveEvidence(observation?.archive),
    inconclusiveReason,
  };
}

function withArchiveEvidence(
  run: ReviewerEvaluationRunReport,
  archive: ReviewerEvaluationRunReport["archive"],
): ReviewerEvaluationRunReport {
  const archiveReason = archiveEvidenceReason(archive);
  const priorReason = run.inconclusiveReason?.startsWith("reviewer_archive_")
    ? null
    : run.inconclusiveReason;
  const incomplete =
    priorReason !== null ||
    run.observed.verdict === "inconclusive" ||
    run.observed.sha !== run.candidateSha ||
    archiveReason !== null;
  const correct =
    run.observed.sha === run.candidateSha && run.observed.verdict === run.expected.verdict;
  return {
    ...run,
    archive,
    correctness: incomplete ? "inconclusive" : correct ? "correct" : "incorrect",
    hardRegression:
      run.observed.sha === run.candidateSha &&
      run.expected.protected &&
      run.observed.verdict === "approved" &&
      run.expected.verdict !== "approved",
    inconclusiveReason: priorReason ?? archiveReason,
  };
}

function toReviewerArchiveManifest(
  manifest: SessionArchiveManifest,
): ReviewerEvaluationArchiveManifest {
  return {
    archiveId: manifest.archiveId,
    taskId: manifest.taskId,
    role: manifest.role === "reviewer" ? "reviewer" : "implementer",
    captureStatus: manifest.captureStatus,
    completeness: manifest.completeness,
  };
}

function sanitizeEffectiveProfile(profile: EffectiveSessionProfile): EffectiveSessionProfile {
  return {
    profileName: safeProfileIdentity(profile.profileName),
    configSha256: safeSha256(profile.configSha256),
    adapter:
      profile.adapter === "sdk" ||
      profile.adapter === "app-server" ||
      profile.adapter === "opencode2"
        ? profile.adapter
        : null,
    model: safeExperimentalIdentity(profile.model),
    modelProvider: safeExperimentalIdentity(profile.modelProvider),
    reasoningEffort: safeReasoningEffort(profile.reasoningEffort),
    developerInstructionsSha256: safeSha256(profile.developerInstructionsSha256),
  };
}

function safeProfileIdentity(value: string | null | undefined): string | null {
  return typeof value === "string" && identifier.test(value) ? value : null;
}

function safeExperimentalIdentity(value: string | null): string | null {
  return typeof value === "string" && identifier.test(value) ? value : null;
}

function safeSha256(value: string | null): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeReasoningEffort(
  value: EffectiveSessionProfile["reasoningEffort"],
): EffectiveSessionProfile["reasoningEffort"] {
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : null;
}

function sanitizeArchiveEvidence(
  archive: ReviewAttemptObservation["archive"] | null | undefined,
): ReviewerEvaluationRunReport["archive"] {
  if (archive === null || archive === undefined || !archiveIdPattern.test(archive.archiveId))
    return null;
  if (!["stored", "truncated", "failed", "pruned"].includes(archive.status)) return null;
  if (
    archive.completeness !== undefined &&
    archive.completeness !== "complete" &&
    archive.completeness !== "partial"
  )
    return null;
  return {
    archiveId: archive.archiveId,
    status: archive.status,
    ...(archive.completeness ? { completeness: archive.completeness } : {}),
  };
}

function archiveEvidenceReason(
  archive: ReviewerEvaluationRunReport["archive"],
): "reviewer_archive_missing" | "reviewer_archive_failed" | "reviewer_archive_partial" | null {
  if (archive == null) return "reviewer_archive_missing";
  if (archive.status === "failed" || archive.status === "pruned") return "reviewer_archive_failed";
  if (archive.status === "truncated") return "reviewer_archive_partial";
  if (archive.completeness !== "complete") return "reviewer_archive_partial";
  return null;
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
  baseline: ReviewerEvaluationMetricSet,
  candidate: ReviewerEvaluationMetricSet,
): ReviewerEvaluationMetricSet {
  return {
    correctVerdicts: difference(baseline.correctVerdicts, candidate.correctVerdicts),
    falseApprovals: difference(baseline.falseApprovals, candidate.falseApprovals),
    falseChangesRequested: difference(
      baseline.falseChangesRequested,
      candidate.falseChangesRequested,
    ),
    inconclusive: difference(baseline.inconclusive, candidate.inconclusive),
    elapsedMs: difference(baseline.elapsedMs, candidate.elapsedMs),
    inputTokens: difference(baseline.inputTokens, candidate.inputTokens),
    outputTokens: difference(baseline.outputTokens, candidate.outputTokens),
    toolFailures: difference(baseline.toolFailures, candidate.toolFailures),
  };
}

function difference(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : right - left;
}

function unknownMetrics(): ReviewerEvaluationMetricSet {
  return {
    correctVerdicts: null,
    falseApprovals: null,
    falseChangesRequested: null,
    inconclusive: null,
    elapsedMs: null,
    inputTokens: null,
    outputTokens: null,
    toolFailures: null,
  };
}

function hasCompleteMetrics(metrics: ReviewerEvaluationMetricSet): boolean {
  return Object.values(metrics).every((value) => value !== null);
}

function strictlyLessOrEqual(
  left: ReviewerEvaluationMetricSet,
  right: ReviewerEvaluationMetricSet,
): boolean {
  return (
    left.correctVerdicts !== null &&
    right.correctVerdicts !== null &&
    left.correctVerdicts >= right.correctVerdicts &&
    left.falseApprovals !== null &&
    right.falseApprovals !== null &&
    left.falseApprovals <= right.falseApprovals &&
    left.falseChangesRequested !== null &&
    right.falseChangesRequested !== null &&
    left.falseChangesRequested <= right.falseChangesRequested &&
    left.inconclusive !== null &&
    right.inconclusive !== null &&
    left.inconclusive <= right.inconclusive &&
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

function validatePlanShape(plan: ReviewerEvaluationPlan): void {
  if (!identifier.test(plan.id) || !identifier.test(plan.repositoryId))
    throw new ReviewerEvaluationValidationError("plan identifiers are invalid");
  if (!exactSha.test(plan.baseSha) || !exactSha.test(plan.usineBuild))
    throw new ReviewerEvaluationValidationError("plan SHAs must be lowercase 40-character values");
  if (plan.subjectRole !== "reviewer")
    throw new ReviewerEvaluationValidationError("subjectRole must be reviewer");
  if (!profileName.test(plan.baselineProfile) || !profileName.test(plan.candidateProfile))
    throw new ReviewerEvaluationValidationError("reviewer profile names are invalid");
  if (plan.baselineProfile === plan.candidateProfile)
    throw new ReviewerEvaluationValidationError(
      "baseline and candidate reviewer profiles must differ",
    );
  if (!Number.isSafeInteger(plan.maxRuns) || plan.maxRuns < 2 || plan.maxRuns > 200)
    throw new ReviewerEvaluationValidationError("maxRuns must be between 2 and 200");
  if (plan.cases.length === 0 || plan.cases.length * 2 > plan.maxRuns)
    throw new ReviewerEvaluationValidationError("plan exceeds its maximum-run bound");
  if (
    plan.reportPath.trim() === "" ||
    isAbsolute(plan.reportPath) ||
    plan.registrationPath.trim() === ""
  )
    throw new ReviewerEvaluationValidationError(
      "report and registration paths must be repository-relative",
    );
  const identities = new Set<string>();
  for (const item of plan.cases) {
    const identity = `${item.id}:${item.repetition}`;
    if (
      !identifier.test(item.id) ||
      !Number.isSafeInteger(item.repetition) ||
      item.repetition < 1 ||
      identities.has(identity)
    )
      throw new ReviewerEvaluationValidationError("case identities are invalid or duplicated");
    identities.add(identity);
    if (!exactSha.test(item.candidateSha))
      throw new ReviewerEvaluationValidationError(`${identity}: Candidate SHA is invalid`);
  }
}

function normalizePlan(input: unknown): ReviewerEvaluationPlan {
  try {
    return decodeReviewerEvaluationPlan(input);
  } catch {
    throw new ReviewerEvaluationValidationError("evaluation plan has missing or invalid fields");
  }
}

function parseContract(raw: string): TaskContract {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ReviewerEvaluationValidationError("Task Contract is not JSON");
  }
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) throw new ReviewerEvaluationValidationError("Task Contract is invalid");
  return parsed.data;
}

function parseCheck(raw: string, projectCheckCommand: string): CheckResult {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ReviewerEvaluationValidationError("check evidence is not JSON");
  }
  let check: ReturnType<typeof decodeReviewerEvaluationCheck>;
  try {
    check = decodeReviewerEvaluationCheck(input);
  } catch {
    throw new ReviewerEvaluationValidationError("check evidence is invalid");
  }
  if (
    !exactSha.test(check.sha) ||
    check.status !== "passed" ||
    !Number.isSafeInteger(check.exitCode) ||
    check.exitCode !== 0 ||
    check.command !== projectCheckCommand
  )
    throw new ReviewerEvaluationValidationError(
      "check evidence identity, status, exit code, or project command is invalid",
    );
  return {
    sha: check.sha,
    status: "passed",
    command: check.command,
    exitCode: check.exitCode,
    stdout: check.stdout,
    stderr: check.stderr,
  };
}

function parseLabel(raw: string): ReviewerEvaluationLabel {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ReviewerEvaluationValidationError("external label is not JSON");
  }
  let label: ReturnType<typeof decodeReviewerEvaluationLabel>;
  try {
    label = decodeReviewerEvaluationLabel(input);
  } catch {
    throw new ReviewerEvaluationValidationError("external label is invalid");
  }
  if (label.rationale.trim() === "" || label.reference.trim() === "")
    throw new ReviewerEvaluationValidationError(
      "external label rationale and reference are required",
    );
  return {
    verdict: label.verdict,
    rationale: label.rationale,
    reference: label.reference,
    protected: label.protected ?? false,
  };
}

async function resolveReviewerProfile(profile: string, environment: NodeJS.ProcessEnv) {
  try {
    const selection = await resolveCodexProfile(profile, environment);
    if (!selection.config) throw new Error("configuration unavailable");
    return {
      ...selection,
      adapter: codingSessionAdapterForProfile(
        profile,
        codingSessionAdapterProfilesFromEnvironment(environment),
      ),
    };
  } catch (error) {
    if (error instanceof CodingSessionAdapterConfigurationError) throw error;
    throw new ReviewerEvaluationValidationError(
      `${profile}: resolved profile configuration is unavailable`,
    );
  }
}

function validateProfileFactor(
  plan: ReviewerEvaluationPlan,
  baseline: Awaited<ReturnType<typeof resolveReviewerProfile>>,
  candidate: Awaited<ReturnType<typeof resolveReviewerProfile>>,
): void {
  const admission = admitProfilePair({
    changedFactor: plan.changedFactor,
    baseline: profilePairFieldSnapshot(baseline),
    candidate: profilePairFieldSnapshot(candidate),
  });
  if (admission.accepted) return;
  if (admission.reason === "unchanged_factor")
    throw new ReviewerEvaluationValidationError(
      `profiles do not differ in changedFactor ${plan.changedFactor}`,
    );
  throw new ReviewerEvaluationValidationError(
    `profiles differ outside changedFactor ${plan.changedFactor}: ${admission.fields.join(",")}`,
  );
}

function validateContractRepository(
  contract: TaskContract,
  registration: RepositorySnapshot,
  id: string,
): void {
  const url = new URL(contract.authorization.source);
  const [, owner, name] = url.pathname.split("/");
  if (
    owner?.toLowerCase() !== registration.owner.toLowerCase() ||
    name?.toLowerCase() !== registration.name.toLowerCase()
  )
    throw new ReviewerEvaluationValidationError(
      `${id}: Task Contract authorization Repository drifts from registration`,
    );
}

async function validateCandidate(
  repositoryRoot: string,
  baseSha: string,
  item: ReviewerEvaluationCase,
): Promise<string> {
  try {
    await execFile("git", [
      "-C",
      repositoryRoot,
      "cat-file",
      "-e",
      `${item.candidateSha}^{commit}`,
    ]);
    await execFile("git", [
      "-C",
      repositoryRoot,
      "merge-base",
      "--is-ancestor",
      baseSha,
      item.candidateSha,
    ]);
  } catch {
    throw new ReviewerEvaluationValidationError(
      `${item.id}:${item.repetition}: Candidate SHA is not a frozen descendant of baseSha`,
    );
  }
  return item.candidateSha;
}

async function readRegistration(repositoryRoot: string, path: string): Promise<RepositorySnapshot> {
  try {
    await assertSafeFilePath(repositoryRoot, path, "Repository registration");
  } catch {
    throw new ReviewerEvaluationValidationError(
      "Repository registration must be a regular non-symlink file",
    );
  }
  try {
    return repositoryRegistrationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new ReviewerEvaluationValidationError("Repository registration is unreadable or invalid");
  }
}

async function validateRegistration(
  plan: ReviewerEvaluationPlan,
  registration: RepositorySnapshot,
  repositoryRoot: string,
): Promise<void> {
  if (
    registration.id !== plan.repositoryId ||
    (await realpath(registration.path).catch(() => registration.path)) !==
      (await realpath(repositoryRoot).catch(() => repositoryRoot))
  )
    throw new ReviewerEvaluationValidationError(
      "evaluation Repository registration does not match the plan",
    );
}

async function repositoryRootFor(path: string): Promise<string> {
  try {
    const gitRoot = (
      await execFile("git", ["-C", dirname(path), "rev-parse", "--show-toplevel"])
    ).stdout.trim();
    const realDirectory = await realpath(dirname(path));
    return resolve(dirname(path), relative(realDirectory, gitRoot));
  } catch {
    throw new ReviewerEvaluationValidationError("evaluation plan is not inside a Git Repository");
  }
}

async function readHeadCommit(repositoryRoot: string): Promise<string> {
  try {
    const head = (
      await execFile("git", ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (!exactSha.test(head)) throw new Error("invalid HEAD");
    return head;
  } catch {
    throw new ReviewerEvaluationValidationError("evaluation Repository HEAD is unavailable");
  }
}

async function requireHeadCommit(repositoryRoot: string, expectedHead: string): Promise<void> {
  if ((await readHeadCommit(repositoryRoot)) !== expectedHead)
    throw new ReviewerEvaluationValidationError(
      "evaluation Repository HEAD changed during validation",
    );
}

async function isAncestor(
  repositoryRoot: string,
  sha: string,
  descendant = "HEAD",
): Promise<boolean> {
  try {
    await execFile("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", sha, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function readUsineSourceCommit(): Promise<string> {
  try {
    return (
      await execFile("git", ["-C", usineSourceRoot, "rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
  } catch {
    throw new ReviewerEvaluationValidationError("Usine source checkout commit is unavailable");
  }
}

async function readCommittedUtf8(
  repositoryRoot: string,
  path: string,
  label: string,
  expectedHead: string,
): Promise<string> {
  const relativePath = relative(repositoryRoot, path);
  try {
    await assertSafeFilePath(repositoryRoot, path, label);
    const tracked = await execFile("git", [
      "-C",
      repositoryRoot,
      "ls-files",
      "--stage",
      "--error-unmatch",
      "--",
      relativePath,
    ]);
    const entry = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(tracked.stdout.trim());
    if (!(entry && ["100644", "100755"].includes(entry[1]!) && entry[2] === relativePath))
      throw new Error("file is not a tracked regular file");
    const headBlob = await gitBlobAt(repositoryRoot, expectedHead, relativePath);
    const bytes = await readFile(path);
    const actualBlob = createHash("sha1")
      .update(`blob ${bytes.length}\0`, "utf8")
      .update(bytes)
      .digest("hex");
    if (headBlob !== actualBlob) throw new Error("file is not bound to the evaluation HEAD");
    await execFile("git", [
      "-C",
      repositoryRoot,
      "diff",
      "--quiet",
      expectedHead,
      "--",
      relativePath,
    ]);
    return bytes.toString("utf8");
  } catch {
    throw new ReviewerEvaluationValidationError(label + " must be committed and unchanged");
  }
}

async function gitBlobAt(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): Promise<string> {
  return (
    await execFile("git", ["-C", repositoryRoot, "rev-parse", `${commit}:${relativePath}`])
  ).stdout.trim();
}

async function assertSafeFilePath(
  repositoryRoot: string,
  path: string,
  label: string,
): Promise<void> {
  const pathRelative = relative(repositoryRoot, path);
  if (pathRelative === "" || pathRelative.startsWith("..") || isAbsolute(pathRelative))
    throw new ReviewerEvaluationValidationError(
      `${label} must be inside the evaluation Repository`,
    );
  let rootEntry;
  try {
    rootEntry = await lstat(repositoryRoot);
  } catch {
    throw new ReviewerEvaluationValidationError(label + " has an unsafe Repository root");
  }
  if (rootEntry.isSymbolicLink())
    throw new ReviewerEvaluationValidationError(label + " must not use symbolic links");
  if (!rootEntry.isDirectory())
    throw new ReviewerEvaluationValidationError(label + " has a non-directory Repository root");
  let current = repositoryRoot;
  for (const component of pathRelative.split("/")) {
    current = join(current, component);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ReviewerEvaluationValidationError(`${label} is unsafe`);
    }
    if (entry.isSymbolicLink())
      throw new ReviewerEvaluationValidationError(`${label} must not use symbolic links`);
    if (current !== path && !entry.isDirectory())
      throw new ReviewerEvaluationValidationError(`${label} has a non-directory ancestor`);
    if (current === path && !entry.isFile())
      throw new ReviewerEvaluationValidationError(`${label} must be a regular file`);
  }
}

async function validateReportPath(
  repositoryRoot: string,
  reportPath: string,
  protectedPaths: Iterable<string> = [],
): Promise<void> {
  await assertSafeFilePath(repositoryRoot, reportPath, "report");
  let reportStat;
  try {
    reportStat = await lstat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ReviewerEvaluationValidationError("report path is unsafe");
  }
  for (const protectedPath of protectedPaths) {
    try {
      const protectedStat = await lstat(protectedPath);
      if (reportStat.dev === protectedStat.dev && reportStat.ino === protectedStat.ino)
        throw new ReviewerEvaluationValidationError("report path must not replace protected input");
    } catch (error) {
      if (error instanceof ReviewerEvaluationValidationError) throw error;
      throw new ReviewerEvaluationValidationError("protected input is unavailable");
    }
  }
}

async function writeEvaluationReport(
  path: string,
  report: string,
  repositoryRoot: string,
  protectedPaths: readonly string[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await validateReportPath(repositoryRoot, path, protectedPaths);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, report, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await validateReportPath(repositoryRoot, path, protectedPaths);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function resolveCaseFile(root: string, path: string, label: string): string {
  const resolved = resolve(root, path);
  if (
    relative(root, resolved).startsWith("..") ||
    isAbsolute(relative(root, resolved)) ||
    resolved === root
  )
    throw new ReviewerEvaluationValidationError(
      `${label} must be inside the evaluation Repository`,
    );
  return resolved;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReviewerEvaluationValidationError("evaluation plan is not JSON");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("reviewer profile evaluation cancelled");
}

function renderReport(report: ReviewerEvaluationReport): string {
  return [
    `Reviewer profile evaluation ${report.planId}: ${report.recommendation}`,
    `Baseline (${report.baseline.profile}): ${report.baseline.correctness}`,
    `Candidate (${report.candidate.profile}): ${report.candidate.correctness}`,
    `Comparison: ${JSON.stringify(report.comparison)}`,
    ...(report.inconclusiveReasons.length > 0
      ? [`Inconclusive reasons: ${report.inconclusiveReasons.join(", ")}`]
      : []),
    "",
  ].join("\n");
}
