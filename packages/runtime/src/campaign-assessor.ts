import { z } from "zod";
import {
  CodexCodingSession,
  serializeRoleContext,
  codingSessionAdapterSelectionEnvironment,
  explicitWorkerEnvironment,
  type CampaignAssessorSessionRequest,
  type ProviderNeutralUsageCompleteness,
} from "@usine/coding-session";
import type {
  CampaignAssessmentEvidence,
  CampaignAssessmentFact,
  CampaignAssessmentUsage,
  GoalContract,
  TextAcceptanceOutcome,
} from "@usine/task-authority";
import { sessionArchiveOptionsFromEnvironment } from "./runtime-policy.js";
import { orderedContextFacts } from "./campaign-role-context.js";
import {
  campaignUsageCoverage,
  campaignModelRunFromObservation,
  type CampaignModelRunDraft,
} from "./campaign-model-run.js";
import {
  campaignAssessmentFactId,
  type CampaignAssessmentReference,
} from "./campaign-assessment-reference.js";

export interface CampaignAssessorRepository {
  readonly id: string;
  readonly path: string;
  readonly owner: string;
  readonly name: string;
  readonly reviewerProfile: string;
  readonly baseSha: string;
}

export interface CampaignAssessmentRequest {
  readonly invocationId: string;
  readonly campaignId: string;
  readonly goalId: string;
  readonly goalVersion: number;
  readonly goal: GoalContract;
  /** Display text and criterion metadata projected from the owning Outcome. */
  readonly outcome: Omit<GoalContract["outcomes"][number], "acceptance"> & TextAcceptanceOutcome;
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly repositories: readonly CampaignAssessorRepository[];
  readonly environment: NodeJS.ProcessEnv;
  /** Durable diagnostic supplied when a prior report omitted source references. */
  readonly reportRecovery?: string;
  readonly signal?: AbortSignal;
}

export interface CampaignAssessmentDraft {
  readonly verdict: "satisfied" | "gaps" | "inconclusive";
  readonly summary: string;
  readonly gaps: readonly string[];
  readonly evidence: readonly (CampaignAssessmentEvidence | CampaignAssessmentReference)[];
  readonly usage: CampaignAssessmentUsage | null;
  readonly modelRuns?: readonly CampaignModelRunDraft[];
  readonly recoverable?: boolean;
}

export type CampaignOutcomeAssessor = (
  request: CampaignAssessmentRequest,
) => Promise<CampaignAssessmentDraft>;

const assessmentOutputSchema = z
  .object({
    verdict: z.enum(["satisfied", "gaps", "inconclusive"]),
    summary: z.string().min(1).max(2000),
    gaps: z.array(z.string().min(1).max(1000)).max(32),
    evidence: z.array(
      z.object({
        criterionIndex: z.number().int().nonnegative(),
        evidenceId: z.string().regex(/^fact-[0-9a-f]{64}$/),
      }),
    ),
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
    coverage: "unavailable",
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
  completeness?: ProviderNeutralUsageCompleteness,
): CampaignAssessmentUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    uncachedInputTokens: usage?.uncachedInputTokens ?? null,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
    coverage: usage === null ? "unavailable" : campaignUsageCoverage(usage, completeness),
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
    const startedAtEpochMs = Date.now();
    const repository = request.repositories[0];
    if (!repository) return inconclusive("no readable Repository evidence is available");

    const session = new CodexCodingSession(undefined, {
      environment: explicitWorkerEnvironment(request.environment),
      adapterSelectionEnvironment: codingSessionAdapterSelectionEnvironment(request.environment),
      codexPathOverride: request.environment.USINE_CODEX_PATH_OVERRIDE,
      openCode2StateDirectory: request.environment.USINE_STATE_DIR,
      sessionArchive: sessionArchiveOptionsFromEnvironment(
        request.environment,
        request.environment.USINE_STATE_DIR ?? ".",
      ),
    });
    const prompt = [
      "Assess this Outcome using only the supplied evidence.",
      "Return satisfied only when every mandatory acceptance criterion has a matching exact-SHA evidence reference.",
      "Optional criteria are nonblocking; do not invent a checker for a criterion without a selected checker.",
      "Reference the supplied evidence IDs without repeating complete fact bodies in the output.",
      "Return gaps for directionally incomplete evidence and inconclusive for unavailable or contradictory evidence.",
      "Do not claim facts that are absent from the evidence.",
      `Outcome requirements: ${serializeRoleContext(request.outcome)}`,
      `Exact evidence facts: ${serializeRoleContext(
        orderedContextFacts(request.evidence).map((fact) => ({
          evidenceId: campaignAssessmentFactId(fact),
          fact,
        })),
      )}`,
      ...(request.reportRecovery ? [`Report recovery diagnostic: ${request.reportRecovery}`] : []),
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
          },
          outcome: {
            id: request.outcome.id,
            title: request.outcome.title,
            acceptance: request.outcome.acceptance,
            criteria: request.outcome.criteria,
          },
          evidence: request.evidence,
        },
        prompt,
        profile: repository.reviewerProfile,
        sandbox: "read-only",
        outputSchema: assessmentOutputSchema,
        environment: request.environment,
        signal: request.signal,
      };
      const result = await session.run(assessorRequest);
      const modelRuns = campaignModelRunFromObservation(
        "assessor",
        repository,
        request.invocationId,
        startedAtEpochMs,
        result,
      );
      if (result.status !== "completed" || !result.output)
        return {
          ...inconclusive(result.summary, usageFrom(result.usage, result.usageCompleteness)),
          modelRuns,
        };
      return {
        ...result.output,
        usage: usageFrom(result.usage, result.usageCompleteness),
        modelRuns,
      };
    } catch {
      return { ...inconclusive("Campaign assessor was unavailable"), recoverable: true };
    }
  };
}
