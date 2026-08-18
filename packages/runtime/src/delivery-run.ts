import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace } from "./candidate-workspace.js";
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
  properties: { status: { type: "string", enum: ["proposed", "blocked"] }, summary: { type: "string" } },
};

function failedResult(result: TaskResult, blocker: string): TaskResult {
  return { ...result, state: "blocked", blocker };
}

async function crashOnce(input: DeliveryRunInput): Promise<void> {
  const marker = resolve(input.stateDirectory, "recovery", `${input.contract.id}-activation-crash`);
  try {
    await readFile(marker, "utf8");
  } catch {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "activation checkpointed\n");
    process.kill(process.pid, "SIGKILL");
  }
}

function implementerPrompt(input: DeliveryRunInput, previousSha: string, findings: string[]): string {
  return [
    "Role: implementer. Work only on the frozen authorized Task Contract.",
    `Task Contract: ${JSON.stringify(input.contract)}`,
    `Current candidate parent SHA: ${previousSha}`,
    findings.length > 0 ? `Aggregated findings to repair: ${findings.join("; ")}` : "No prior findings.",
    "Implement the requested production behavior and its real tests. Leave the workspace with the complete change; the host will finalize the commit.",
    "Return a schema-valid proposed or blocked result. Do not claim task completion; the coordinator owns authority.",
  ].join("\n");
}

export async function executeDeliveryRun(input: DeliveryRunInput, services: DeliveryRunServices): Promise<TaskResult> {
  let result = await DBOS.runStep(() => services.authority.admit({ contract: input.contract, contractHash: input.contractHash, repository: input.repository, repositoryIdentity: input.repositoryIdentity, deadlineEpochMs: input.deadlineEpochMs }), { name: "admit-task" });
  let previousSha = input.contract.baseSha;
  let findings: string[] = [];
  for (let cycle = 1; cycle <= input.contract.budget.maxReviewCycles; cycle += 1) {
    const activation = result.evidence.implementerActivations + 1;
    if (activation > input.contract.budget.maxImplementerActivations) return services.authority.save(failedResult(result, "implementer activation budget exhausted"));
    result = await DBOS.runStep(() => services.authority.save({ ...result, evidence: { ...result.evidence, implementerActivations: activation } }), { name: `activate-implementer-${activation}` });
    if (input.crashAfterActivation) await DBOS.runStep(() => crashOnce(input), { name: `crash-after-activation-${activation}` });

    const workspace = await services.workspace.prepareWriter(input.contract.id, activation, previousSha);
    const observation = await DBOS.runStep(() => services.session.run({
      role: "implementer",
      workspace: workspace.path,
      contract: input.contract,
      prompt: implementerPrompt(input, previousSha, findings),
      model: input.implementerModel,
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: input.deadlineEpochMs,
      outputSchema: implementerSchema,
    }), { name: `implementer-session-${activation}` });
    if (observation.status !== "completed") {
      await services.workspace.quarantine(workspace);
      if (activation >= input.contract.budget.maxImplementerActivations) return services.authority.save(failedResult(result, `implementer failed: ${observation.failure ?? observation.summary}`));
      continue;
    }
    const output = typeof observation.output === "string" ? (() => { try { return JSON.parse(observation.output) as { status?: string; summary?: string }; } catch { return {}; } })() : observation.output as { status?: string; summary?: string } | null;
    if (output?.status === "blocked") return services.authority.save(failedResult(result, `implementer blocked: ${output.summary ?? "no reason"}`));

    let candidate;
    try {
      candidate = await services.workspace.freeze(workspace, previousSha);
      services.authority.acceptCandidate(result, { sha: candidate.sha, baseSha: candidate.baseSha, generation: result.writer.generation, fence: workspace.fence });
    } catch (error) {
      await services.workspace.quarantine(workspace);
      return services.authority.save(failedResult(result, error instanceof Error ? error.message : String(error)));
    }
    result = await DBOS.runStep(() => services.authority.save({ ...result, state: "candidate", candidateSha: candidate.sha, check: null, review: null, delivery: null, blocker: null }), { name: `freeze-candidate-${activation}` });
    const evaluation = await DBOS.runStep(() => services.quality.evaluate(input.contract, candidate.sha, cycle), { name: `quality-gate-${cycle}` });
    result = await DBOS.runStep(() => services.authority.save({ ...result, state: "checked", check: evaluation.check }), { name: `save-check-${cycle}` });
    if (evaluation.check.status !== "passed") {
      findings = [evaluation.check.stderr || "project check failed"];
      previousSha = candidate.sha;
      if (activation >= input.contract.budget.maxImplementerActivations) return services.authority.save(failedResult(result, "project check failed after repair budget was exhausted"));
      continue;
    }
    result = await DBOS.runStep(() => services.authority.save({ ...result, state: "reviewed", review: evaluation.review, evidence: { ...result.evidence, reviewCycles: cycle } }), { name: `save-review-${cycle}` });
    if (evaluation.review.verdict === "approved") {
      const delivery = await DBOS.runStep(() => services.forge.deliver(input.contract, candidate.sha, evaluation.check, evaluation.review), { name: "forge-delivery" });
      return services.authority.save({ ...result, state: "reviewed_pr", delivery });
    }
    if (evaluation.review.verdict === "inconclusive") return services.authority.save(failedResult(result, `review inconclusive: ${evaluation.review.summary}`));
    findings = evaluation.review.findings;
    previousSha = candidate.sha;
    result = { ...result, evidence: { ...result.evidence, changesRequestedBatches: result.evidence.changesRequestedBatches + 1 } };
    if (cycle >= input.contract.budget.maxReviewCycles || result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations) return services.authority.save(failedResult(result, "review changes requested after recovery budget was exhausted"));
  }
  return services.authority.save(failedResult(result, "review budget exhausted"));
}

export async function writeTaskResult(stateDirectory: string, result: TaskResult): Promise<void> {
  const path = resolve(stateDirectory, "results", `${result.taskId}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}
