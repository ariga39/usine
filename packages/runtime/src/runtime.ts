import { DBOS } from "@dbos-inc/dbos-sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { TaskContract } from "./contract.js";
import { applyMigrations } from "./apply-migrations.js";
import { CandidateWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { executeDeliveryRun, writeTaskResult, type DeliveryRunInput } from "./delivery-run.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { repositoryLeases, taskRuns } from "./schema.js";
import { TaskAuthority, hashTaskContract, type TaskResult } from "./task-authority.js";
import { verifyCommittedContract } from "./verify-committed-contract.js";

export type { CheckResult, DeliveryEffect, ReviewVerdict, TaskResult, TaskState } from "./task-authority.js";

export async function admitTask(contractPath: string, rawContract: string, contract: TaskContract): Promise<TaskResult> {
  const databaseUrl = process.env.USINE_DATABASE_URL;
  if (!databaseUrl) throw new Error("USINE_DATABASE_URL is required");
  const deadlineEpochMs = Date.now() + contract.budget.maxElapsedMs;
  const repository = await verifyCommittedContract(contractPath, contract, deadlineEpochMs);
  await applyMigrations(databaseUrl);
  const stateDirectory = process.env.USINE_STATE_DIR ?? ".usine";
  const contractHash = hashTaskContract(rawContract);
  const repositoryIdentity = `${contract.repository.owner}/${contract.repository.name}`.toLowerCase();
  const pool = new Pool({ connectionString: databaseUrl });
  const database = drizzle(pool, { schema: { repositoryLeases, taskRuns } });
  const authority = new TaskAuthority(database);
  const workspace = new CandidateWorkspace({ repository, stateDirectory, deadlineEpochMs });
  const session = new CodexCodingSession();
  const quality = new QualityGate({ workspace, session, reviewerModel: process.env.USINE_REVIEWER_MODEL ?? "gpt-5.6-sol", reviewerReasoningEffort: process.env.USINE_REVIEWER_REASONING_EFFORT ?? "low", deadlineEpochMs });
  const forge = new ForgeDelivery({ repository, deadlineEpochMs });
  const workflowInput: DeliveryRunInput = {
    contract,
    contractHash,
    repository,
    repositoryIdentity,
    stateDirectory,
    deadlineEpochMs,
    implementerModel: process.env.USINE_IMPLEMENTER_MODEL ?? "gpt-5.6-luna",
    reviewerModel: process.env.USINE_REVIEWER_MODEL ?? "gpt-5.6-sol",
    reviewerReasoningEffort: process.env.USINE_REVIEWER_REASONING_EFFORT ?? "low",
    crashAfterActivation: process.env.USINE_CRASH_AFTER === "activation",
  };
  DBOS.setConfig({ name: "usine", systemDatabaseUrl: databaseUrl, applicationVersion: "0.1.0", logLevel: "warn" });
  await DBOS.launch();
  try {
    const workflow = DBOS.registerWorkflow(async (input: DeliveryRunInput) => executeDeliveryRun(input, { authority, workspace, session, quality, forge }), { name: "deliveryRun" });
    const handle = await DBOS.startWorkflow(workflow, { workflowID: contract.id })(workflowInput);
    const result = await handle.getResult();
    await writeTaskResult(stateDirectory, result);
    return result;
  } finally {
    await DBOS.shutdown({ deregister: true });
    await pool.end();
  }
}
