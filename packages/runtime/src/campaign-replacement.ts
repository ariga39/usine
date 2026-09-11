import type {
  CampaignAssessment,
  CampaignAssessmentFact,
  CampaignAssessmentUsage,
  GoalContract,
  TaskProposal,
  TextAcceptanceOutcome,
} from "@usine/task-authority";
import { taskProposalSchema } from "@usine/task-authority";
import {
  CodexCodingSession,
  serializeRoleContext,
  codingSessionAdapterSelectionEnvironment,
  explicitWorkerEnvironment,
  type CampaignReplacementPlannerSessionRequest,
  type ProviderNeutralUsageCompleteness,
} from "@usine/coding-session";
import { acceptanceCriterionText } from "@usine/task-authority";
import { z } from "zod";
import { sessionArchiveOptionsFromEnvironment } from "./runtime-policy.js";
import { orderedContextFacts } from "./campaign-role-context.js";
import {
  campaignUsageCoverage,
  campaignModelRunFromObservation,
  type CampaignModelRunDraft,
} from "./campaign-model-run.js";

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
  /** Display text and criterion metadata projected from the owning Outcome. */
  readonly outcome: Omit<GoalContract["outcomes"][number], "acceptance"> & TextAcceptanceOutcome;
  readonly assessment: CampaignAssessment;
  readonly evidenceHash: string;
  readonly evidence: readonly CampaignAssessmentFact[];
  readonly priorProposals: readonly TaskProposal[];
  /** IDs of proposals that remain wholly unowned and may be revised at a checkpoint. */
  readonly supersedableProposalIds: readonly string[];
  readonly repositories: readonly CampaignReplacementRepository[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface CampaignReplacementDraft {
  /** Untrusted output; the Campaign coordinator must parse and authorize it. */
  readonly proposal: unknown;
  readonly usage: CampaignAssessmentUsage | null;
  readonly modelRuns?: readonly CampaignModelRunDraft[];
  /** The planner invocation could not produce a trustworthy result and may retry. */
  readonly recoverable?: boolean;
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
  completeness?: ProviderNeutralUsageCompleteness,
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
        coverage: campaignUsageCoverage(usage, completeness),
      };
}

/** Compose the one concrete replacement-planner role used by the runtime. */
export function createCampaignReplacementGenerator(): CampaignReplacementGenerator {
  return async (request) => {
    const startedAtEpochMs = Date.now();
    const repository = request.repositories[0];
    if (!repository) return { proposal: null, usage: null };
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
    const { warningThresholdMs: _warningThresholdMs, ...goal } = request.goal;
    const repositories = orderedContextFacts(
      request.repositories.map(
        ({ reviewerProfile: _reviewerProfile, path: _path, headSha: _headSha, ...facts }) => facts,
      ),
    );
    const prompt = [
      "Propose at most one focused replacement Task Proposal for the persisted Outcome gaps.",
      "Return null when no bounded proposal can address the persisted gaps.",
      "Use only the immutable Goal, Outcome, assessment, evidence, prior proposal ownership, and Repository facts.",
      "Do not propose a new Outcome, authority, effect, Repository, or budget.",
      "When revising a checkpoint proposal, include its exact supersedesProposalId in the returned proposal object.",
      `Planning context: ${serializeRoleContext({
        goal: {
          ...goal,
          authority: {
            ...goal.authority,
            repositories: goal.authority.repositories.toSorted(),
            effects: goal.authority.effects.toSorted(),
          },
        },
        outcome: request.outcome,
        priorProposals: request.priorProposals.map((proposal) => ({
          ...proposal,
          effects: proposal.effects.toSorted(),
        })),
        supersedableProposalIds: request.supersedableProposalIds.toSorted(),
        repositories,
      })}`,
      `Current assessment and evidence: ${serializeRoleContext({
        assessment: {
          assessmentId: request.assessment.assessmentId,
          evidenceHash: request.assessment.evidenceHash,
          verdict: request.assessment.verdict,
          summary: request.assessment.summary,
          gaps: request.assessment.gaps,
          evidence: orderedContextFacts(request.assessment.evidence),
        },
        evidence: orderedContextFacts(request.evidence),
        repositoryHeads: orderedContextFacts(
          request.repositories.map(({ id, headSha }) => ({ id, headSha })),
        ),
      })}`,
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
        },
        outcome: {
          id: request.outcome.id,
          title: request.outcome.title,
          acceptance: request.outcome.acceptance,
          criteria: request.outcome.criteria,
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
          acceptance: proposal.acceptance.map(acceptanceCriterionText),
          effects: proposal.effects,
          merge: proposal.merge,
        })),
        supersedableProposalIds: request.supersedableProposalIds,
        repositories: request.repositories.map(
          ({ reviewerProfile: _reviewerProfile, path: _path, ...facts }) => facts,
        ),
      },
      prompt,
      profile: repository.reviewerProfile,
      sandbox: "read-only",
      outputSchema: z.union([
        taskProposalSchema.extend({
          supersedesProposalId: z.string().min(1).max(128).optional(),
        }),
        z.null(),
      ]),
      environment: request.environment,
      signal: request.signal,
    };
    try {
      const result = await session.run(plannerRequest);
      const modelRun = campaignModelRunFromObservation(
        "replacement-planner",
        repository,
        request.invocationId,
        startedAtEpochMs,
        result,
      );
      return {
        proposal: result.status === "completed" ? (result.output ?? null) : null,
        usage: usageFrom(result.usage, result.usageCompleteness),
        modelRuns: modelRun,
        ...(result.status === "completed" ? {} : { recoverable: true }),
      };
    } catch {
      return { proposal: null, usage: null, recoverable: true };
    }
  };
}
