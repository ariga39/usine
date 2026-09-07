import { z } from "zod";
import {
  CodexCodingSession,
  codingSessionAdapterSelectionEnvironment,
  explicitWorkerEnvironment,
  type CampaignAssessorSessionRequest,
} from "@usine/coding-session";
import type {
  CampaignAssessmentEvidence,
  CampaignAssessmentFact,
  CampaignAssessmentUsage,
  GoalContract,
} from "@usine/task-authority";
import { sessionArchiveOptionsFromEnvironment } from "./runtime-policy.js";

export interface CampaignAssessorRepository {
  readonly id: string;
  readonly path: string;
  readonly reviewerProfile: string;
  readonly baseSha: string;
}

export interface CampaignAssessmentRequest {
  readonly invocationId: string;
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly goal: GoalContract;
  readonly outcome: GoalContract["outcomes"][number];
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly repositories: readonly CampaignAssessorRepository[];
  readonly deadlineEpochMs: number;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CampaignAssessmentDraft {
  readonly verdict: "satisfied" | "gaps" | "inconclusive";
  readonly summary: string;
  readonly gaps: readonly string[];
  readonly evidence: readonly CampaignAssessmentEvidence[];
  readonly usage: CampaignAssessmentUsage | null;
}

export type CampaignOutcomeAssessor = (
  request: CampaignAssessmentRequest,
) => Promise<CampaignAssessmentDraft>;

const assessmentOutputSchema = z
  .object({
    verdict: z.enum(["satisfied", "gaps", "inconclusive"]),
    summary: z.string().min(1).max(2000),
    gaps: z.array(z.string().min(1).max(1000)).max(32),
    evidence: z
      .array(
        z.object({
          criterionIndex: z.number().int().nonnegative(),
          repositoryId: z.string().min(1),
          proposalId: z.string().min(1),
          taskId: z.string().min(1),
          fact: z.enum(["candidate", "check", "review", "delivery"]),
          status: z.string().min(1),
          sha: z.string().regex(/^[0-9a-f]{40}$/),
        }),
      )
      .max(128),
  })
  .strict();

function emptyUsage(): CampaignAssessmentUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  };
}

function usageFrom(
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    uncachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  } | null,
): CampaignAssessmentUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    uncachedInputTokens: usage?.uncachedInputTokens ?? null,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
  };
}

function inconclusive(summary: string, usage: CampaignAssessmentUsage | null = emptyUsage()) {
  return { verdict: "inconclusive" as const, summary, gaps: [], evidence: [], usage };
}

/**
 * Compose the default assessor from the existing provider-neutral Coding Session
 * port. The session is read-only and receives only the immutable Outcome plus a
 * bounded projection of exact-SHA facts; its response is never lifecycle authority.
 */
export function createCampaignOutcomeAssessor(): CampaignOutcomeAssessor {
  return async (request) => {
    const repository = request.repositories[0];
    if (!repository) return inconclusive("no readable Repository evidence is available");

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
      "Assess this Outcome using only the supplied evidence.",
      "Return satisfied only when every original acceptance criterion has a matching exact-SHA evidence reference.",
      "Return gaps for directionally incomplete evidence and inconclusive for unavailable or contradictory evidence.",
      "Do not claim facts that are absent from the evidence.",
      JSON.stringify({ outcome: request.outcome, evidence: request.evidence }),
    ].join("\n");
    try {
      const assessorRequest: CampaignAssessorSessionRequest<
        z.infer<typeof assessmentOutputSchema>
      > = {
        role: "assessor",
        attempt: request.invocationId,
        workspace: repository.path,
        assessment: {
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
          evidence: request.evidence,
        },
        prompt,
        profile: repository.reviewerProfile,
        sandbox: "read-only",
        deadlineEpochMs: request.deadlineEpochMs,
        outputSchema: assessmentOutputSchema,
        environment: request.environment,
      };
      const result = await session.run(assessorRequest);
      if (result.status !== "completed" || !result.output)
        return inconclusive(result.summary, usageFrom(result.usage));
      return { ...result.output, usage: usageFrom(result.usage) };
    } catch {
      return inconclusive("Campaign assessor was unavailable");
    }
  };
}
