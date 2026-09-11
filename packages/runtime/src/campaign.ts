import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { Predicate, Schema } from "effect";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import {
  applyMigrations,
  acceptedTaskDelivery,
  campaignAssessmentSchema,
  campaignAssessments,
  campaignModelRuns,
  campaignReplacementRuns,
  campaignAssessmentUsageSchema,
  campaignIdFor,
  campaignProposals,
  campaignTouches,
  campaigns,
  campaignResourceFromContract,
  decodeCampaignDecisionRequest,
  decodePersistedTaskProposal,
  decodePersistedGoalContract,
  decodeCampaignProposalStatus,
  decodeCampaignStatus,
  goalContractSchema,
  hashTaskContract,
  openSqliteDatabase,
  parseTaskProposal,
  repositoryIdentity,
  TaskAuthority,
  TaskCapacityError,
  RepositoryWriterConflictError,
  repositories,
  isTaskStateQuarantinedError,
  type CampaignProposalResource,
  type CampaignDecisionRequest,
  type CampaignOutcomeEvidence,
  type CampaignAssessment,
  type CampaignAssessmentEvidence,
  type CampaignAssessmentUsage,
  type CampaignAssessmentFact,
  type CampaignUsageSource,
  type CampaignResource,
  type GoalContract,
  type TaskExecutionInput,
  type TaskResult,
  type TaskContract,
  type TaskProposal,
  taskProposalSchema,
  isTerminalState,
} from "@usine/task-authority";
import type {
  CampaignAssessmentRequest,
  CampaignAssessmentDraft,
  CampaignOutcomeAssessor,
} from "./campaign-assessor.js";
import type {
  CampaignReplacementDraft,
  CampaignReplacementGenerator,
  CampaignReplacementRequest,
} from "./campaign-replacement.js";
import type { CampaignModelRunDraft } from "./campaign-model-run.js";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { ensurePrivateStateDatabase } from "./private-state.js";
import { readCommittedContract } from "./verify-committed-contract.js";

export const MAX_GOAL_CONTRACT_BYTES = 1_048_576;
export const GOAL_PUBLICATION_SOURCE_ENV = "USINE_GOAL_PUBLICATION_SOURCE";
export const CAMPAIGN_ABANDONMENT_SOURCE_ENV = "USINE_CAMPAIGN_ABANDONMENT_SOURCE";
const GOAL_CONTRACT_INGESTION_TIMEOUT_MS = 30_000;
const EXACT_SHA = /^[0-9a-f]{40}$/;
const MAX_CAMPAIGN_DELIVERY_TITLE_LENGTH = 256;
const ESCAPE_CHARACTER = String.fromCodePoint(0x1b);
const BELL_CHARACTER = String.fromCodePoint(0x07);
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\))`,
  "gu",
);
const SAFE_CAMPAIGN_TOUCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAMPAIGN_COMPATIBILITY_ADAPTERS = new Set([
  "campaign-usage-compatibility",
  "legacy-compatibility",
]);

export class GoalContractInputError extends Error {
  readonly code = "validation";
  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }> = [],
  ) {
    super(message);
    this.name = "GoalContractInputError";
  }
}

export class CampaignContentConflictError extends Error {
  readonly code = "campaign_content_conflict";
  readonly retryable = false;
  constructor(readonly campaignId: string) {
    super("goal publication identity is already bound to different content");
    this.name = "CampaignContentConflictError";
  }
}

export const CAMPAIGN_STATE_QUARANTINE_DIAGNOSTIC = "durable Campaign state quarantined";

export class CampaignStateQuarantinedError extends Error {
  readonly code = "campaign_state_quarantined";

  constructor(readonly campaignId: string) {
    super(CAMPAIGN_STATE_QUARANTINE_DIAGNOSTIC);
    this.name = "CampaignStateQuarantinedError";
  }
}

export function isCampaignStateQuarantinedError(
  error: unknown,
): error is CampaignStateQuarantinedError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "CampaignStateQuarantinedError" &&
    "code" in error &&
    error.code === "campaign_state_quarantined"
  );
}

interface CampaignStateInput {
  readonly campaignId: string;
  readonly status: unknown;
  readonly decisionRequest: unknown;
}

interface DecodedCampaignState {
  readonly status: ReturnType<typeof decodeCampaignStatus>;
  readonly decisionRequest: CampaignDecisionRequest | null;
}

export function decodeCampaignState(input: CampaignStateInput): DecodedCampaignState {
  try {
    return {
      status: decodeCampaignStatus(input.status),
      decisionRequest: decodeCampaignDecisionRequest(input.decisionRequest),
    };
  } catch {
    throw new CampaignStateQuarantinedError(input.campaignId);
  }
}

export class CampaignProposalConflictError extends Error {
  readonly code = "campaign_proposal_conflict";
  readonly retryable = false;
  constructor(readonly proposalId: string) {
    super("proposal identity is already bound to different content");
    this.name = "CampaignProposalConflictError";
  }
}

export class CampaignNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("campaign not found");
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignTouchInputError extends Error {
  readonly code = "validation";
  constructor() {
    super("campaign touch ID is invalid");
    this.name = "CampaignTouchInputError";
  }
}

export class CampaignHandoffError extends Error {
  readonly code = "campaign_handoff_conflict";
  readonly retryable = false;
  constructor(readonly campaignId: string) {
    super("Campaign plan has already been handed off or is terminal");
    this.name = "CampaignHandoffError";
  }
}

export class CampaignAbandonmentError extends Error {
  readonly code = "campaign_abandonment_unauthorized";
  readonly retryable = false;
  constructor() {
    super("Campaign abandonment requires explicit host authority");
    this.name = "CampaignAbandonmentError";
  }
}

export class CampaignCheckpointError extends Error {
  readonly code = "campaign_checkpoint_conflict";
  readonly retryable = false;
  constructor(readonly campaignId: string) {
    super("Campaign checkpoint requires a handed-off nonterminal plan");
    this.name = "CampaignCheckpointError";
  }
}

export function parseGoalContract(rawContract: string): GoalContract {
  let input: unknown;
  try {
    input = JSON.parse(rawContract);
  } catch {
    throw new GoalContractInputError("goal contract must be JSON", [
      { path: "", message: "contract input is unreadable or invalid JSON" },
    ]);
  }
  const parsed = goalContractSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new GoalContractInputError(`invalid goal contract: ${JSON.stringify(issues)}`, issues);
  }
  return parsed.data;
}

export async function readGoalContract(
  contractPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly rawContract: string; readonly contract: GoalContract }> {
  const deadlineEpochMs = Date.now() + GOAL_CONTRACT_INGESTION_TIMEOUT_MS;
  const gitEnvironment = credentialFreeGitEnvironment(environment);
  let repositoryPath: string;
  try {
    repositoryPath = (
      await execa("git", ["-C", dirname(contractPath), "rev-parse", "--show-toplevel"], {
        env: gitEnvironment,
        extendEnv: false,
        timeout: GOAL_CONTRACT_INGESTION_TIMEOUT_MS,
      })
    ).stdout.trim();
  } catch {
    throw new GoalContractInputError("goal contract must be a committed file in a Git repository");
  }
  let rawContract: string;
  try {
    rawContract = (
      await readCommittedContract(
        contractPath,
        repositoryPath,
        deadlineEpochMs,
        gitEnvironment,
        MAX_GOAL_CONTRACT_BYTES,
      )
    ).rawContract;
  } catch (error) {
    throw new GoalContractInputError(
      error instanceof Error
        ? error.message.replaceAll("task contract", "goal contract")
        : "goal contract is not committed",
    );
  }
  return { rawContract, contract: parseGoalContract(rawContract) };
}

function hostAuthorized(contract: GoalContract, environment: NodeJS.ProcessEnv): boolean {
  const configured = environment[GOAL_PUBLICATION_SOURCE_ENV]?.trim();
  return (
    configured !== undefined && configured.length > 0 && configured === contract.authority.source
  );
}

type CampaignUsageProjection = {
  readonly usage: CampaignAssessmentUsage | null;
  readonly source: CampaignUsageSource;
};

function decodeCampaignUsage(input: unknown): CampaignAssessmentUsage | null {
  try {
    return input === null || input === undefined
      ? null
      : Schema.decodeUnknownSync(Schema.NullOr(campaignAssessmentUsageSchema))(input);
  } catch {
    return null;
  }
}

function campaignUsageProjection(
  modelRun: typeof campaignModelRuns.$inferSelect | undefined,
  legacyUsage: unknown,
): CampaignUsageProjection {
  if (modelRun)
    return {
      usage: decodeCampaignUsage(modelRun.usage),
      source: CAMPAIGN_COMPATIBILITY_ADAPTERS.has(modelRun.adapter ?? "")
        ? "legacy_compatibility"
        : "model_run",
    };
  const compatibilityUsage = decodeCampaignUsage(legacyUsage);
  return compatibilityUsage
    ? { usage: compatibilityUsage, source: "legacy_compatibility" }
    : { usage: null, source: "unavailable" };
}

function proposalResource(
  row: typeof campaignProposals.$inferSelect,
  replacementRun: typeof campaignReplacementRuns.$inferSelect | undefined,
  modelRun: typeof campaignModelRuns.$inferSelect | undefined,
): CampaignProposalResource {
  const proposal = decodePersistedTaskProposal(row.proposal);
  const replacement =
    row.replacementAssessmentId && row.replacementEvidenceHash
      ? {
          assessmentId: row.replacementAssessmentId,
          evidenceHash: row.replacementEvidenceHash,
          role: "replacement-planner" as const,
          ...(() => {
            const projection = campaignUsageProjection(
              modelRun,
              replacementRun?.usage ?? row.replacementUsage,
            );
            return { usage: projection.usage, usageSource: projection.source };
          })(),
        }
      : undefined;
  return {
    proposalId: row.proposalId,
    outcomeId: row.outcomeId,
    sequence: row.sequence,
    status: decodeCampaignProposalStatus(row.status),
    blocker: row.blocker,
    ...(row.supersededByProposalId ? { supersededByProposalId: row.supersededByProposalId } : {}),
    ...(row.supersedesProposalId ? { supersedesProposalId: row.supersedesProposalId } : {}),
    ...(replacement ? { replacement } : {}),
    ready:
      row.readyBaseSha === null || row.readyRepositoryRevision === null
        ? null
        : {
            repositoryId: proposal.repositoryId,
            baseSha: row.readyBaseSha,
            repositoryRevision: row.readyRepositoryRevision,
            taskId: row.taskId,
            instructions: proposal.instructions,
            acceptance: proposal.acceptance,
            nonGoals: proposal.nonGoals,
            effects: proposal.effects,
            ...(proposal.delivery ? { delivery: proposal.delivery } : {}),
            merge: proposal.merge,
          },
  };
}

export interface CampaignTaskAdmission {
  readonly result: TaskResult;
  readonly input: TaskExecutionInput;
  readonly contract: TaskContract;
}

export type CampaignModelWork = (signal: AbortSignal) => Promise<boolean>;

export interface CampaignReconciliationOptions {
  /** Run Campaign-only model work in the server-owned lifecycle. */
  readonly launchModelWork?: (work: CampaignModelWork) => void;
}

function campaignTaskId(contract: GoalContract, proposal: TaskProposal): string {
  const readable = `campaign-${contract.id}-v${contract.version}-${proposal.proposalId}`;
  return readable.length <= 128
    ? readable
    : `campaign-${createHash("sha256").update(readable, "utf8").digest("hex")}`;
}

function campaignTaskContract(
  contract: GoalContract,
  proposal: TaskProposal,
  taskId: string,
  baseSha: string,
): TaskContract {
  const outcome = contract.outcomes.find((candidate) => candidate.id === proposal.outcomeId);
  const outcomeTitle = sanitizeCampaignDeliveryText(outcome?.title ?? "Authorized outcome");
  const deliveryTitle = outcomeTitle.slice(0, MAX_CAMPAIGN_DELIVERY_TITLE_LENGTH).trimEnd();
  const acceptance = proposal.acceptance.map(sanitizeCampaignDeliveryText);
  const goalIssue = canonicalGitHubIssueSource(contract.authority.source);
  const deliveryBody = [
    `Outcome: ${outcomeTitle || "Authorized outcome"}`,
    "",
    "Acceptance criteria:",
    ...acceptance.map((criterion) => `- ${criterion}`),
    ...(goalIssue ? ["", `Goal: ${goalIssue}`] : []),
  ].join("\n");
  const task: TaskContract = {
    id: taskId,
    repositoryId: proposal.repositoryId,
    baseSha,
    instructions: proposal.instructions,
    acceptance: [...proposal.acceptance],
    nonGoals: [...proposal.nonGoals],
    budget: {
      maxImplementerActivations: null,
      maxReviewCycles: null,
      maxElapsedMs: null,
    },
    authorization: {
      source: contract.authority.source,
      delivery: true,
      ...(proposal.merge ? { merge: true } : {}),
    },
    delivery: {
      branch: `agent/${taskId}`,
      ...(proposal.delivery ? { issue: proposal.delivery.issue } : {}),
      title: deliveryTitle || "Authorized outcome",
      body: deliveryBody,
    },
    campaign: {
      campaignId: campaignIdFor(contract.id, contract.version),
      goalId: contract.id,
      goalVersion: contract.version,
      outcomeId: proposal.outcomeId,
    },
  };
  return task;
}

function sanitizeCampaignDeliveryText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalGitHubIssueSource(source: string): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/");
  if (
    source !== url.href ||
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 5 ||
    segments[0] !== "" ||
    segments[1] === "" ||
    segments[2] === "" ||
    segments[3] !== "issues" ||
    !/^\d+$/.test(segments[4] ?? "") ||
    Number(segments[4]) <= 0
  )
    return null;
  return source;
}

function blockerFor(
  row: typeof campaignProposals.$inferSelect,
  proposal: TaskProposal,
  contract: GoalContract,
  publicationAuthorized: boolean,
  superseded: boolean,
  repository: typeof repositories.$inferSelect | undefined,
  observedRepositoryIds: ReadonlySet<string>,
): string | null {
  const outcome = contract.outcomes.find((candidate) => candidate.id === proposal.outcomeId);
  if (!publicationAuthorized) return "goal publication is not host-authorized";
  if (superseded) return "goal publication is superseded";
  if (!outcome || outcome.status === "superseded") return "proposal outcome is not live";
  if (!contract.authority.repositories.includes(proposal.repositoryId))
    return "proposal repository is outside the Goal authority envelope";
  if (!contract.authority.delivery) return "Goal delivery authority is not granted";
  if (proposal.effects.some((effect) => !contract.authority.effects.includes(effect)))
    return "proposal effect is outside the Goal authority envelope";
  if (proposal.merge && !contract.authority.merge)
    return "proposal merge authority is outside the Goal authority envelope";
  const hasDurableReadyBase = row.readyBaseSha !== null && row.readyRepositoryRevision !== null;
  if (!repository && !hasDurableReadyBase) return "proposal repository is not registered";
  if (
    !hasDurableReadyBase &&
    (!repository ||
      !observedRepositoryIds.has(repository.id) ||
      !repository.headSha ||
      !EXACT_SHA.test(repository.headSha))
  )
    return "registered repository has no exact head";
  return null;
}

interface AcceptedCampaignDelivery {
  readonly delivery: NonNullable<ReturnType<typeof acceptedTaskDelivery>>["delivery"];
  readonly mergedHeadSha: string | null;
}

interface DependencyResolution {
  readonly blocker: string | null;
  readonly baseSha: string | null;
}

type CampaignTaskFacts = Map<string, TaskResult | null>;

function acceptedCampaignDelivery(
  result: TaskResult | null,
  campaign: typeof campaigns.$inferSelect,
  contract: GoalContract,
  proposal: TaskProposal,
): AcceptedCampaignDelivery | null {
  const association = result?.campaign;
  const accepted = acceptedTaskDelivery(result);
  if (
    !result ||
    !accepted ||
    !association ||
    result.taskId !== campaignTaskId(contract, proposal) ||
    association.campaignId !== campaign.campaignId ||
    association.goalId !== campaign.goalId ||
    association.goalVersion !== campaign.goalVersion ||
    association.outcomeId !== proposal.outcomeId ||
    result.repository?.id !== proposal.repositoryId ||
    result.mergeAuthorized !== proposal.merge
  )
    return null;
  return { delivery: accepted.delivery, mergedHeadSha: accepted.mergedHeadSha };
}

async function dependencyResolution(
  proposal: TaskProposal,
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  contract: GoalContract,
  campaign: typeof campaigns.$inferSelect,
  database: CampaignDatabase,
  taskFacts: CampaignTaskFacts,
): Promise<DependencyResolution> {
  const dependencies = new Map<string, typeof campaignProposals.$inferSelect>();
  const proposalDependencyIds = new Set<string>();
  for (const dependency of proposal.dependsOn) {
    const row = rows.find((candidate) => candidate.proposalId === dependency);
    if (!row || row.status === "superseded")
      return { blocker: "proposal dependency is not admitted", baseSha: null };
    dependencies.set(row.proposalId, row);
    proposalDependencyIds.add(row.proposalId);
  }
  const outcome = contract.outcomes.find((candidate) => candidate.id === proposal.outcomeId);
  const outcomeDependencyIds = new Set<string>();
  for (const dependency of outcome?.dependsOn ?? []) {
    outcomeDependencyIds.add(dependency);
    let found = false;
    for (const row of rows) {
      if (
        row.status !== "superseded" &&
        decodePersistedTaskProposal(row.proposal).outcomeId === dependency
      ) {
        dependencies.set(row.proposalId, row);
        found = true;
      }
    }
    if (!found) return { blocker: "outcome dependency has no admitted proposal", baseSha: null };
  }

  let mergedHeadSha: string | null = null;
  let latestMergedSequence = -1;
  for (const row of dependencies.values()) {
    const predecessor = decodePersistedTaskProposal(row.proposal);
    const task = row.taskId ? await campaignTaskLookup(database, row.taskId, taskFacts) : null;
    const accepted = acceptedCampaignDelivery(task, campaign, contract, predecessor);
    if (!accepted)
      return {
        blocker: proposalDependencyIds.has(row.proposalId)
          ? "proposal dependency has no accepted delivery"
          : outcomeDependencyIds.has(predecessor.outcomeId)
            ? "outcome dependency has no accepted delivery"
            : "dependency has no accepted delivery",
        baseSha: null,
      };
    if (predecessor.repositoryId === proposal.repositoryId && !accepted.mergedHeadSha)
      return {
        blocker: proposalDependencyIds.has(row.proposalId)
          ? "same-Repository dependency has no accepted merge"
          : outcomeDependencyIds.has(predecessor.outcomeId)
            ? "same-Repository outcome dependency has no accepted merge"
            : "same-Repository dependency has no accepted merge",
        baseSha: null,
      };
    if (
      accepted.mergedHeadSha &&
      predecessor.repositoryId === proposal.repositoryId &&
      row.sequence > latestMergedSequence
    ) {
      mergedHeadSha = accepted.mergedHeadSha;
      latestMergedSequence = row.sequence;
    }
  }

  if (!mergedHeadSha) return { blocker: null, baseSha: null };
  return { blocker: null, baseSha: mergedHeadSha };
}

type CampaignDatabase = ReturnType<typeof openSqliteDatabase>["database"];

async function campaignReadTransaction<T>(
  database: CampaignDatabase,
  operation: (database: CampaignDatabase) => Promise<T>,
): Promise<T> {
  const transactional = database as CampaignDatabase & {
    transaction: (
      callback: (database: CampaignDatabase) => Promise<T>,
      config?: { behavior?: "deferred" | "immediate" | "exclusive" },
    ) => Promise<T>;
  };
  return transactional.transaction(operation, { behavior: "deferred" });
}

interface RepositoryHeadObservation {
  readonly id: string;
  readonly path: string;
  readonly headSha: string;
}

async function observeRepositoryHeads(
  databasePath: string,
  environment: NodeJS.ProcessEnv,
): Promise<readonly RepositoryHeadObservation[]> {
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const rows = await handle.database.select().from(repositories);
    const observations: RepositoryHeadObservation[] = [];
    for (const row of rows) {
      try {
        const headSha = (
          await execa("git", ["-C", row.path, "rev-parse", "HEAD"], {
            env: credentialFreeGitEnvironment(environment),
            extendEnv: false,
            timeout: 30_000,
          })
        ).stdout.trim();
        if (EXACT_SHA.test(headSha)) observations.push({ id: row.id, path: row.path, headSha });
      } catch {
        // An unavailable repository has no successful observation for this pass.
      }
    }
    return observations;
  } finally {
    handle.close();
  }
}

async function applyRepositoryHeadObservations(
  database: CampaignDatabase,
  observations: readonly RepositoryHeadObservation[],
): Promise<ReadonlySet<string>> {
  const rows = await database.select().from(repositories);
  const repositoriesById = new Map(rows.map((row) => [row.id, row]));
  const observed = new Set<string>();
  for (const observation of observations) {
    const row = repositoriesById.get(observation.id);
    if (!row || row.path !== observation.path) continue;
    observed.add(row.id);
    if (row.headSha === observation.headSha) continue;
    await database
      .update(repositories)
      .set({
        headSha: observation.headSha,
        revision: sql`${repositories.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, row.id));
    row.headSha = observation.headSha;
    row.revision += 1;
  }
  return observed;
}

async function reconcile(
  database: CampaignDatabase,
  campaignId: string,
  observedRepositoryIds: ReadonlySet<string>,
): Promise<void> {
  const campaign = await database.query.campaigns.findFirst({
    where: eq(campaigns.campaignId, campaignId),
  });
  if (!campaign) throw new Error("campaign not found");
  let campaignState: DecodedCampaignState;
  try {
    campaignState = decodeCampaignState(campaign);
  } catch {
    // Preserve corrupt durable state for the owning read path to report.
    return;
  }
  let campaignStatus = campaignState.status;
  let decisionRequest = campaignState.decisionRequest;
  const contract = decodePersistedGoalContract(campaign.contract);
  const newerCampaign = await database
    .select({ goalVersion: max(campaigns.goalVersion) })
    .from(campaigns)
    .where(
      and(eq(campaigns.goalId, campaign.goalId), gt(campaigns.goalVersion, campaign.goalVersion)),
    );
  const superseded =
    campaign.superseded ||
    (newerCampaign[0]?.goalVersion ?? campaign.goalVersion) > campaign.goalVersion;
  const rows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const repositoryRows = await database.select().from(repositories);
  const repositoriesById = new Map(repositoryRows.map((repository) => [repository.id, repository]));
  const taskFacts: CampaignTaskFacts = new Map();
  let changed = false;
  for (const row of rows) {
    if (row.status === "superseded") continue;
    const proposal = decodePersistedTaskProposal(row.proposal);
    const blocker = blockerFor(
      row,
      proposal,
      contract,
      campaign.publicationAuthorized,
      superseded,
      repositoriesById.get(proposal.repositoryId),
      observedRepositoryIds,
    );
    const dependency =
      blocker === null
        ? await dependencyResolution(proposal, rows, contract, campaign, database, taskFacts)
        : { blocker: null, baseSha: null };
    const nextStatus = blocker ? "blocked" : dependency.blocker ? "planned" : "ready";
    const nextBlocker = blocker ?? dependency.blocker;
    const repository = repositoriesById.get(proposal.repositoryId);
    // Ready evidence is a durable fact. Once captured, it remains attached to the
    // proposal even when current eligibility later projects it as blocked.
    const nextBaseSha =
      row.readyBaseSha ??
      (nextStatus === "ready" && observedRepositoryIds.has(proposal.repositoryId)
        ? (dependency.baseSha ?? repository?.headSha ?? null)
        : null);
    const nextRevision =
      row.readyRepositoryRevision ??
      (nextStatus === "ready" && observedRepositoryIds.has(proposal.repositoryId)
        ? (repository?.revision ?? null)
        : null);
    if (
      row.status !== nextStatus ||
      row.blocker !== nextBlocker ||
      row.readyBaseSha !== nextBaseSha ||
      row.readyRepositoryRevision !== nextRevision
    ) {
      await database
        .update(campaignProposals)
        .set({
          status: nextStatus,
          blocker: nextBlocker,
          readyBaseSha: nextBaseSha,
          readyRepositoryRevision: nextRevision,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(campaignProposals.campaignId, campaignId),
            eq(campaignProposals.proposalId, row.proposalId),
          ),
        );
      row.status = nextStatus;
      row.blocker = nextBlocker;
      row.readyBaseSha = nextBaseSha;
      row.readyRepositoryRevision = nextRevision;
      changed = true;
    }
  }
  if (!superseded && campaign.planHandedOff && !isTerminalCampaignStatus(campaignStatus)) {
    const results = await campaignTaskResults(database, rows, taskFacts);
    const assessments = await campaignAssessmentRows(database, campaignId);
    const outcomeEvidence = campaignOutcomeEvidence(campaign, contract, rows, results);
    const liveOutcomes = contract.outcomes.filter((outcome) => outcome.status === "live");
    const usefulWork = hasUsefulCampaignWork(rows, results);
    const authorityBlocked = rows.some((row) => row.status === "blocked" && row.blocker !== null);
    if (!campaign.publicationAuthorized) {
      campaignStatus = "blocked";
      decisionRequest ??= {
        requestId: `decision:${campaign.campaignId}`,
        reason: "branches_blocked",
        outcomeIds: liveOutcomes.map((outcome) => outcome.id),
      };
    }
    const currentAssessments = liveOutcomes.map((outcome) => {
      const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
      const assessment = assessments.get(outcome.id);
      return {
        outcome,
        evidence,
        assessment,
        current: assessment?.evidenceHash === assessmentEvidenceHash(outcome, evidence),
      };
    });
    const allSatisfied =
      campaign.publicationAuthorized &&
      liveOutcomes.length > 0 &&
      currentAssessments.every(
        ({ assessment, current, evidence, outcome }) =>
          current &&
          outcomeEvidence.has(outcome.id) &&
          assessmentReferencesResolve(outcome, evidence, assessment),
      );
    const allAssessmentsCurrent = currentAssessments.every(({ current }) => current);
    const assessmentFailure = currentAssessments.find(
      ({ assessment, current, evidence, outcome }) =>
        current &&
        (assessment?.verdict !== "satisfied" ||
          !outcomeEvidence.has(outcome.id) ||
          !assessmentReferencesResolve(outcome, evidence, assessment)),
    );
    if (campaign.publicationAuthorized && liveOutcomes.length === 0 && !usefulWork) {
      campaignStatus = "blocked";
      decisionRequest ??= {
        requestId: `decision:${campaign.campaignId}`,
        reason: "plan_exhausted",
        outcomeIds: [],
      };
    } else if (allSatisfied) {
      campaignStatus = "accepted";
      decisionRequest = null;
    } else if (
      campaign.publicationAuthorized &&
      allAssessmentsCurrent &&
      assessmentFailure &&
      !usefulWork
    ) {
      if (authorityBlocked) {
        campaignStatus = "blocked";
        const nextDecisionRequest: CampaignDecisionRequest = {
          requestId: `decision:${campaign.campaignId}`,
          reason: "branches_blocked",
          outcomeIds: liveOutcomes
            .filter((outcome) => {
              const item = currentAssessments.find(
                (candidate) => candidate.outcome.id === outcome.id,
              );
              return (
                !item?.current ||
                !outcomeEvidence.has(outcome.id) ||
                !assessmentReferencesResolve(item.outcome, item.evidence, item.assessment)
              );
            })
            .map((outcome) => outcome.id),
        };
        if (JSON.stringify(decisionRequest) !== JSON.stringify(nextDecisionRequest))
          decisionRequest = nextDecisionRequest;
      } else {
        // Assessment gaps, malformed model attempts, and planner failures are
        // recoverable frontier work. Keep the Campaign nonterminal so a later
        // fresh attempt can continue from the same exact evidence identity.
        campaignStatus = "planning";
        decisionRequest = null;
      }
    } else if (campaign.publicationAuthorized && !usefulWork && liveOutcomes.length > 0) {
      // The assessor must run before the exhausted frontier becomes terminal.
      campaignStatus = "planning";
    }
  }
  const updatedAt = nextCampaignUpdatedAt(campaign.updatedAt);
  if (
    campaign.status !== campaignStatus ||
    JSON.stringify(campaign.decisionRequest ?? null) !== JSON.stringify(decisionRequest)
  ) {
    await database
      .update(campaigns)
      .set({ status: campaignStatus, decisionRequest, updatedAt })
      .where(eq(campaigns.campaignId, campaignId));
    changed = true;
  }
  if (
    campaign.checkpointRequested &&
    ((campaignStatus === "blocked" && decisionRequest !== null) || campaignStatus === "accepted")
  ) {
    await database
      .update(campaigns)
      .set({ checkpointRequested: false, updatedAt: nextCampaignUpdatedAt(campaign.updatedAt) })
      .where(eq(campaigns.campaignId, campaignId));
    changed = true;
  }
  if (superseded !== campaign.superseded) {
    await database
      .update(campaigns)
      .set({ superseded, updatedAt })
      .where(eq(campaigns.campaignId, campaignId));
  }
  if (changed || superseded !== campaign.superseded)
    await database
      .update(campaigns)
      .set({ revision: sql`${campaigns.revision} + 1`, updatedAt })
      .where(eq(campaigns.campaignId, campaignId));
}

function nextCampaignUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

function isTerminalCampaignStatus(status: ReturnType<typeof decodeCampaignStatus>): boolean {
  return status === "accepted" || status === "blocked" || status === "abandoned";
}

async function reconcileAll(
  database: CampaignDatabase,
  observedRepositoryIds: ReadonlySet<string>,
): Promise<void> {
  const rows = await database.select({ campaignId: campaigns.campaignId }).from(campaigns);
  for (const row of rows) {
    try {
      await reconcile(database, row.campaignId, observedRepositoryIds);
    } catch (error) {
      if (isCampaignStateQuarantinedError(error)) continue;
      throw error;
    }
  }
}

async function reconcileWithRepositoryHeads(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
  operation: (
    database: CampaignDatabase,
    observedRepositoryIds: ReadonlySet<string>,
  ) => Promise<void>,
): Promise<void> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const observations = await observeRepositoryHeads(databasePath, environment);
  const handle = openSqliteDatabase(databasePath);
  try {
    await handle.exclusiveTransaction(async () => {
      const observedRepositoryIds = await applyRepositoryHeadObservations(
        handle.database,
        observations,
      );
      await operation(handle.database, observedRepositoryIds);
    });
  } finally {
    handle.close();
  }
}

async function campaignTaskResults(
  database: CampaignDatabase,
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  taskFacts: CampaignTaskFacts = new Map(),
): Promise<Map<string, TaskResult>> {
  const results = new Map<string, TaskResult>();
  for (const row of rows) {
    if (!row.taskId) continue;
    const result = await campaignTaskLookup(database, row.taskId, taskFacts);
    if (result) results.set(row.proposalId, result);
  }
  return results;
}

async function campaignTaskLookup(
  database: CampaignDatabase,
  taskId: string,
  taskFacts: CampaignTaskFacts,
): Promise<TaskResult | null> {
  if (taskFacts.has(taskId)) return taskFacts.get(taskId) ?? null;
  try {
    const result = await new TaskAuthority(database).lookup(taskId);
    taskFacts.set(taskId, result);
    return result;
  } catch (error) {
    if (!isTaskStateQuarantinedError(error)) throw error;
    taskFacts.set(taskId, null);
    return null;
  }
}

function campaignAssessmentEvidence(
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  results: ReadonlyMap<string, TaskResult>,
  outcomeId: string,
): CampaignAssessmentFact[] {
  const evidence: CampaignAssessmentFact[] = [];
  for (const row of rows) {
    if (row.status === "superseded") continue;
    const proposal = decodePersistedTaskProposal(row.proposal);
    if (proposal.outcomeId !== outcomeId) continue;
    const result = results.get(row.proposalId);
    if (!result?.candidateSha || !EXACT_SHA.test(result.candidateSha)) continue;
    evidence.push({
      repositoryId: proposal.repositoryId,
      proposalId: row.proposalId,
      taskId: result.taskId,
      fact: "candidate",
      status: result.state,
      sha: result.candidateSha,
    });
    if (result.check?.sha === result.candidateSha && EXACT_SHA.test(result.check.sha))
      evidence.push({
        repositoryId: proposal.repositoryId,
        proposalId: row.proposalId,
        taskId: result.taskId,
        fact: "check",
        status: result.check.status,
        sha: result.check.sha,
      });
    if (result.review?.sha === result.candidateSha && EXACT_SHA.test(result.review.sha))
      evidence.push({
        repositoryId: proposal.repositoryId,
        proposalId: row.proposalId,
        taskId: result.taskId,
        fact: "review",
        status: result.review.verdict,
        sha: result.review.sha,
      });
    const accepted = acceptedTaskDelivery(result);
    if (accepted)
      evidence.push({
        repositoryId: proposal.repositoryId,
        proposalId: row.proposalId,
        taskId: result.taskId,
        fact: "delivery",
        status: result.state,
        sha: accepted.delivery.sha,
      });
  }
  return evidence;
}

function assessmentEvidenceHash(
  outcome: GoalContract["outcomes"][number],
  evidence: readonly CampaignAssessmentFact[],
): string {
  return createHash("sha256").update(JSON.stringify({ outcome, evidence }), "utf8").digest("hex");
}

function assessmentFactKey(item: CampaignAssessmentFact): string {
  return `${item.repositoryId}\u0000${item.proposalId}\u0000${item.taskId}\u0000${item.fact}\u0000${item.status}\u0000${item.sha}`;
}

function resolveAssessmentReferences(
  outcome: GoalContract["outcomes"][number],
  evidence: readonly CampaignAssessmentFact[],
  references: readonly CampaignAssessmentEvidence[],
): {
  readonly references: readonly CampaignAssessmentEvidence[];
  readonly criteriaSatisfied: boolean;
} {
  const source = new Set(evidence.map(assessmentFactKey));
  const resolved = references.filter(
    (item) =>
      item.criterionIndex < outcome.acceptance.length && source.has(assessmentFactKey(item)),
  );
  return {
    references: resolved,
    criteriaSatisfied: outcome.acceptance.every((_, criterionIndex) =>
      resolved.some((item) => item.criterionIndex === criterionIndex && item.fact === "delivery"),
    ),
  };
}

function assessmentReferencesResolve(
  outcome: GoalContract["outcomes"][number],
  evidence: readonly CampaignAssessmentFact[],
  assessment: CampaignAssessment | undefined,
): boolean {
  if (!assessment || assessment.verdict !== "satisfied") return false;
  return resolveAssessmentReferences(outcome, evidence, assessment.evidence).criteriaSatisfied;
}

async function campaignAssessmentRows(
  database: CampaignDatabase,
  campaignId: string,
): Promise<Map<string, CampaignAssessment>> {
  const rows = await database
    .select()
    .from(campaignAssessments)
    .where(eq(campaignAssessments.campaignId, campaignId));
  const modelRunRows = await database
    .select()
    .from(campaignModelRuns)
    .where(eq(campaignModelRuns.campaignId, campaignId));
  const modelRunsByInvocation = new Map(
    modelRunRows.filter((row) => row.status !== "pending").map((row) => [row.invocationId, row]),
  );
  const assessments = new Map<string, CampaignAssessment>();
  for (const row of rows) {
    try {
      if (row.role !== "assessor") continue;
      const assessment = Schema.decodeUnknownSync(campaignAssessmentSchema)(row.assessment);
      const usage = campaignUsageProjection(
        modelRunsByInvocation.get(assessment.assessmentId),
        assessment.usage,
      );
      const projectedAssessment = {
        ...assessment,
        usage: usage.usage,
        usageSource: usage.source,
      } satisfies CampaignAssessment;
      const current = assessments.get(assessment.outcomeId);
      if (!current || assessment.completedAtEpochMs >= current.completedAtEpochMs)
        assessments.set(assessment.outcomeId, projectedAssessment);
    } catch {
      // A corrupt assessment is not evidence and remains visible only to the
      // owning durable-state diagnostic path.
    }
  }
  return assessments;
}

function campaignOutcomeEvidence(
  campaign: typeof campaigns.$inferSelect,
  contract: GoalContract,
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  results: ReadonlyMap<string, TaskResult>,
): Map<string, CampaignOutcomeEvidence> {
  const evidence = new Map<string, CampaignOutcomeEvidence>();
  const proposalsByOutcome = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    if (row.status === "superseded") continue;
    const proposal = decodePersistedTaskProposal(row.proposal);
    const outcomeRows = proposalsByOutcome.get(proposal.outcomeId) ?? [];
    outcomeRows.push(row);
    proposalsByOutcome.set(proposal.outcomeId, outcomeRows);
  }
  for (const [outcomeId, outcomeRows] of proposalsByOutcome) {
    let firstAccepted: AcceptedCampaignDelivery | null = null;
    let allAccepted = true;
    for (const row of outcomeRows) {
      const proposal = decodePersistedTaskProposal(row.proposal);
      const accepted = acceptedCampaignDelivery(
        results.get(row.proposalId) ?? null,
        campaign,
        contract,
        proposal,
      );
      if (!accepted) {
        allAccepted = false;
        break;
      }
      firstAccepted ??= accepted;
    }
    if (!allAccepted || !firstAccepted) continue;
    const firstRow = outcomeRows[0];
    const delivery = firstAccepted.delivery;
    evidence.set(outcomeId, {
      outcomeId,
      taskId: firstRow!.taskId!,
      effect: delivery.effect,
      sha: delivery.sha,
      merged: firstAccepted.mergedHeadSha !== null,
      mergeCommitSha: firstAccepted.mergedHeadSha,
    });
  }
  return evidence;
}

function hasUsefulCampaignWork(
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  results: ReadonlyMap<string, TaskResult>,
): boolean {
  for (const row of rows) {
    if (row.status === "superseded") continue;
    const result = results.get(row.proposalId);
    if (result) {
      if (!isTerminalState(result.state)) return true;
      continue;
    }
    if (row.status === "ready") return true;
  }
  return false;
}

type ReplacementRunStatus = "pending" | "admitted" | "invalid" | "duplicate" | "unavailable";

interface ReplacementTarget {
  readonly campaign: typeof campaigns.$inferSelect;
  readonly contract: GoalContract;
  readonly outcome: GoalContract["outcomes"][number];
  readonly assessment: CampaignAssessment;
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly priorProposals: readonly TaskProposal[];
  readonly supersededProposalIds: readonly string[];
  readonly repositories: CampaignReplacementRequest["repositories"];
  readonly evidenceHash: string;
  readonly invocationId: string;
  /** A checkpoint may revise one proposal from this still-unowned set. */
  readonly supersedableProposalIds: readonly string[];
}

function replacementCampaignEligible(campaignState: DecodedCampaignState): boolean {
  return campaignState.status === "planning";
}

function canSupersedeProposal(
  row: typeof campaignProposals.$inferSelect,
  result: TaskResult | undefined,
): boolean {
  return (
    (row.status === "planned" || row.status === "blocked") &&
    row.readyBaseSha === null &&
    row.readyRepositoryRevision === null &&
    row.taskId === null &&
    result === undefined &&
    row.replacementAssessmentId === null &&
    row.replacementEvidenceHash === null &&
    row.supersededByProposalId === null &&
    row.supersedesProposalId === null
  );
}

function supersedableProposalIds(
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  results: ReadonlyMap<string, TaskResult>,
  outcomeId: string,
): readonly string[] {
  return rows
    .filter((row) => {
      if (!canSupersedeProposal(row, results.get(row.proposalId))) return false;
      if (decodePersistedTaskProposal(row.proposal).outcomeId !== outcomeId) return false;
      return !rows.some(
        (successor) =>
          successor.status !== "superseded" &&
          successor.proposalId !== row.proposalId &&
          decodePersistedTaskProposal(successor.proposal).dependsOn.includes(row.proposalId),
      );
    })
    .map((row) => row.proposalId);
}

async function replacementTargets(stateDirectory: string): Promise<readonly ReplacementTarget[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  try {
    return await campaignReadTransaction(handle.database, async (database) => {
      const campaignRows = await database.select().from(campaigns);
      const repositoryRows = await database.select().from(repositories);
      const replacementRows = await database.select().from(campaignReplacementRuns);
      const targets: ReplacementTarget[] = [];
      for (const campaign of campaignRows) {
        if (!campaign.planHandedOff || campaign.superseded || !campaign.publicationAuthorized)
          continue;
        let campaignState: DecodedCampaignState;
        try {
          campaignState = decodeCampaignState(campaign);
        } catch {
          continue;
        }
        if (!replacementCampaignEligible(campaignState)) continue;
        const contract = decodePersistedGoalContract(campaign.contract);
        const rows = await database
          .select()
          .from(campaignProposals)
          .where(eq(campaignProposals.campaignId, campaign.campaignId))
          .orderBy(asc(campaignProposals.sequence));
        const results = await campaignTaskResults(database, rows);
        if (hasUsefulCampaignWork(rows, results) && !campaign.checkpointRequested) continue;
        const assessments = await campaignAssessmentRows(database, campaign.campaignId);
        for (const outcome of contract.outcomes.filter(
          (candidate) => candidate.status === "live",
        )) {
          const assessment = assessments.get(outcome.id);
          const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
          const evidenceHash = assessmentEvidenceHash(outcome, evidence);
          const checkpointRevision = campaign.checkpointRequested;
          const revisionSources = checkpointRevision
            ? supersedableProposalIds(rows, results, outcome.id)
            : [];
          // A checkpoint can revise one still-unowned proposal. If no such source
          // exists, let reconciliation produce the stable decision request without
          // spending a planner invocation.
          if (checkpointRevision && revisionSources.length === 0) continue;
          if (
            !assessment ||
            assessment.verdict !== "gaps" ||
            assessment.evidenceHash !== evidenceHash
          )
            continue;
          const baseInvocationId = `replacement-${createHash("sha256")
            .update(
              `${campaign.campaignId}\u0000${outcome.id}\u0000${assessment.assessmentId}\u0000${evidenceHash}`,
              "utf8",
            )
            .digest("hex")}`;
          const priorRuns = replacementRows
            .filter(
              (run) =>
                run.campaignId === campaign.campaignId &&
                run.outcomeId === outcome.id &&
                run.assessmentId === assessment.assessmentId &&
                run.evidenceHash === evidenceHash,
            )
            .toSorted((left, right) => left.startedAtEpochMs - right.startedAtEpochMs);
          const latestRun = priorRuns.at(-1);
          if (latestRun?.status === "pending" || latestRun?.status === "admitted") continue;
          const invocationId =
            priorRuns.length === 0
              ? baseInvocationId
              : `${baseInvocationId}:attempt-${priorRuns.length + 1}`;
          targets.push({
            campaign,
            contract,
            outcome,
            assessment,
            evidence,
            priorProposals: rows.map((row) => decodePersistedTaskProposal(row.proposal)),
            supersededProposalIds: rows
              .filter((row) => row.status === "superseded")
              .map((row) => row.proposalId),
            repositories: repositoryRows
              .filter((repository) => contract.authority.repositories.includes(repository.id))
              .map((repository) => ({
                id: repository.id,
                path: repository.path,
                owner: repository.owner,
                name: repository.name,
                baseBranch: repository.baseBranch,
                headSha: repository.headSha,
                reviewerProfile: repository.reviewerProfile,
              })),
            evidenceHash,
            invocationId,
            supersedableProposalIds: revisionSources,
          });
        }
      }
      return targets;
    });
  } finally {
    handle.close();
  }
}

function proposalFingerprint(proposal: TaskProposal): string {
  const { proposalId: _proposalId, ...ownedWork } = proposal;
  return JSON.stringify(ownedWork);
}

interface ReplacementValidation {
  readonly status: ReplacementRunStatus;
  readonly proposal: TaskProposal | null;
  readonly supersedesProposalId: string | null;
}

function replacementValidation(
  target: ReplacementTarget,
  candidate: unknown,
): ReplacementValidation {
  if (candidate === null || candidate === undefined)
    return { status: "unavailable", proposal: null, supersedesProposalId: null };
  let supersedesProposalId: string | null = null;
  let proposalCandidate: unknown = candidate;
  if (Predicate.isObject(candidate)) {
    const envelope = candidate;
    if ("proposal" in envelope) {
      proposalCandidate = envelope.proposal;
      supersedesProposalId =
        typeof envelope.supersedesProposalId === "string" ? envelope.supersedesProposalId : null;
    } else if ("supersedesProposalId" in envelope) {
      const { supersedesProposalId: requested, ...proposalWithoutLineage } = envelope;
      proposalCandidate = proposalWithoutLineage;
      supersedesProposalId = typeof requested === "string" ? requested : null;
    }
  }
  const parsed = taskProposalSchema.safeParse(proposalCandidate);
  if (!parsed.success) return { status: "invalid", proposal: null, supersedesProposalId: null };
  const proposal = parsed.data;
  const checkpointRevision = target.supersedableProposalIds.length > 0;
  if (checkpointRevision) {
    if (
      supersedesProposalId === null ||
      !target.supersedableProposalIds.includes(supersedesProposalId)
    )
      return { status: "invalid", proposal: null, supersedesProposalId: null };
  } else if (supersedesProposalId !== null) {
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  }
  if (proposal.outcomeId !== target.outcome.id)
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  if (supersedesProposalId !== null && proposal.dependsOn.includes(supersedesProposalId))
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  if (proposal.dependsOn.some((dependency) => target.supersededProposalIds.includes(dependency)))
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  if (
    !target.contract.authority.delivery ||
    !target.contract.authority.repositories.includes(proposal.repositoryId) ||
    proposal.effects.some((effect) => !target.contract.authority.effects.includes(effect)) ||
    (proposal.merge && !target.contract.authority.merge) ||
    proposal.dependsOn.some(
      (dependency) =>
        dependency === proposal.proposalId ||
        !target.priorProposals.some((prior) => prior.proposalId === dependency),
    )
  )
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  if (
    target.priorProposals.some(
      (prior) =>
        prior.proposalId === proposal.proposalId ||
        proposalFingerprint(prior) === proposalFingerprint(proposal),
    )
  )
    return { status: "duplicate", proposal: null, supersedesProposalId: null };
  if (!target.repositories.some((repository) => repository.id === proposal.repositoryId))
    return { status: "invalid", proposal: null, supersedesProposalId: null };
  return { status: "admitted", proposal, supersedesProposalId };
}

async function currentReplacementTarget(
  database: CampaignDatabase,
  target: ReplacementTarget,
): Promise<ReplacementTarget | null> {
  const campaign = await database.query.campaigns.findFirst({
    where: eq(campaigns.campaignId, target.campaign.campaignId),
  });
  if (
    !campaign ||
    campaign.goalId !== target.campaign.goalId ||
    campaign.goalVersion !== target.campaign.goalVersion ||
    campaign.contractHash !== target.campaign.contractHash ||
    campaign.revision !== target.campaign.revision ||
    campaign.checkpointRequested !== target.campaign.checkpointRequested ||
    campaign.superseded ||
    !campaign.planHandedOff ||
    !campaign.publicationAuthorized
  )
    return null;
  let campaignState: DecodedCampaignState;
  try {
    campaignState = decodeCampaignState(campaign);
  } catch {
    return null;
  }
  if (!replacementCampaignEligible(campaignState)) return null;
  const contract = decodePersistedGoalContract(campaign.contract);
  const outcome = contract.outcomes.find((candidate) => candidate.id === target.outcome.id);
  if (!outcome || outcome.status !== "live") return null;
  const rows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaign.campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const results = await campaignTaskResults(database, rows);
  if (hasUsefulCampaignWork(rows, results) && !campaign.checkpointRequested) return null;
  const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
  if (assessmentEvidenceHash(outcome, evidence) !== target.evidenceHash) return null;
  const assessment = (await campaignAssessmentRows(database, campaign.campaignId)).get(outcome.id);
  if (
    !assessment ||
    assessment.assessmentId !== target.assessment.assessmentId ||
    assessment.evidenceHash !== target.evidenceHash ||
    assessment.verdict !== "gaps"
  )
    return null;
  const repositoryRows = await database.select().from(repositories);
  const allowedSupersedableProposalIds = campaign.checkpointRequested
    ? supersedableProposalIds(rows, results, outcome.id)
    : [];
  if (campaign.checkpointRequested && allowedSupersedableProposalIds.length === 0) return null;
  return {
    ...target,
    campaign,
    contract,
    outcome,
    assessment,
    evidence,
    priorProposals: rows.map((row) => decodePersistedTaskProposal(row.proposal)),
    supersededProposalIds: rows
      .filter((row) => row.status === "superseded")
      .map((row) => row.proposalId),
    repositories: repositoryRows
      .filter((repository) => contract.authority.repositories.includes(repository.id))
      .map((repository) => ({
        id: repository.id,
        path: repository.path,
        owner: repository.owner,
        name: repository.name,
        baseBranch: repository.baseBranch,
        headSha: repository.headSha,
        reviewerProfile: repository.reviewerProfile,
      })),
    supersedableProposalIds: allowedSupersedableProposalIds,
  };
}

async function reserveReplacementRun(
  stateDirectory: string,
  target: ReplacementTarget,
): Promise<boolean> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    let reserved = false;
    await handle.exclusiveTransaction(async () => {
      const existing = await handle.database
        .select({ invocationId: campaignReplacementRuns.invocationId })
        .from(campaignReplacementRuns)
        .where(
          and(
            eq(campaignReplacementRuns.campaignId, target.campaign.campaignId),
            eq(campaignReplacementRuns.outcomeId, target.outcome.id),
            eq(campaignReplacementRuns.invocationId, target.invocationId),
          ),
        );
      if (existing.length > 0) return;
      await handle.database
        .insert(campaignReplacementRuns)
        .values({
          campaignId: target.campaign.campaignId,
          outcomeId: target.outcome.id,
          assessmentId: target.assessment.assessmentId,
          evidenceHash: target.evidenceHash,
          invocationId: target.invocationId,
          role: "replacement-planner",
          status: "pending",
          proposal: null,
          usage: null,
          startedAtEpochMs: Date.now(),
          completedAtEpochMs: null,
        })
        .onConflictDoNothing();
      reserved = true;
    });
    return reserved;
  } finally {
    handle.close();
  }
}

async function reserveCampaignModelRun(
  stateDirectory: string,
  target: {
    readonly campaign: typeof campaigns.$inferSelect;
    readonly outcome: GoalContract["outcomes"][number];
    readonly invocationId: string;
    readonly role: "assessor" | "replacement-planner";
    readonly assessmentId?: string;
    readonly evidenceHash: string;
  },
): Promise<string | null> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    let reserved: string | null = null;
    await handle.exclusiveTransaction(async () => {
      const existing = await handle.database
        .select({
          invocationId: campaignModelRuns.invocationId,
          status: campaignModelRuns.status,
        })
        .from(campaignModelRuns)
        .where(
          and(
            eq(campaignModelRuns.campaignId, target.campaign.campaignId),
            eq(campaignModelRuns.outcomeId, target.outcome.id),
            eq(campaignModelRuns.role, target.role),
            eq(campaignModelRuns.evidenceHash, target.evidenceHash),
          ),
        );
      if (existing.some((run) => run.status === "pending")) return;
      let invocationId = target.invocationId;
      if (target.role === "assessor" && existing.length > 0) {
        const attemptPrefix = `${target.invocationId}:attempt-`;
        const attemptNumbers = existing.flatMap(({ invocationId: existingId }) => {
          if (!existingId.startsWith(attemptPrefix)) return [];
          const suffix = Number(existingId.slice(attemptPrefix.length));
          return Number.isSafeInteger(suffix) && suffix > 0 ? [suffix] : [];
        });
        invocationId = `${attemptPrefix}${Math.max(0, ...attemptNumbers) + 1}`;
      }
      await handle.database
        .insert(campaignModelRuns)
        .values({
          invocationId,
          campaignId: target.campaign.campaignId,
          outcomeId: target.outcome.id,
          role: target.role,
          assessmentId: target.assessmentId ?? null,
          evidenceHash: target.evidenceHash ?? null,
          status: "pending",
          failureClass: null,
          startedAtEpochMs: Date.now(),
          completedAtEpochMs: null,
          elapsedMs: null,
          repositoryId: null,
          repository: null,
          profile: null,
          configuredProvider: null,
          configuredModel: null,
          actualProvider: null,
          actualModel: null,
          adapter: null,
          serviceTier: null,
          reasoningEffort: null,
          usage: null,
        })
        .onConflictDoNothing();
      reserved = invocationId;
    });
    return reserved;
  } finally {
    handle.close();
  }
}

async function persistCampaignModelRun(
  database: CampaignDatabase,
  target: {
    readonly campaignId: string;
    readonly outcomeId: string;
    readonly assessmentId?: string;
    readonly evidenceHash?: string;
    readonly invocationId: string;
  },
  modelRuns: readonly CampaignModelRunDraft[] | undefined,
  fallback?: {
    readonly role: CampaignModelRunDraft["role"];
    readonly usage: CampaignAssessmentUsage | null;
    readonly startedAtEpochMs: number;
    readonly completedAtEpochMs: number;
    readonly status?: CampaignModelRunDraft["status"];
    readonly failureClass?: CampaignModelRunDraft["failureClass"];
  },
): Promise<void> {
  const canonicalRuns =
    fallback &&
    (fallback.status !== undefined ||
      (fallback.usage !== null &&
        Object.values(fallback.usage).some((value) => typeof value === "number"))) &&
    !(modelRuns ?? []).some((run) => run.invocationId === target.invocationId)
      ? [
          ...(modelRuns ?? []),
          {
            invocationId: target.invocationId,
            role: fallback.role,
            status: fallback.status ?? "completed",
            failureClass: fallback.failureClass ?? null,
            startedAtEpochMs: fallback.startedAtEpochMs,
            completedAtEpochMs: fallback.completedAtEpochMs,
            elapsedMs: Math.max(0, fallback.completedAtEpochMs - fallback.startedAtEpochMs),
            repositoryId: null,
            repository: null,
            profile: null,
            configuredProvider: null,
            configuredModel: null,
            actualProvider: null,
            actualModel: null,
            adapter: "campaign-usage-compatibility",
            serviceTier: null,
            reasoningEffort: null,
            usage: fallback.usage,
          } satisfies CampaignModelRunDraft,
        ]
      : modelRuns;
  if (!canonicalRuns || canonicalRuns.length === 0) {
    await database
      .delete(campaignModelRuns)
      .where(eq(campaignModelRuns.invocationId, target.invocationId));
    return;
  }
  for (const modelRun of canonicalRuns) {
    const values = {
      invocationId: modelRun.invocationId,
      campaignId: target.campaignId,
      outcomeId: target.outcomeId,
      role: modelRun.role,
      assessmentId: target.assessmentId ?? null,
      evidenceHash: target.evidenceHash ?? null,
      status: modelRun.status,
      failureClass: modelRun.failureClass,
      startedAtEpochMs: modelRun.startedAtEpochMs,
      completedAtEpochMs: modelRun.completedAtEpochMs,
      elapsedMs: modelRun.elapsedMs,
      repositoryId: modelRun.repositoryId,
      repository: modelRun.repository,
      profile: modelRun.profile,
      configuredProvider: modelRun.configuredProvider,
      configuredModel: modelRun.configuredModel,
      actualProvider: modelRun.actualProvider,
      actualModel: modelRun.actualModel,
      adapter: modelRun.adapter,
      serviceTier: modelRun.serviceTier,
      reasoningEffort: modelRun.reasoningEffort,
      usage: modelRun.usage,
    };
    if (modelRun.invocationId === target.invocationId) {
      await database
        .update(campaignModelRuns)
        .set(values)
        .where(eq(campaignModelRuns.invocationId, target.invocationId));
    } else {
      await database.insert(campaignModelRuns).values(values).onConflictDoNothing();
    }
  }
}

async function persistCancelledCampaignModelRun(
  database: CampaignDatabase,
  target: {
    readonly campaignId: string;
    readonly outcomeId: string;
    readonly assessmentId?: string;
    readonly evidenceHash?: string;
    readonly invocationId: string;
  },
  modelRuns: readonly CampaignModelRunDraft[] | undefined,
  fallback: {
    readonly role: CampaignModelRunDraft["role"];
    readonly usage: CampaignAssessmentUsage | null;
    readonly startedAtEpochMs: number;
    readonly completedAtEpochMs: number;
  },
): Promise<void> {
  await persistCampaignModelRun(database, target, modelRuns, {
    ...fallback,
    status: "cancelled",
    failureClass: "cancellation",
  });
}

async function persistReplacementResult(
  stateDirectory: string,
  target: ReplacementTarget,
  candidate: unknown,
  usage: CampaignReplacementDraft["usage"],
  modelRuns: readonly CampaignModelRunDraft[] | undefined,
  acceptAuthority = true,
): Promise<void> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    await handle.exclusiveTransaction(async () => {
      const current = await handle.database.query.campaignReplacementRuns.findFirst({
        where: and(
          eq(campaignReplacementRuns.campaignId, target.campaign.campaignId),
          eq(campaignReplacementRuns.outcomeId, target.outcome.id),
          eq(campaignReplacementRuns.assessmentId, target.assessment.assessmentId),
          eq(campaignReplacementRuns.invocationId, target.invocationId),
        ),
      });
      if (!current || current.status !== "pending") return;
      const currentTarget = await currentReplacementTarget(handle.database, target);
      const observation = {
        campaignId: target.campaign.campaignId,
        outcomeId: target.outcome.id,
        assessmentId: target.assessment.assessmentId,
        evidenceHash: target.evidenceHash,
        invocationId: target.invocationId,
      };
      const observationFallback = {
        role: "replacement-planner" as const,
        usage,
        startedAtEpochMs: current.startedAtEpochMs,
        completedAtEpochMs: Date.now(),
      };
      if (!acceptAuthority) {
        await persistCancelledCampaignModelRun(
          handle.database,
          observation,
          modelRuns,
          observationFallback,
        );
        return;
      }
      await persistCampaignModelRun(handle.database, observation, modelRuns, observationFallback);
      let result: ReplacementValidation =
        candidate === null || candidate === undefined
          ? { status: "unavailable", proposal: null, supersedesProposalId: null }
          : { status: "invalid", proposal: null, supersedesProposalId: null };
      if (candidate !== null && candidate !== undefined && currentTarget)
        result = replacementValidation(currentTarget, candidate);
      if (result.status === "admitted" && result.proposal) {
        const sequenceRow = await handle.database
          .select({ sequence: max(campaignProposals.sequence) })
          .from(campaignProposals)
          .where(eq(campaignProposals.campaignId, target.campaign.campaignId));
        const sequence = (sequenceRow[0]?.sequence ?? 0) + 1;
        await handle.database.insert(campaignProposals).values({
          campaignId: target.campaign.campaignId,
          proposalId: result.proposal.proposalId,
          sequence,
          outcomeId: result.proposal.outcomeId,
          proposal: result.proposal,
          status: "planned",
          blocker: null,
          supersededByProposalId: null,
          supersedesProposalId: result.supersedesProposalId,
          readyBaseSha: null,
          readyRepositoryRevision: null,
          taskId: null,
          replacementAssessmentId: target.assessment.assessmentId,
          replacementEvidenceHash: target.evidenceHash,
          // The replacement result is attributable through its model run.
          replacementUsage: null,
        });
        if (result.supersedesProposalId !== null) {
          await handle.database
            .update(campaignProposals)
            .set({
              status: "superseded",
              blocker: null,
              supersededByProposalId: result.proposal.proposalId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(campaignProposals.campaignId, target.campaign.campaignId),
                eq(campaignProposals.proposalId, result.supersedesProposalId),
              ),
            );
        }
      }
      await handle.database
        .update(campaignReplacementRuns)
        .set({
          status: result.status,
          proposal: result.proposal,
          // Keep this compatibility column null for new attempts. Usage is
          // owned by campaign_model_runs and projected by invocation ID.
          usage: null,
          completedAtEpochMs: Date.now(),
        })
        .where(
          and(
            eq(campaignReplacementRuns.campaignId, target.campaign.campaignId),
            eq(campaignReplacementRuns.outcomeId, target.outcome.id),
            eq(campaignReplacementRuns.assessmentId, target.assessment.assessmentId),
            eq(campaignReplacementRuns.invocationId, target.invocationId),
          ),
        );
      // Completion of a replacement attempt is the narrow lifecycle event
      // that lets an assessment-gaps Campaign receive one aggregate reducer
      // pass for its durable result. currentTarget proves that this attempt
      // still owns the current lineage and authority, so stale work cannot
      // reopen a newer terminal fact.
      if (currentTarget)
        await handle.database
          .update(campaigns)
          .set({
            status: "planning" as const,
            decisionRequest: null,
            checkpointRequested: false,
            revision: sql`${campaigns.revision} + 1`,
            updatedAt: nextCampaignUpdatedAt(target.campaign.updatedAt),
          })
          .where(eq(campaigns.campaignId, target.campaign.campaignId));
    });
  } finally {
    handle.close();
  }
}

/** Recover an interrupted replacement reservation without making the gap terminal. */
async function recoverPendingReplacementRuns(stateDirectory: string): Promise<void> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    await handle.exclusiveTransaction(async () => {
      const pending = await handle.database
        .select({
          campaignId: campaignReplacementRuns.campaignId,
          outcomeId: campaignReplacementRuns.outcomeId,
        })
        .from(campaignReplacementRuns)
        .where(eq(campaignReplacementRuns.status, "pending"));
      if (pending.length === 0) return;
      const completedAtEpochMs = Date.now();
      await handle.database
        .update(campaignReplacementRuns)
        .set({ status: "unavailable", proposal: null, usage: null, completedAtEpochMs })
        .where(eq(campaignReplacementRuns.status, "pending"));
      const pendingOutcomes = new Map<string, Set<string>>();
      for (const { campaignId, outcomeId } of pending) {
        const outcomes = pendingOutcomes.get(campaignId) ?? new Set<string>();
        outcomes.add(outcomeId);
        pendingOutcomes.set(campaignId, outcomes);
      }
      for (const [campaignId, outcomeIds] of pendingOutcomes) {
        const campaign = await handle.database.query.campaigns.findFirst({
          where: eq(campaigns.campaignId, campaignId),
        });
        if (!campaign) continue;
        let campaignState: DecodedCampaignState;
        try {
          campaignState = decodeCampaignState(campaign);
        } catch {
          continue;
        }
        if (campaign.superseded || isTerminalCampaignStatus(campaignState.status)) continue;
        await handle.database
          .update(campaigns)
          .set({
            status: "planning",
            decisionRequest: null,
            revision: sql`${campaigns.revision} + 1`,
            updatedAt: new Date(completedAtEpochMs),
          })
          .where(eq(campaigns.campaignId, campaignId));
      }
    });
  } finally {
    handle.close();
  }
}

/** A model reservation without a returned observation is not an AI run. */
async function recoverPendingCampaignModelRuns(stateDirectory: string): Promise<void> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  try {
    await handle.exclusiveTransaction(() =>
      handle.database.delete(campaignModelRuns).where(eq(campaignModelRuns.status, "pending")),
    );
  } finally {
    handle.close();
  }
}

/** Recover model reservations once before the server starts active coordination. */
export async function recoverPendingCampaignRuns(stateDirectory: string): Promise<void> {
  await recoverPendingCampaignModelRuns(stateDirectory);
  await recoverPendingReplacementRuns(stateDirectory);
}

async function generateCampaignReplacements(
  stateDirectory: string,
  generator: CampaignReplacementGenerator,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean> {
  let ran = false;
  while (true) {
    if (signal?.aborted) return ran;
    const target = (await replacementTargets(stateDirectory))[0];
    if (!target) return ran;
    if (signal?.aborted) return ran;
    if (!(await reserveReplacementRun(stateDirectory, target))) continue;
    ran = true;
    if (signal?.aborted) return ran;
    if (
      !(await reserveCampaignModelRun(stateDirectory, {
        campaign: target.campaign,
        outcome: target.outcome,
        invocationId: target.invocationId,
        role: "replacement-planner",
        assessmentId: target.assessment.assessmentId,
        evidenceHash: target.evidenceHash,
      }))
    ) {
      return ran;
    }
    let draft: CampaignReplacementDraft;
    try {
      draft = await generator({
        invocationId: target.invocationId,
        campaignId: target.campaign.campaignId,
        goalId: target.campaign.goalId,
        goalVersion: target.campaign.goalVersion,
        goal: target.contract,
        outcome: target.outcome,
        assessment: target.assessment,
        evidenceHash: target.evidenceHash,
        evidence: target.evidence,
        priorProposals: target.priorProposals,
        supersedableProposalIds: target.supersedableProposalIds,
        repositories: target.repositories,
        environment,
        signal,
      });
    } catch {
      draft = { proposal: null, usage: null };
    }
    let usage: CampaignReplacementDraft["usage"] = null;
    try {
      usage = Schema.decodeUnknownSync(Schema.NullOr(campaignAssessmentUsageSchema))(draft.usage);
    } catch {
      usage = null;
    }
    await persistReplacementResult(
      stateDirectory,
      target,
      draft.proposal,
      usage,
      draft.modelRuns,
      !signal?.aborted,
    );
    if (signal?.aborted) return ran;
    await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
      await reconcileAll(database, observed);
    });
  }
}

interface AssessmentTarget {
  readonly campaign: typeof campaigns.$inferSelect;
  readonly contract: GoalContract;
  readonly outcome: GoalContract["outcomes"][number];
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly repositories: CampaignAssessmentRequest["repositories"];
  readonly evidenceHash: string;
  readonly invocationId: string;
}

function campaignAssessmentInvocationId(
  campaign: typeof campaigns.$inferSelect,
  outcomeId: string,
  evidenceHash: string,
): string {
  const invocationSeed = [campaign.campaignId, outcomeId, evidenceHash].join("\u0000");
  return `assessment-${createHash("sha256").update(invocationSeed, "utf8").digest("hex")}`;
}

async function assessmentTargets(stateDirectory: string): Promise<readonly AssessmentTarget[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  try {
    return await campaignReadTransaction(handle.database, async (database) => {
      const campaignRows = await database.select().from(campaigns);
      const repositoryRows = await database.select().from(repositories);
      const modelRunRows = await database
        .select()
        .from(campaignModelRuns)
        .where(eq(campaignModelRuns.role, "assessor"));
      const repositoryById = new Map(repositoryRows.map((row) => [row.id, row]));
      const targets: AssessmentTarget[] = [];
      for (const campaign of campaignRows) {
        let decoded: DecodedCampaignState;
        try {
          decoded = decodeCampaignState(campaign);
        } catch (error) {
          if (isCampaignStateQuarantinedError(error)) continue;
          throw error;
        }
        if (
          !campaign.planHandedOff ||
          isTerminalCampaignStatus(decoded.status) ||
          !campaign.publicationAuthorized
        )
          continue;
        const contract = decodePersistedGoalContract(campaign.contract);
        const rows = await database
          .select()
          .from(campaignProposals)
          .where(eq(campaignProposals.campaignId, campaign.campaignId))
          .orderBy(asc(campaignProposals.sequence));
        const results = await campaignTaskResults(database, rows);
        const assessments = await campaignAssessmentRows(database, campaign.campaignId);
        const exhausted = !hasUsefulCampaignWork(rows, results);
        if (!exhausted && !campaign.assessmentRequested && !campaign.checkpointRequested) continue;
        for (const outcome of contract.outcomes.filter(
          (candidate) => candidate.status === "live",
        )) {
          const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
          const evidenceHash = assessmentEvidenceHash(outcome, evidence);
          const current = assessments.get(outcome.id);
          const currentRun = current
            ? modelRunRows.find((run) => run.invocationId === current.assessmentId)
            : undefined;
          if (
            current?.evidenceHash === evidenceHash &&
            currentRun?.status !== "failed" &&
            currentRun?.status !== "cancelled"
          )
            continue;
          const repositoriesForOutcome = new Map<
            string,
            CampaignAssessmentRequest["repositories"][number]
          >();
          for (const row of rows) {
            const proposal = decodePersistedTaskProposal(row.proposal);
            if (proposal.outcomeId !== outcome.id) continue;
            const result = results.get(row.proposalId);
            const repository = repositoryById.get(proposal.repositoryId);
            if (!repository || repositoriesForOutcome.has(proposal.repositoryId)) continue;
            repositoriesForOutcome.set(proposal.repositoryId, {
              id: proposal.repositoryId,
              path: result?.repository?.path ?? repository.path,
              owner: repository.owner,
              name: repository.name,
              reviewerProfile: repository.reviewerProfile,
              baseSha:
                result?.candidateSha ??
                result?.repository?.headSha ??
                repository.headSha ??
                "0000000000000000000000000000000000000000",
            });
          }
          const invocationId = campaignAssessmentInvocationId(campaign, outcome.id, evidenceHash);
          targets.push({
            campaign,
            contract,
            outcome,
            evidence,
            repositories: [...repositoriesForOutcome.values()],
            evidenceHash,
            invocationId,
          });
        }
      }
      return targets;
    });
  } finally {
    handle.close();
  }
}

function validateAssessment(
  target: AssessmentTarget,
  draft: CampaignAssessmentDraft,
  startedAtEpochMs: number,
  completedAtEpochMs: number,
): CampaignAssessment {
  const { references, criteriaSatisfied } = resolveAssessmentReferences(
    target.outcome,
    target.evidence,
    draft.evidence,
  );
  let verdict = draft.verdict;
  let summary = draft.summary.slice(0, 2000);
  let gaps = [...draft.gaps].map((gap) => gap.slice(0, 1000)).slice(0, 32);
  if (draft.verdict === "satisfied" && !criteriaSatisfied) {
    verdict = references.length > 0 ? "gaps" : "inconclusive";
    summary =
      references.length > 0
        ? "assessment did not provide exact delivery evidence for every acceptance criterion"
        : "assessment cited unavailable or contradictory evidence";
    gaps = [summary];
  }
  const assessment = {
    role: "assessor" as const,
    assessmentId: target.invocationId,
    outcomeId: target.outcome.id,
    evidenceHash: target.evidenceHash,
    verdict,
    summary,
    gaps,
    evidence: references,
    // Token amounts are projected from campaign_model_runs. The draft usage
    // is passed to the canonical observation writer, not stored in the
    // assessment fact.
    usage: null,
    usageSource: "unavailable" as const,
    startedAtEpochMs,
    completedAtEpochMs,
  } satisfies CampaignAssessment;
  return Schema.decodeUnknownSync(campaignAssessmentSchema)(assessment);
}

async function persistCampaignAssessment(
  stateDirectory: string,
  target: AssessmentTarget,
  assessment: CampaignAssessment,
  usage: CampaignAssessmentDraft["usage"],
  modelRuns: readonly CampaignModelRunDraft[] | undefined,
  recoverable = false,
  acceptAuthority = true,
): Promise<void> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  try {
    await handle.exclusiveTransaction(async () => {
      const campaign = await handle.database.query.campaigns.findFirst({
        where: eq(campaigns.campaignId, target.campaign.campaignId),
      });
      const current =
        campaign &&
        campaign.goalId === target.campaign.goalId &&
        campaign.goalVersion === target.campaign.goalVersion &&
        campaign.contractHash === target.campaign.contractHash &&
        campaign.revision === target.campaign.revision &&
        !campaign.superseded &&
        campaign.planHandedOff &&
        campaign.publicationAuthorized &&
        !isTerminalCampaignStatus(decodeCampaignState(campaign).status);
      const rows = campaign
        ? await handle.database
            .select()
            .from(campaignProposals)
            .where(eq(campaignProposals.campaignId, target.campaign.campaignId))
            .orderBy(asc(campaignProposals.sequence))
        : [];
      const results = campaign ? await campaignTaskResults(handle.database, rows) : new Map();
      const outcome = campaign
        ? decodePersistedGoalContract(campaign.contract).outcomes.find(
            (candidate) => candidate.id === target.outcome.id,
          )
        : undefined;
      const evidence = outcome ? campaignAssessmentEvidence(rows, results, outcome.id) : [];
      const lineageCurrent =
        current && outcome && assessmentEvidenceHash(outcome, evidence) === target.evidenceHash;
      const persistedAssessment = assessment;
      if (!acceptAuthority) {
        await persistCancelledCampaignModelRun(
          handle.database,
          {
            campaignId: target.campaign.campaignId,
            outcomeId: target.outcome.id,
            assessmentId: assessment.assessmentId,
            evidenceHash: target.evidenceHash,
            invocationId: target.invocationId,
          },
          modelRuns,
          {
            role: "assessor",
            usage,
            startedAtEpochMs: assessment.startedAtEpochMs,
            completedAtEpochMs: Date.now(),
            ...(recoverable ? { status: "failed" as const, failureClass: "unknown" as const } : {}),
          },
        );
        return;
      }
      await persistCampaignModelRun(
        handle.database,
        {
          campaignId: target.campaign.campaignId,
          outcomeId: target.outcome.id,
          assessmentId: target.invocationId,
          evidenceHash: target.evidenceHash,
          invocationId: target.invocationId,
        },
        modelRuns,
        {
          role: "assessor",
          usage,
          startedAtEpochMs: assessment.startedAtEpochMs,
          completedAtEpochMs: assessment.completedAtEpochMs,
          ...(recoverable ? { status: "failed" as const, failureClass: "unknown" as const } : {}),
        },
      );
      if (!lineageCurrent) return;
      await handle.database
        .insert(campaignAssessments)
        .values({
          campaignId: target.campaign.campaignId,
          outcomeId: target.outcome.id,
          role: "assessor",
          evidenceHash: target.evidenceHash,
          assessmentId: persistedAssessment.assessmentId,
          assessment: persistedAssessment,
          startedAtEpochMs: persistedAssessment.startedAtEpochMs,
          completedAtEpochMs: persistedAssessment.completedAtEpochMs,
        })
        .onConflictDoNothing();
      await handle.database
        .update(campaigns)
        .set({
          assessmentRequested: false,
          updatedAt: nextCampaignUpdatedAt(target.campaign.updatedAt),
        })
        .where(eq(campaigns.campaignId, target.campaign.campaignId));
    });
  } finally {
    handle.close();
  }
}

async function assessCampaignTargets(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
  assessor: CampaignOutcomeAssessor,
  replacementGenerator: CampaignReplacementGenerator,
  signal?: AbortSignal,
): Promise<boolean> {
  let ran = false;
  for (const target of await assessmentTargets(stateDirectory)) {
    if (signal?.aborted) return ran;
    const startedAtEpochMs = Date.now();
    const invocationId = await reserveCampaignModelRun(stateDirectory, {
      campaign: target.campaign,
      outcome: target.outcome,
      invocationId: target.invocationId,
      role: "assessor",
      evidenceHash: target.evidenceHash,
    });
    if (!invocationId) continue;
    const invocationTarget = { ...target, invocationId };
    ran = true;
    let draft: CampaignAssessmentDraft;
    let recoverable = false;
    try {
      draft = await assessor({
        invocationId,
        campaignId: target.campaign.campaignId,
        goalId: target.campaign.goalId,
        goalVersion: target.campaign.goalVersion,
        goal: target.contract,
        outcome: target.outcome,
        evidence: target.evidence,
        repositories: target.repositories,
        environment,
        signal,
      });
    } catch {
      recoverable = true;
      draft = {
        verdict: "inconclusive",
        summary: "Campaign assessor failed before producing a result",
        gaps: [],
        evidence: [],
        usage: null,
        modelRuns: [],
      };
    }
    let assessment: CampaignAssessment;
    try {
      assessment = validateAssessment(invocationTarget, draft, startedAtEpochMs, Date.now());
    } catch {
      recoverable = true;
      assessment = validateAssessment(
        invocationTarget,
        {
          verdict: "inconclusive",
          summary: "Campaign assessor returned an invalid schema result",
          gaps: [],
          evidence: [],
          usage: null,
        },
        startedAtEpochMs,
        Date.now(),
      );
    }
    let usage: CampaignAssessmentDraft["usage"] = null;
    try {
      usage = Schema.decodeUnknownSync(Schema.NullOr(campaignAssessmentUsageSchema))(draft.usage);
    } catch {
      usage = null;
    }
    recoverable ||= draft.recoverable === true;
    await persistCampaignAssessment(
      stateDirectory,
      invocationTarget,
      assessment,
      usage,
      draft.modelRuns,
      recoverable,
      !signal?.aborted,
    );
    if (signal?.aborted) return ran;
  }
  ran =
    (await generateCampaignReplacements(
      stateDirectory,
      replacementGenerator,
      environment,
      signal,
    )) || ran;
  if (signal?.aborted) return ran;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    await reconcileAll(database, observed);
  });
  return ran;
}

export async function reconcileCampaigns(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = {},
  activeTaskCapacity = 1,
  assessor?: CampaignOutcomeAssessor,
  replacementGenerator?: CampaignReplacementGenerator,
  options: CampaignReconciliationOptions = {},
): Promise<readonly CampaignTaskAdmission[]> {
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  const readHandle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const existingCampaign = await readHandle.database
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .limit(1);
    if (existingCampaign.length === 0) return [];
  } finally {
    readHandle.close();
  }
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    await reconcileAll(database, observed);
  });
  const admissions = await admitReadyCampaignTasks(stateDirectory, activeTaskCapacity);
  const modelWork = assessor
    ? (signal: AbortSignal) =>
        assessCampaignTargets(
          stateDirectory,
          environment,
          assessor,
          replacementGenerator ?? (async () => ({ proposal: null, usage: null })),
          signal,
        )
    : replacementGenerator
      ? (signal: AbortSignal) =>
          generateCampaignReplacements(stateDirectory, replacementGenerator, environment, signal)
      : undefined;
  if (modelWork) {
    if (options.launchModelWork) options.launchModelWork(modelWork);
    else await modelWork(new AbortController().signal);
  }
  return admissions;
}

async function admitReadyCampaignTasks(
  stateDirectory: string,
  activeTaskCapacity: number,
): Promise<readonly CampaignTaskAdmission[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  const admissions: CampaignTaskAdmission[] = [];
  try {
    const campaignsRows = await handle.database
      .select()
      .from(campaigns)
      .orderBy(asc(campaigns.campaignId));
    const authority = new TaskAuthority(handle.database);
    for (const campaignRow of campaignsRows) {
      if (!campaignRow.planHandedOff) continue;
      let campaignStatus: ReturnType<typeof decodeCampaignStatus>;
      try {
        campaignStatus = decodeCampaignState(campaignRow).status;
      } catch {
        continue;
      }
      if (isTerminalCampaignStatus(campaignStatus)) continue;
      const contract = decodePersistedGoalContract(campaignRow.contract);
      const proposalRows = await handle.database
        .select()
        .from(campaignProposals)
        .where(eq(campaignProposals.campaignId, campaignRow.campaignId))
        .orderBy(asc(campaignProposals.sequence));
      for (const row of proposalRows) {
        if (row.status !== "ready" || row.taskId !== null || !row.readyBaseSha) continue;
        const proposal = decodePersistedTaskProposal(row.proposal);
        const taskId = campaignTaskId(contract, proposal);
        const task = campaignTaskContract(contract, proposal, taskId, row.readyBaseSha);
        const rawContract = JSON.stringify(task);
        const repository = await handle.database.query.repositories.findFirst({
          where: eq(repositories.id, proposal.repositoryId),
        });
        if (!repository) continue;
        try {
          const result = await authority.admit(
            {
              contract: task,
              contractHash: hashTaskContract(rawContract),
              repositoryIdentity: repositoryIdentity(repository.owner, repository.name),
              repository: {
                id: repository.id,
                path: repository.path,
                owner: repository.owner,
                name: repository.name,
                baseBranch: repository.baseBranch,
                implementerProfile: repository.implementerProfile,
                reviewerProfile: repository.reviewerProfile,
                forgeProfile: repository.forgeProfile,
                githubReadProfile: repository.githubReadProfile,
                projectCheck: {
                  command: repository.projectCheckCommand,
                  timeoutMs: repository.projectCheckTimeoutMs,
                },
                gitAuthor: { name: repository.gitAuthorName, email: repository.gitAuthorEmail },
                ...(repository.headSha ? { headSha: repository.headSha } : {}),
              },
              deadlineEpochMs: undefined,
            },
            { contractPath: null, rawContract },
            activeTaskCapacity,
          );
          await handle.database
            .update(campaignProposals)
            .set({ taskId: result.taskId, updatedAt: new Date() })
            .where(
              and(
                eq(campaignProposals.campaignId, campaignRow.campaignId),
                eq(campaignProposals.proposalId, row.proposalId),
              ),
            );
          admissions.push({ result, input: { contractPath: null, rawContract }, contract: task });
        } catch (error) {
          if (error instanceof TaskCapacityError) return admissions;
          if (error instanceof RepositoryWriterConflictError) continue;
          throw error;
        }
      }
    }
    return admissions;
  } finally {
    handle.close();
  }
}

async function resourceFromDatabase(
  database: CampaignDatabase,
  campaignId: string,
): Promise<CampaignResource> {
  const campaign = await database.query.campaigns.findFirst({
    where: eq(campaigns.campaignId, campaignId),
  });
  if (!campaign) throw new Error("campaign not found");
  const campaignState = decodeCampaignState(campaign);
  const rows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const contract = decodePersistedGoalContract(campaign.contract);
  const results = await campaignTaskResults(database, rows);
  const outcomeEvidence = campaignOutcomeEvidence(campaign, contract, rows, results);
  const assessments = await campaignAssessmentRows(database, campaignId);
  const replacementRuns = await database
    .select()
    .from(campaignReplacementRuns)
    .where(eq(campaignReplacementRuns.campaignId, campaignId));
  const modelRunRows = await database
    .select()
    .from(campaignModelRuns)
    .where(eq(campaignModelRuns.campaignId, campaignId));
  const modelRunsByInvocation = new Map(
    modelRunRows.filter((row) => row.status !== "pending").map((row) => [row.invocationId, row]),
  );
  const replacementRunsByOutcome = new Map(replacementRuns.map((run) => [run.outcomeId, run]));
  const satisfiedOutcomes = new Set(
    contract.outcomes
      .filter((outcome) => outcome.status === "live")
      .filter((outcome) => {
        const assessment = assessments.get(outcome.id);
        const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
        return (
          outcomeEvidence.has(outcome.id) &&
          assessment?.evidenceHash === assessmentEvidenceHash(outcome, evidence) &&
          assessmentReferencesResolve(outcome, evidence, assessment)
        );
      })
      .map((outcome) => outcome.id),
  );
  return campaignResourceFromContract(
    contract,
    campaign.contractHash,
    campaignState.status,
    campaign.revision,
    {
      proposals: rows.map((row) => {
        const replacementRun = replacementRunsByOutcome.get(row.outcomeId);
        return proposalResource(
          row,
          replacementRun,
          replacementRun ? modelRunsByInvocation.get(replacementRun.invocationId) : undefined,
        );
      }),
      planHandedOff: campaign.planHandedOff,
      decisionRequest: campaignState.decisionRequest,
      outcomeEvidence,
      assessments,
      satisfiedOutcomes,
    },
  );
}

export async function publishCampaign(
  stateDirectory: string,
  rawContract: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  const contract = parseGoalContract(rawContract);
  const contractHash = createHash("sha256").update(rawContract, "utf8").digest("hex");
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    const existing = await database.query.campaigns.findFirst({
      where: and(eq(campaigns.goalId, contract.id), eq(campaigns.goalVersion, contract.version)),
    });
    if (existing) {
      if (existing.contractHash !== contractHash)
        throw new CampaignContentConflictError(existing.campaignId);
      await reconcileAll(database, observed);
      resource = await resourceFromDatabase(database, existing.campaignId);
      return;
    }
    const campaignId = campaignIdFor(contract.id, contract.version);
    await database.insert(campaigns).values({
      campaignId,
      goalId: contract.id,
      goalVersion: contract.version,
      contractHash,
      contract,
      status: "planning",
      publicationAuthorized: hostAuthorized(contract, environment),
      superseded: false,
      revision: 1,
    });
    await reconcileAll(database, observed);
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}

export async function proposeCampaign(
  stateDirectory: string,
  campaignId: string,
  input: unknown,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  let proposal: TaskProposal;
  try {
    proposal = parseTaskProposal(input);
  } catch (error) {
    throw new GoalContractInputError(
      error instanceof Error ? error.message : "invalid task proposal",
    );
  }
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    const campaign = await database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) throw new CampaignNotFoundError();
    const campaignState = decodeCampaignState(campaign);
    if (campaign.superseded || isTerminalCampaignStatus(campaignState.status))
      throw new CampaignHandoffError(campaignId);
    const existing = await database.query.campaignProposals.findFirst({
      where: and(
        eq(campaignProposals.campaignId, campaignId),
        eq(campaignProposals.proposalId, proposal.proposalId),
      ),
    });
    if (existing) {
      if (JSON.stringify(existing.proposal) !== JSON.stringify(proposal))
        throw new CampaignProposalConflictError(proposal.proposalId);
    } else {
      const sequenceRow = await database
        .select({ sequence: max(campaignProposals.sequence) })
        .from(campaignProposals)
        .where(eq(campaignProposals.campaignId, campaignId));
      const sequence = (sequenceRow[0]?.sequence ?? 0) + 1;
      await database.insert(campaignProposals).values({
        campaignId,
        proposalId: proposal.proposalId,
        sequence,
        outcomeId: proposal.outcomeId,
        proposal,
        status: "planned",
        blocker: null,
        readyBaseSha: null,
        readyRepositoryRevision: null,
      });
      if (campaign.planHandedOff) {
        await database
          .update(campaigns)
          .set({
            status: "planning",
            decisionRequest: null,
            checkpointRequested: false,
            revision: sql`${campaigns.revision} + 1`,
            updatedAt: nextCampaignUpdatedAt(campaign.updatedAt),
          })
          .where(eq(campaigns.campaignId, campaignId));
      }
    }
    await reconcileAll(database, observed);
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}

export async function handoffCampaign(
  stateDirectory: string,
  campaignId: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    const campaign = await database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) throw new CampaignNotFoundError();
    const campaignState = decodeCampaignState(campaign);
    if (!campaign.planHandedOff && !isTerminalCampaignStatus(campaignState.status)) {
      await database
        .update(campaigns)
        .set({
          planHandedOff: true,
          revision: sql`${campaigns.revision} + 1`,
          updatedAt: nextCampaignUpdatedAt(campaign.updatedAt),
        })
        .where(eq(campaigns.campaignId, campaignId));
    }
    await reconcileAll(database, observed);
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}

/** Request one fresh assessment at the current durable Campaign frontier. */
export async function checkpointCampaign(
  stateDirectory: string,
  campaignId: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database, observed) => {
    const campaign = await database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) throw new CampaignNotFoundError();
    const campaignState = decodeCampaignState(campaign);
    if (!campaign.planHandedOff || isTerminalCampaignStatus(campaignState.status))
      throw new CampaignCheckpointError(campaignId);
    const contract = decodePersistedGoalContract(campaign.contract);
    const rows = await database
      .select()
      .from(campaignProposals)
      .where(eq(campaignProposals.campaignId, campaignId))
      .orderBy(asc(campaignProposals.sequence));
    const results = await campaignTaskResults(database, rows);
    const assessments = await campaignAssessmentRows(database, campaignId);
    const assessmentNeeded = contract.outcomes
      .filter((outcome) => outcome.status === "live")
      .some((outcome) => {
        const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
        return (
          assessments.get(outcome.id)?.evidenceHash !== assessmentEvidenceHash(outcome, evidence)
        );
      });
    const currentGaps = contract.outcomes
      .filter((outcome) => outcome.status === "live")
      .some((outcome) => {
        const evidence = campaignAssessmentEvidence(rows, results, outcome.id);
        const assessment = assessments.get(outcome.id);
        return (
          assessment?.evidenceHash === assessmentEvidenceHash(outcome, evidence) &&
          assessment.verdict === "gaps"
        );
      });
    if (!campaign.assessmentRequested && (assessmentNeeded || currentGaps)) {
      await database
        .update(campaigns)
        .set({
          assessmentRequested: assessmentNeeded,
          checkpointRequested: true,
          revision: sql`${campaigns.revision} + 1`,
          updatedAt: nextCampaignUpdatedAt(campaign.updatedAt),
        })
        .where(eq(campaigns.campaignId, campaignId));
    }
    await reconcileAll(database, observed);
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}

export async function abandonCampaign(
  stateDirectory: string,
  campaignId: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database) => {
    const campaign = await database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) throw new CampaignNotFoundError();
    const campaignState = decodeCampaignState(campaign);
    const contract = decodePersistedGoalContract(campaign.contract);
    const configured = environment[CAMPAIGN_ABANDONMENT_SOURCE_ENV]?.trim();
    if (!configured || configured !== contract.authority.source)
      throw new CampaignAbandonmentError();
    if (campaignState.status !== "accepted" && campaignState.status !== "abandoned") {
      const updatedAt = nextCampaignUpdatedAt(campaign.updatedAt);
      await database
        .update(campaigns)
        .set({ status: "abandoned", decisionRequest: null, updatedAt })
        .where(eq(campaigns.campaignId, campaignId));
      await database
        .update(campaigns)
        .set({ revision: sql`${campaigns.revision} + 1`, updatedAt })
        .where(eq(campaigns.campaignId, campaignId));
    }
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}

export async function lookupCampaign(
  stateDirectory: string,
  campaignId: string,
): Promise<CampaignResource | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const found = await handle.database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!found) return null;
    return await resourceFromDatabase(handle.database, campaignId);
  } finally {
    handle.close();
  }
}

export async function listCampaignIds(stateDirectory: string): Promise<readonly string[]> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const rows = await handle.database
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .orderBy(asc(campaigns.campaignId));
    return rows.map((row) => row.campaignId);
  } finally {
    handle.close();
  }
}

export async function recordCampaignDecisionTouch(
  stateDirectory: string,
  campaignId: string,
  touchId: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CampaignResource> {
  if (!SAFE_CAMPAIGN_TOUCH_ID.test(touchId)) throw new CampaignTouchInputError();
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  await applyMigrations(databasePath);
  let resource: CampaignResource | undefined;
  await reconcileWithRepositoryHeads(stateDirectory, environment, async (database) => {
    const campaign = await database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) throw new CampaignNotFoundError();
    decodeCampaignState(campaign);
    await database
      .insert(campaignTouches)
      .values({
        campaignId,
        touchId: `decision:${touchId}`,
        goalVersion: campaign.goalVersion,
        type: "decision",
        occurredAtEpochMs: Date.now(),
      })
      .onConflictDoNothing();
    resource = await resourceFromDatabase(database, campaignId);
  });
  return resource!;
}
