import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace, type WriterWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { ForgeDelivery } from "./forge-delivery.js";
import { QualityGate } from "./quality-gate.js";
import { TaskAuthority, type TaskResult } from "./task-authority.js";

export interface DeliveryRunInput {
  contract: TaskContract;
  contractHash: string;
  repository: string;
  repositoryIdentity: string;
  stateDirectory: string;
  deadlineEpochMs: number;
  implementerModel: string;
  reviewerModel: string;
  reviewerReasoningEffort: string;
  stopAfterAdmitted: boolean;
  crashAfterActivation: boolean;
}

export interface DeliveryRunServices {
  authority: TaskAuthority;
  workspace: CandidateWorkspace;
  session: CodexCodingSession;
  quality: QualityGate;
  forge: ForgeDelivery;
}

const implementerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["proposed", "blocked"] },
    summary: { type: "string" },
  },
};

function failedResult(result: TaskResult, blocker: string): TaskResult {
  return { ...result, state: "blocked", blocker };
}

export function nextActivation(
  result: Pick<TaskResult, "evidence">,
  budget: number,
): number | null {
  const activation = result.evidence.implementerActivations + 1;
  return activation > budget ? null : activation;
}

async function armSessionCrash(input: DeliveryRunInput): Promise<void> {
  const marker = resolve(input.stateDirectory, "recovery", `${input.contract.id}-activation-crash`);
  try {
    await readFile(marker, "utf8");
  } catch {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "activation checkpointed\n");
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 50).unref();
  }
}

function implementerPrompt(
  input: DeliveryRunInput,
  previousSha: string,
  findings: string[],
): string {
  return [
    "Role: implementer. Work only on the frozen authorized Task Contract.",
    `Task Contract: ${JSON.stringify(input.contract)}`,
    `Current candidate parent SHA: ${previousSha}`,
    findings.length > 0
      ? `Aggregated findings to repair: ${findings.join("; ")}`
      : "No prior findings.",
    "Implement the requested production behavior and its real tests. Leave the workspace with the complete change; the host will finalize the commit.",
    "Return a schema-valid proposed or blocked result. Do not claim task completion; the coordinator owns authority.",
  ].join("\n");
}

type CodingAttempt =
  | {
      status: "succeeded";
      result: TaskResult;
      candidate: { sha: string; baseSha: string; workspace: WriterWorkspace };
    }
  | { status: "failed"; result: TaskResult; reason: string };

async function runCodingAttempt(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
  previousSha: string,
  findings: string[],
): Promise<CodingAttempt> {
  const reservation = await services.authority.reserveActivation(
    input.contract.id,
    input.contract.budget.maxImplementerActivations,
  );
  await services.workspace.quarantinePriorWriters(input.contract.id, reservation.activation);
  const workspace = await services.workspace.prepareWriter(
    input.contract.id,
    reservation.activation,
    previousSha,
  );
  if (input.crashAfterActivation) await armSessionCrash(input);
  const observation = await services.session.run({
    role: "implementer",
    workspace: workspace.path,
    contract: input.contract,
    prompt: implementerPrompt(input, previousSha, findings),
    model: input.implementerModel,
    reasoningEffort: "high",
    sandbox: "workspace-write",
    deadlineEpochMs: input.deadlineEpochMs,
    outputSchema: implementerSchema,
  });
  if (observation.status !== "completed") {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer failed: ${observation.failure ?? observation.summary}`,
    };
  }
  const output =
    typeof observation.output === "string"
      ? (() => {
          try {
            return JSON.parse(observation.output) as { status?: string; summary?: string };
          } catch {
            return {};
          }
        })()
      : (observation.output as { status?: string; summary?: string } | null);
  if (output?.status === "blocked")
    return {
      status: "failed",
      result: reservation.result,
      reason: `implementer blocked: ${output.summary ?? "no reason"}`,
    };
  if (!output || output.status !== "proposed" || typeof output.summary !== "string") {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: "implementer returned invalid terminal observation",
    };
  }
  try {
    const candidate = await services.workspace.freeze(workspace, previousSha);
    services.authority.acceptCandidate(reservation.result, {
      sha: candidate.sha,
      baseSha: candidate.baseSha,
      generation: reservation.result.writer.generation,
      fence: workspace.fence,
    });
    return {
      status: "succeeded",
      result: reservation.result,
      candidate: { ...candidate, workspace },
    };
  } catch (error) {
    await services.workspace.quarantine(workspace);
    return {
      status: "failed",
      result: reservation.result,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeDeliveryRun(
  input: DeliveryRunInput,
  services: DeliveryRunServices,
): Promise<TaskResult> {
  let result = await services.authority.admit({
    contract: input.contract,
    contractHash: input.contractHash,
    repository: input.repository,
    repositoryIdentity: input.repositoryIdentity,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  if (result.state === "reviewed_pr" || result.state === "blocked") return result;
  if (input.stopAfterAdmitted) return result;
  let previousSha = input.contract.baseSha;
  let findings: string[] = [];
  for (let cycle = 1; cycle <= input.contract.budget.maxReviewCycles; cycle += 1) {
    let attempt: Awaited<ReturnType<typeof runCodingAttempt>>;
    try {
      attempt = await runCodingAttempt(input, services, previousSha, findings);
    } catch (error) {
      return services.authority.save(
        failedResult(result, error instanceof Error ? error.message : String(error)),
      );
    }
    result = attempt.result;
    const activation = result.evidence.implementerActivations;
    if (attempt.status === "failed") {
      if (result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations)
        return services.authority.save(failedResult(result, attempt.reason));
      continue;
    }
    const candidate = attempt.candidate;
    result = await services.authority.save({
      ...result,
      state: "candidate",
      candidateSha: candidate.sha,
      candidateFence: candidate.workspace.fence,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      activeActivation: null,
    });
    const evaluation = await services.quality.evaluate(input.contract, candidate.sha, cycle);
    result = await services.authority.save({
      ...result,
      state: "checked",
      check: evaluation.check,
    });
    if (evaluation.check.status !== "passed") {
      findings = [evaluation.check.stderr || "project check failed"];
      previousSha = candidate.sha;
      if (activation >= input.contract.budget.maxImplementerActivations)
        return services.authority.save(
          failedResult(result, "project check failed after repair budget was exhausted"),
        );
      continue;
    }
    result = await services.authority.save({
      ...result,
      state: "reviewed",
      review: evaluation.review,
      evidence: { ...result.evidence, reviewCycles: cycle },
    });
    if (evaluation.review.verdict === "approved") {
      const delivery = await services.forge.deliver(
        input.contract,
        candidate.sha,
        evaluation.check,
        evaluation.review,
      );
      return services.authority.save({ ...result, state: "reviewed_pr", delivery });
    }
    if (evaluation.review.verdict === "inconclusive")
      return services.authority.save(
        failedResult(result, `review inconclusive: ${evaluation.review.summary}`),
      );
    findings = evaluation.review.findings;
    previousSha = candidate.sha;
    result = {
      ...result,
      evidence: {
        ...result.evidence,
        changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
      },
    };
    if (
      cycle >= input.contract.budget.maxReviewCycles ||
      result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
    )
      return services.authority.save(
        failedResult(result, "review changes requested after recovery budget was exhausted"),
      );
  }
  return services.authority.save(failedResult(result, "review budget exhausted"));
}

export async function writeTaskResult(stateDirectory: string, result: TaskResult): Promise<void> {
  const path = resolve(stateDirectory, "results", `${result.taskId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}
