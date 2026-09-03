import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import {
  campaigns,
  campaignResourceFromContract,
  campaignIdFor,
  contractIssues,
  decodeCampaignStatus,
  goalContractSchema,
  openSqliteDatabase,
  type CampaignResource,
  type GoalContract,
} from "@usine/task-authority";
import { ensurePrivateStateDatabase } from "./private-state.js";
import { readCommittedContract } from "./verify-committed-contract.js";

export const MAX_GOAL_CONTRACT_BYTES = 1_048_576;
const GOAL_CONTRACT_INGESTION_TIMEOUT_MS = 30_000;

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
    const issues = contractIssues(parsed.error);
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

export async function publishCampaign(
  stateDirectory: string,
  rawContract: string,
): Promise<CampaignResource> {
  const contract = parseGoalContract(rawContract);
  const contractHash = createHash("sha256").update(rawContract, "utf8").digest("hex");
  const databasePath = await ensurePrivateStateDatabase(stateDirectory);
  const handle = openSqliteDatabase(databasePath);
  try {
    return await handle.exclusiveTransaction(async () => {
      const existing = await handle.database.query.campaigns.findFirst({
        where: (table, { and, eq }) =>
          and(eq(table.goalId, contract.id), eq(table.goalVersion, contract.version)),
      });
      if (existing) {
        if (existing.contractHash !== contractHash)
          throw new CampaignContentConflictError(existing.campaignId);
        return campaignResourceFromContract(
          contract,
          existing.contractHash,
          decodeCampaignStatus(existing.status),
          existing.revision,
        );
      }
      const campaignId = campaignIdFor(contract.id, contract.version);
      await handle.database.insert(campaigns).values({
        campaignId,
        goalId: contract.id,
        goalVersion: contract.version,
        contractHash,
        contract,
        status: "planning",
        revision: 1,
      });
      return campaignResourceFromContract(contract, contractHash, "planning", 1);
    });
  } finally {
    handle.close();
  }
}

export async function lookupCampaign(
  stateDirectory: string,
  campaignId: string,
): Promise<CampaignResource | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = await handle.database.query.campaigns.findFirst({
      where: (table, { eq }) => eq(table.campaignId, campaignId),
    });
    if (!row) return null;
    const contract = goalContractSchema.parse(row.contract);
    return campaignResourceFromContract(
      contract,
      row.contractHash,
      decodeCampaignStatus(row.status),
      row.revision,
    );
  } finally {
    handle.close();
  }
}
