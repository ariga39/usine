import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import {
  applyMigrations,
  acceptedTaskDelivery,
  campaignIdFor,
  campaignProposals,
  campaignTouches,
  campaigns,
  campaignResourceFromContract,
  decodeCampaignDecisionRequest,
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
  taskProposalSchema,
  isTaskStateQuarantinedError,
  type CampaignProposalResource,
  type CampaignDecisionRequest,
  type CampaignOutcomeEvidence,
  type CampaignResource,
  type GoalContract,
  type TaskExecutionInput,
  type TaskResult,
  type TaskContract,
  type TaskProposal,
  isTerminalState,
} from "@usine/task-authority";
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

function proposalResource(row: typeof campaignProposals.$inferSelect): CampaignProposalResource {
  const proposal = taskProposalSchema.parse(row.proposal);
  return {
    proposalId: row.proposalId,
    outcomeId: row.outcomeId,
    sequence: row.sequence,
    status: decodeCampaignProposalStatus(row.status),
    blocker: row.blocker,
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
            budget: proposal.budget,
            merge: proposal.merge,
          },
  };
}

export interface CampaignTaskAdmission {
  readonly result: TaskResult;
  readonly input: TaskExecutionInput;
  readonly contract: TaskContract;
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
  const deliveryTitle = `Campaign ${campaignIdFor(contract.id, contract.version)}: ${
    outcome?.title ?? proposal.outcomeId
  }`
    .normalize("NFKC")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_CAMPAIGN_DELIVERY_TITLE_LENGTH)
    .trimEnd();
  const task: TaskContract = {
    id: taskId,
    repositoryId: proposal.repositoryId,
    baseSha,
    instructions: proposal.instructions,
    acceptance: [...proposal.acceptance],
    nonGoals: [...proposal.nonGoals],
    budget: { ...proposal.budget },
    authorization: {
      source: contract.authority.source,
      delivery: true,
      ...(proposal.merge ? { merge: true } : {}),
    },
    delivery: {
      branch: `agent/${taskId}`,
      title: deliveryTitle || "Campaign task",
      body: `Campaign ${campaignIdFor(contract.id, contract.version)} Outcome ${proposal.outcomeId}`,
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
  if (row.sequence > contract.budget.maxTasks) return "campaign task budget is exhausted";
  if (!contract.authority.repositories.includes(proposal.repositoryId))
    return "proposal repository is outside the Goal authority envelope";
  if (!contract.authority.delivery) return "Goal delivery authority is not granted";
  if (proposal.effects.some((effect) => !contract.authority.effects.includes(effect)))
    return "proposal effect is outside the Goal authority envelope";
  if (proposal.merge && !contract.authority.merge)
    return "proposal merge authority is outside the Goal authority envelope";
  if (
    contract.budget.maxImplementerActivations < proposal.budget.maxImplementerActivations ||
    contract.budget.maxReviewCycles < proposal.budget.maxReviewCycles ||
    proposal.budget.maxElapsedMs > contract.budget.maxElapsedMs
  )
    return "proposal budget is outside the Goal budget envelope";
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
): Promise<DependencyResolution> {
  const dependencies = new Map<string, typeof campaignProposals.$inferSelect>();
  const proposalDependencyIds = new Set<string>();
  for (const dependency of proposal.dependsOn) {
    const row = rows.find((candidate) => candidate.proposalId === dependency);
    if (!row) return { blocker: "proposal dependency is not admitted", baseSha: null };
    dependencies.set(row.proposalId, row);
    proposalDependencyIds.add(row.proposalId);
  }
  const outcome = contract.outcomes.find((candidate) => candidate.id === proposal.outcomeId);
  const outcomeDependencyIds = new Set<string>();
  for (const dependency of outcome?.dependsOn ?? []) {
    outcomeDependencyIds.add(dependency);
    let found = false;
    for (const row of rows) {
      if (taskProposalSchema.parse(row.proposal).outcomeId === dependency) {
        dependencies.set(row.proposalId, row);
        found = true;
      }
    }
    if (!found) return { blocker: "outcome dependency has no admitted proposal", baseSha: null };
  }

  let mergedHeadSha: string | null = null;
  let latestMergedSequence = -1;
  for (const row of dependencies.values()) {
    const predecessor = taskProposalSchema.parse(row.proposal);
    let task: TaskResult | null = null;
    if (row.taskId) {
      try {
        task = await new TaskAuthority(database).lookup(row.taskId);
      } catch (error) {
        if (!isTaskStateQuarantinedError(error)) throw error;
      }
    }
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
  let campaignStatus: ReturnType<typeof decodeCampaignStatus>;
  let decisionRequest: CampaignDecisionRequest | null;
  try {
    campaignStatus = decodeCampaignStatus(campaign.status);
    decisionRequest = decodeCampaignDecisionRequest(campaign.decisionRequest);
  } catch {
    // Preserve corrupt durable state for the owning read path to report.
    return;
  }
  const contract = goalContractSchema.parse(campaign.contract);
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
  let changed = false;
  for (const row of rows) {
    const proposal = taskProposalSchema.parse(row.proposal);
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
        ? await dependencyResolution(proposal, rows, contract, campaign, database)
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
    const results = await campaignTaskResults(database, rows);
    const outcomeEvidence = campaignOutcomeEvidence(campaign, contract, rows, results);
    const liveOutcomes = contract.outcomes.filter((outcome) => outcome.status === "live");
    if (
      campaign.publicationAuthorized &&
      liveOutcomes.length > 0 &&
      liveOutcomes.every((outcome) => outcomeEvidence.has(outcome.id))
    ) {
      campaignStatus = "accepted";
      decisionRequest = null;
    } else if (!hasUsefulCampaignWork(rows, results)) {
      campaignStatus = "blocked";
      decisionRequest ??= {
        requestId: `decision:${campaign.campaignId}`,
        reason:
          rows.some((row) => row.status === "blocked") ||
          [...results.values()].some((result) => result.state === "blocked")
            ? "branches_blocked"
            : "plan_exhausted",
        outcomeIds: liveOutcomes
          .filter((outcome) => !outcomeEvidence.has(outcome.id))
          .map((outcome) => outcome.id),
      };
    }
  }
  if (
    campaign.status !== campaignStatus ||
    JSON.stringify(campaign.decisionRequest ?? null) !== JSON.stringify(decisionRequest)
  ) {
    await database
      .update(campaigns)
      .set({ status: campaignStatus, decisionRequest, updatedAt: new Date() })
      .where(eq(campaigns.campaignId, campaignId));
    changed = true;
  }
  if (superseded !== campaign.superseded) {
    await database
      .update(campaigns)
      .set({ superseded, updatedAt: new Date() })
      .where(eq(campaigns.campaignId, campaignId));
  }
  if (changed || superseded !== campaign.superseded)
    await database
      .update(campaigns)
      .set({ revision: sql`${campaigns.revision} + 1`, updatedAt: new Date() })
      .where(eq(campaigns.campaignId, campaignId));
}

function isTerminalCampaignStatus(status: ReturnType<typeof decodeCampaignStatus>): boolean {
  return status === "accepted" || status === "blocked" || status === "abandoned";
}

async function reconcileAll(
  database: CampaignDatabase,
  observedRepositoryIds: ReadonlySet<string>,
): Promise<void> {
  const rows = await database.select({ campaignId: campaigns.campaignId }).from(campaigns);
  for (const row of rows) await reconcile(database, row.campaignId, observedRepositoryIds);
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
): Promise<Map<string, TaskResult>> {
  const authority = new TaskAuthority(database);
  const results = new Map<string, TaskResult>();
  for (const row of rows) {
    if (!row.taskId) continue;
    try {
      const result = await authority.lookup(row.taskId);
      if (result) results.set(row.proposalId, result);
    } catch (error) {
      if (!isTaskStateQuarantinedError(error)) throw error;
    }
  }
  return results;
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
    const proposal = taskProposalSchema.parse(row.proposal);
    const outcomeRows = proposalsByOutcome.get(proposal.outcomeId) ?? [];
    outcomeRows.push(row);
    proposalsByOutcome.set(proposal.outcomeId, outcomeRows);
  }
  for (const [outcomeId, outcomeRows] of proposalsByOutcome) {
    let firstAccepted: AcceptedCampaignDelivery | null = null;
    let allAccepted = true;
    for (const row of outcomeRows) {
      const proposal = taskProposalSchema.parse(row.proposal);
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
    const result = results.get(row.proposalId);
    if (result) {
      if (!isTerminalState(result.state)) return true;
      continue;
    }
    if (row.status === "ready") return true;
  }
  return false;
}

export async function reconcileCampaigns(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = {},
  activeTaskCapacity = 1,
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
  return admitReadyCampaignTasks(stateDirectory, activeTaskCapacity);
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
        campaignStatus = decodeCampaignStatus(campaignRow.status);
      } catch {
        continue;
      }
      if (isTerminalCampaignStatus(campaignStatus)) continue;
      const contract = goalContractSchema.parse(campaignRow.contract);
      const proposalRows = await handle.database
        .select()
        .from(campaignProposals)
        .where(eq(campaignProposals.campaignId, campaignRow.campaignId))
        .orderBy(asc(campaignProposals.sequence));
      for (const row of proposalRows) {
        if (row.status !== "ready" || row.taskId !== null || !row.readyBaseSha) continue;
        const proposal = taskProposalSchema.parse(row.proposal);
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
              deadlineEpochMs: Date.now() + task.budget.maxElapsedMs,
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
  const rows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const contract = goalContractSchema.parse(campaign.contract);
  const results = await campaignTaskResults(database, rows);
  const outcomeEvidence = campaignOutcomeEvidence(campaign, contract, rows, results);
  return campaignResourceFromContract(
    contract,
    campaign.contractHash,
    decodeCampaignStatus(campaign.status),
    campaign.revision,
    {
      proposals: rows.map(proposalResource),
      planHandedOff: campaign.planHandedOff,
      decisionRequest: decodeCampaignDecisionRequest(campaign.decisionRequest),
      outcomeEvidence,
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
    await database
      .update(campaigns)
      .set({ superseded: true, updatedAt: new Date() })
      .where(
        and(eq(campaigns.goalId, contract.id), sql`${campaigns.goalVersion} < ${contract.version}`),
      );
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
    if (campaign.planHandedOff || isTerminalCampaignStatus(decodeCampaignStatus(campaign.status)))
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
    if (
      !campaign.planHandedOff &&
      !isTerminalCampaignStatus(decodeCampaignStatus(campaign.status))
    ) {
      await database
        .update(campaigns)
        .set({
          planHandedOff: true,
          revision: sql`${campaigns.revision} + 1`,
          updatedAt: new Date(),
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
    const contract = goalContractSchema.parse(campaign.contract);
    const configured = environment[CAMPAIGN_ABANDONMENT_SOURCE_ENV]?.trim();
    if (!configured || configured !== contract.authority.source)
      throw new CampaignAbandonmentError();
    if (
      decodeCampaignStatus(campaign.status) !== "accepted" &&
      decodeCampaignStatus(campaign.status) !== "abandoned"
    ) {
      await database
        .update(campaigns)
        .set({ status: "abandoned", decisionRequest: null, updatedAt: new Date() })
        .where(eq(campaigns.campaignId, campaignId));
      await database
        .update(campaigns)
        .set({ revision: sql`${campaigns.revision} + 1`, updatedAt: new Date() })
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
