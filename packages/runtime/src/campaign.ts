import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import {
  applyMigrations,
  campaignIdFor,
  campaignProposals,
  campaigns,
  campaignResourceFromContract,
  decodeCampaignProposalStatus,
  decodeCampaignStatus,
  goalContractSchema,
  openSqliteDatabase,
  parseTaskProposal,
  repositories,
  taskProposalSchema,
  type CampaignProposalResource,
  type CampaignResource,
  type GoalContract,
  type TaskProposal,
} from "@usine/task-authority";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { ensurePrivateStateDatabase } from "./private-state.js";
import { readCommittedContract } from "./verify-committed-contract.js";

export const MAX_GOAL_CONTRACT_BYTES = 1_048_576;
export const GOAL_PUBLICATION_SOURCE_ENV = "USINE_GOAL_PUBLICATION_SOURCE";
const GOAL_CONTRACT_INGESTION_TIMEOUT_MS = 30_000;
const EXACT_SHA = /^[0-9a-f]{40}$/;

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
      row.status !== "ready" || row.readyBaseSha === null || row.readyRepositoryRevision === null
        ? null
        : {
            repositoryId: proposal.repositoryId,
            baseSha: row.readyBaseSha,
            repositoryRevision: row.readyRepositoryRevision,
            instructions: proposal.instructions,
            acceptance: proposal.acceptance,
            nonGoals: proposal.nonGoals,
            effects: proposal.effects,
            budget: proposal.budget,
            merge: proposal.merge,
          },
  };
}

function blockerFor(
  row: typeof campaignProposals.$inferSelect,
  proposal: TaskProposal,
  contract: GoalContract,
  publicationAuthorized: boolean,
  superseded: boolean,
  repository: typeof repositories.$inferSelect | undefined,
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
  const hasDurableReadyBase =
    row.status === "ready" && row.readyBaseSha !== null && row.readyRepositoryRevision !== null;
  if (!repository && !hasDurableReadyBase) return "proposal repository is not registered";
  if (!hasDurableReadyBase && (!repository?.headSha || !EXACT_SHA.test(repository.headSha)))
    return "registered repository has no exact head";
  return null;
}

function dependencyBlocker(
  proposal: TaskProposal,
  rows: readonly (typeof campaignProposals.$inferSelect)[],
  contract: GoalContract,
): string | null {
  for (const dependency of proposal.dependsOn) {
    const row = rows.find((candidate) => candidate.proposalId === dependency);
    if (!row) return "proposal dependency is not admitted";
    if (row.status !== "ready") return "proposal dependency is not ready";
  }
  const outcome = contract.outcomes.find((candidate) => candidate.id === proposal.outcomeId);
  for (const dependency of outcome?.dependsOn ?? []) {
    const satisfied = rows.some(
      (row) =>
        row.status === "ready" && taskProposalSchema.parse(row.proposal).outcomeId === dependency,
    );
    if (!satisfied) return "outcome dependency is not ready";
  }
  return null;
}

type CampaignDatabase = ReturnType<typeof openSqliteDatabase>["database"];

async function reconcile(database: CampaignDatabase, campaignId: string): Promise<void> {
  const campaign = await database.query.campaigns.findFirst({
    where: eq(campaigns.campaignId, campaignId),
  });
  if (!campaign) throw new Error("campaign not found");
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
  let passChanged: boolean;
  do {
    passChanged = false;
    for (const row of rows) {
      const proposal = taskProposalSchema.parse(row.proposal);
      const blocker = blockerFor(
        row,
        proposal,
        contract,
        campaign.publicationAuthorized,
        superseded,
        repositoriesById.get(proposal.repositoryId),
      );
      const dependency = blocker === null ? dependencyBlocker(proposal, rows, contract) : null;
      const nextStatus = blocker ? "blocked" : dependency ? "planned" : "ready";
      const nextBlocker = blocker ?? dependency;
      const repository = repositoriesById.get(proposal.repositoryId);
      const nextBaseSha =
        nextStatus === "ready" ? (row.readyBaseSha ?? repository?.headSha ?? null) : null;
      const nextRevision =
        nextStatus === "ready"
          ? (row.readyRepositoryRevision ?? repository?.revision ?? null)
          : null;
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
        passChanged = true;
      }
    }
  } while (passChanged);
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

async function refreshRepositoryHeads(
  database: CampaignDatabase,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const rows = await database.select().from(repositories);
  for (const row of rows) {
    try {
      const headSha = (
        await execa("git", ["-C", row.path, "rev-parse", "HEAD"], {
          env: credentialFreeGitEnvironment(environment),
          extendEnv: false,
          timeout: 30_000,
        })
      ).stdout.trim();
      if (!EXACT_SHA.test(headSha) || headSha === row.headSha) continue;
      await database
        .update(repositories)
        .set({ headSha, revision: sql`${repositories.revision} + 1`, updatedAt: new Date() })
        .where(eq(repositories.id, row.id));
    } catch {
      // An unavailable repository remains planned or blocked by reconciliation.
    }
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
  return campaignResourceFromContract(
    goalContractSchema.parse(campaign.contract),
    campaign.contractHash,
    decodeCampaignStatus(campaign.status),
    campaign.revision,
    rows.length ? { proposals: rows.map(proposalResource) } : undefined,
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
  const handle = openSqliteDatabase(databasePath);
  try {
    return await handle.exclusiveTransaction(async () => {
      const existing = await handle.database.query.campaigns.findFirst({
        where: and(eq(campaigns.goalId, contract.id), eq(campaigns.goalVersion, contract.version)),
      });
      if (existing) {
        if (existing.contractHash !== contractHash)
          throw new CampaignContentConflictError(existing.campaignId);
        await refreshRepositoryHeads(handle.database, environment);
        await reconcile(handle.database, existing.campaignId);
        return resourceFromDatabase(handle.database, existing.campaignId);
      }
      const campaignId = campaignIdFor(contract.id, contract.version);
      await handle.database
        .update(campaigns)
        .set({ superseded: true, updatedAt: new Date() })
        .where(
          and(
            eq(campaigns.goalId, contract.id),
            sql`${campaigns.goalVersion} < ${contract.version}`,
          ),
        );
      await handle.database.insert(campaigns).values({
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
      await reconcile(handle.database, campaignId);
      return resourceFromDatabase(handle.database, campaignId);
    });
  } finally {
    handle.close();
  }
}

export async function proposeCampaign(
  stateDirectory: string,
  campaignId: string,
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
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
  const handle = openSqliteDatabase(databasePath);
  try {
    return await handle.exclusiveTransaction(async () => {
      const campaign = await handle.database.query.campaigns.findFirst({
        where: eq(campaigns.campaignId, campaignId),
      });
      if (!campaign) throw new CampaignNotFoundError();
      const existing = await handle.database.query.campaignProposals.findFirst({
        where: and(
          eq(campaignProposals.campaignId, campaignId),
          eq(campaignProposals.proposalId, proposal.proposalId),
        ),
      });
      if (existing) {
        if (JSON.stringify(existing.proposal) !== JSON.stringify(proposal))
          throw new CampaignProposalConflictError(proposal.proposalId);
      } else {
        const sequenceRow = await handle.database
          .select({ sequence: max(campaignProposals.sequence) })
          .from(campaignProposals)
          .where(eq(campaignProposals.campaignId, campaignId));
        const sequence = (sequenceRow[0]?.sequence ?? 0) + 1;
        await handle.database.insert(campaignProposals).values({
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
      await refreshRepositoryHeads(handle.database, environment);
      await reconcile(handle.database, campaignId);
      return resourceFromDatabase(handle.database, campaignId);
    });
  } finally {
    handle.close();
  }
}

export async function lookupCampaign(
  stateDirectory: string,
  campaignId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CampaignResource | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  try {
    const found = await handle.database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!found) return null;
    await refreshRepositoryHeads(handle.database, environment);
    await reconcile(handle.database, campaignId);
    return resourceFromDatabase(handle.database, campaignId);
  } finally {
    handle.close();
  }
}
