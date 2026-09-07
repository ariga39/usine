import type {
  CampaignAssessment,
  CampaignAssessmentFact,
  CampaignAssessmentUsage,
  GoalContract,
  TaskProposal,
} from "@usine/task-authority";
import { taskProposalSchema } from "@usine/task-authority";
import {
  CodexCodingSession,
  codingSessionAdapterSelectionEnvironment,
  explicitWorkerEnvironment,
  type CampaignReplacementPlannerSessionRequest,
} from "@usine/coding-session";
import { z } from "zod";
import { sessionArchiveOptionsFromEnvironment } from "./runtime-policy.js";

export interface CampaignReplacementRepository {
  readonly id: string;
  readonly path: string;
  readonly owner: string;
  readonly name: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly reviewerProfile: string;
}

export interface CampaignReplacementRequest {
  readonly invocationId: string;
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly goal: GoalContract;
  readonly outcome: GoalContract["outcomes"][number];
  readonly assessment: CampaignAssessment;
  readonly evidenceHash: string;
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly priorProposals: readonly TaskProposal[];
  readonly repositories: readonly CampaignReplacementRepository[];
  readonly remainingBudget: {
    readonly tasks: number;
    readonly implementerActivations: number;
    readonly reviewCycles: number;
    readonly elapsedMs: number;
  };
  readonly deadlineEpochMs: number;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CampaignReplacementDraft {
  /** Untrusted output; the Campaign coordinator must parse and authorize it. */
  readonly proposal: unknown;
  readonly usage: CampaignAssessmentUsage | null;
}

export type CampaignReplacementGenerator = (
  request: CampaignReplacementRequest,
) => Promise<CampaignReplacementDraft>;

function usageFrom(
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    uncachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  } | null,
): CampaignAssessmentUsage | null {
  return usage === null
    ? null
    : {
        inputTokens: usage.inputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        uncachedInputTokens: usage.uncachedInputTokens ?? null,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        reasoningOutputTokens: usage.reasoningOutputTokens ?? null,
      };
}

/** Compose the one concrete replacement-planner role used by the runtime. */
export function createCampaignReplacementGenerator(): CampaignReplacementGenerator {
  return async (request) => {
    const repository = request.repositories[0];
    if (!repository) return { proposal: null, usage: null };
    const session = new CodexCodingSession(undefined, {
      environment: explicitWorkerEnvironment(request.environment),
      adapterSelectionEnvironment: codingSessionAdapterSelectionEnvironment(request.environment),
      openCode2StateDirectory: request.environment.USINE_STATE_DIR,
      sessionArchive: sessionArchiveOptionsFromEnvironment(
        request.environment,
        request.environment.USINE_STATE_DIR ?? ".",
      ),
    });
    const prompt = [
      "Propose at most one focused replacement Task Proposal for the persisted Outcome gaps.",
      "Return null when no bounded proposal can address the gaps within the supplied remaining budget.",
      "Use only the immutable Goal, Outcome, assessment, evidence, prior proposal ownership, Repository facts, and remaining budgets.",
      "Do not propose a new Outcome, authority, effect, Repository, or budget.",
      JSON.stringify({
        goal: request.goal,
        outcome: request.outcome,
        assessment: request.assessment,
        evidence: request.evidence,
        priorProposals: request.priorProposals,
        repositories: request.repositories.map(
          ({ reviewerProfile: _reviewerProfile, path: _path, ...facts }) => facts,
        ),
        remainingBudget: request.remainingBudget,
      }),
    ].join("\n");
    const plannerRequest: CampaignReplacementPlannerSessionRequest = {
      role: "replacement-planner",
      attempt: request.invocationId,
      workspace: repository.path,
      replacement: {
        invocationId: request.invocationId,
        campaignId: request.campaignId,
        goalId: request.goalId,
        goalVersion: request.goalVersion,
        goal: {
          id: request.goal.id,
          version: request.goal.version,
          objective: request.goal.objective,
          authority: request.goal.authority,
          budget: request.goal.budget,
        },
        outcome: {
          id: request.outcome.id,
          title: request.outcome.title,
          acceptance: request.outcome.acceptance,
        },
        assessment: {
          assessmentId: request.assessment.assessmentId,
          evidenceHash: request.assessment.evidenceHash,
          verdict: "gaps",
          summary: request.assessment.summary,
          gaps: request.assessment.gaps,
          evidence: request.assessment.evidence,
        },
        evidence: request.evidence,
        priorProposals: request.priorProposals.map((proposal) => ({
          proposalId: proposal.proposalId,
          outcomeId: proposal.outcomeId,
          repositoryId: proposal.repositoryId,
          instructions: proposal.instructions,
          acceptance: proposal.acceptance,
          effects: proposal.effects,
          merge: proposal.merge,
        })),
        repositories: request.repositories.map(
          ({ reviewerProfile: _reviewerProfile, path: _path, ...facts }) => facts,
        ),
        remainingBudget: request.remainingBudget,
      },
      prompt,
      profile: repository.reviewerProfile,
      sandbox: "read-only",
      deadlineEpochMs: request.deadlineEpochMs,
      outputSchema: z.union([taskProposalSchema, z.null()]),
      environment: request.environment,
    };
    try {
      const result = await session.run(plannerRequest);
      return {
        proposal: result.status === "completed" ? (result.output ?? null) : null,
        usage: usageFrom(result.usage),
      };
    } catch {
      return { proposal: null, usage: null };
    }
  };
}
