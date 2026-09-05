import {
  acceptedTaskDelivery,
  campaignEvidencePageSchema,
  deriveUsageReport,
  MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
  openSqliteDatabase,
  TaskAuthority,
  type CampaignAcceptedDelivery,
  type CampaignEvidenceAggregate,
  type CampaignEvidencePage,
  type CampaignEvidencePageRequest,
  type CampaignEvidenceRun,
  type CampaignEvidenceSource,
  type CampaignEvidenceSourcesPage,
  type CampaignEvidenceTotals,
  type CampaignEvidenceTouch,
  type CampaignEvidenceUsage,
  type UsageInvocation,
} from "@usine/task-authority";
import { Schema } from "effect";
import { resolve } from "node:path";

export {
  CampaignEvidenceCursorError,
  MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
} from "@usine/task-authority";

export interface CampaignEvidenceRequest extends CampaignEvidencePageRequest {}

interface CampaignEvidenceSourceSet {
  readonly firstPage: CampaignEvidenceSourcesPage;
  readonly sources: readonly CampaignEvidenceSource[];
}

export async function lookupCampaignEvidence(
  stateDirectory: string,
  campaignId: string,
  request: CampaignEvidenceRequest = {
    cursor: null,
    limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
  },
): Promise<CampaignEvidencePage | null> {
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const authority = new TaskAuthority(handle.database);
    const requested = await authority.listCampaignEvidenceSources(campaignId, request);
    if (!requested) return null;
    const sourceSet = await loadAllSources(authority, campaignId, requested, request);
    const pageRuns = requested.sources.flatMap((source) => usageRuns(source));
    const allRuns = sourceSet.sources.flatMap((source) => usageRuns(source));
    const allTouches = touches(sourceSet.firstPage);
    const deliveries = requested.sources.flatMap((source) => acceptedDelivery(source.task));
    const report: CampaignEvidencePage = {
      schemaVersion: 1,
      campaignId: requested.campaign.campaignId,
      goalId: requested.campaign.goalId,
      goalVersion: requested.campaign.goalVersion,
      cursor: request.cursor,
      nextCursor: requested.nextCursor,
      coverage: coverageForRuns(pageRuns),
      runs: pageRuns,
      aggregates: aggregateRuns(pageRuns),
      totals: totals(sourceSet, allRuns, allTouches),
      touches: request.cursor === null ? allTouches : [],
      deliveries,
    };
    return Schema.decodeUnknownSync(campaignEvidencePageSchema)(report);
  } finally {
    handle.close();
  }
}

async function loadAllSources(
  authority: TaskAuthority,
  campaignId: string,
  requested: CampaignEvidenceSourcesPage,
  request: CampaignEvidenceRequest,
): Promise<CampaignEvidenceSourceSet> {
  const firstPage =
    request.cursor === null
      ? requested
      : ((await authority.listCampaignEvidenceSources(campaignId, {
          cursor: null,
          limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
        })) ?? requested);
  const sources = [...firstPage.sources];
  let cursor = firstPage.nextCursor;
  while (cursor !== null) {
    const page = await authority.listCampaignEvidenceSources(campaignId, {
      cursor,
      limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
    });
    if (!page) break;
    sources.push(...page.sources);
    cursor = page.nextCursor;
  }
  return { firstPage, sources };
}

function usageRuns(source: CampaignEvidenceSource): CampaignEvidenceRun[] {
  return deriveUsageReport([source], scope()).invocations.map((run) => projectRun(run, source));
}

function projectRun(run: UsageInvocation, source: CampaignEvidenceSource): CampaignEvidenceRun {
  const association = source.task.campaign;
  if (!association) throw new Error("Campaign evidence source has no Campaign association");
  return {
    invocationId: run.invocationId,
    goalVersion: association.goalVersion,
    outcomeId: association.outcomeId,
    taskId: run.taskId,
    pullRequest: run.pullRequest,
    repositoryId: run.repositoryId,
    repository: run.repository,
    role: run.role,
    activation: run.activation,
    reviewCycle: run.reviewCycle,
    provider: run.provider,
    adapter: run.adapter,
    model: run.model,
    outcome: run.outcome,
    occurredAtEpochMs: run.occurredAtEpochMs,
    elapsedMs: run.elapsedMs,
    usage: run.usage,
  };
}

function scope() {
  return { taskId: null, repositoryId: null, fromEpochMs: null, toEpochMs: null } as const;
}

function touches(source: CampaignEvidenceSourcesPage): CampaignEvidenceTouch[] {
  const planTouches: CampaignEvidenceTouch[] = [
    {
      touchId: `plan:${source.campaign.campaignId}`,
      goalVersion: source.campaign.goalVersion,
      type: "plan",
      occurredAtEpochMs: source.campaign.publishedAtEpochMs,
    },
    ...source.proposals
      .toSorted((left, right) => left.sequence - right.sequence)
      .map((proposal) => ({
        touchId: `plan:${source.campaign.campaignId}:${proposal.proposalId}`,
        goalVersion: source.campaign.goalVersion,
        type: "plan" as const,
        occurredAtEpochMs: proposal.admittedAtEpochMs,
      })),
  ];
  return [...planTouches, ...source.decisionTouches];
}

function acceptedDelivery(task: CampaignEvidenceSource["task"]): CampaignAcceptedDelivery[] {
  const association = task.campaign;
  const accepted = acceptedTaskDelivery(task);
  if (!association || !accepted) return [];
  return [
    {
      taskId: task.taskId,
      goalVersion: association.goalVersion,
      outcomeId: association.outcomeId,
      effect: accepted.delivery.effect,
      pullRequest: accepted.delivery.prNumber,
      sha: accepted.delivery.sha,
      url: accepted.delivery.url,
      attestationId: accepted.delivery.attestationId,
      merged: accepted.mergedHeadSha !== null,
      mergeCommitSha: accepted.mergedHeadSha,
    },
  ];
}

function aggregateRuns(runs: readonly CampaignEvidenceRun[]): CampaignEvidenceAggregate[] {
  const groups = new Map<string, CampaignEvidenceRun[]>();
  for (const run of runs) {
    const key = [
      run.goalVersion,
      run.outcomeId,
      run.taskId,
      run.role,
      run.model,
      run.provider,
      run.adapter,
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      return {
        goalVersion: first.goalVersion,
        outcomeId: first.outcomeId,
        taskId: first.taskId,
        role: first.role,
        model: first.model,
        provider: first.provider,
        adapter: first.adapter,
        invocations: group.length,
        elapsedMs: sumNullable(group.map((run) => run.elapsedMs)),
        usage: sumUsage(group.map((run) => run.usage)),
      };
    })
    .toSorted((left, right) => compareStrings(aggregateSortKey(left), aggregateSortKey(right)));
}

function aggregateSortKey(aggregate: CampaignEvidenceAggregate): string {
  return [
    aggregate.goalVersion,
    aggregate.outcomeId,
    aggregate.taskId,
    aggregate.role,
    aggregate.model,
    aggregate.provider,
    aggregate.adapter,
  ].join("\u0000");
}

function totals(
  sourceSet: CampaignEvidenceSourceSet,
  runs: readonly CampaignEvidenceRun[],
  allTouches: readonly CampaignEvidenceTouch[],
): CampaignEvidenceTotals {
  const deliveries = sourceSet.sources.flatMap((source) => acceptedDelivery(source.task));
  return {
    invocations: runs.length,
    elapsedMs: sumNullable(runs.map((run) => run.elapsedMs)),
    reviewCycles: sourceSet.sources.reduce(
      (total, source) => total + source.task.evidence.reviewCycles,
      0,
    ),
    repairBatches: sourceSet.sources.reduce(
      (total, source) => total + source.task.evidence.changesRequestedBatches,
      0,
    ),
    blockedProposals: sourceSet.firstPage.proposals.filter(
      (proposal) => proposal.status === "blocked",
    ).length,
    guardianTouches: allTouches.length,
    acceptedDeliveries: deliveries.length,
    usage: sumUsage(runs.map((run) => run.usage)),
  };
}

function sumNullable(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function sumUsage(values: readonly CampaignEvidenceUsage[]): CampaignEvidenceUsage {
  const sum = (name: keyof Omit<CampaignEvidenceUsage, "coverage">): number | null => {
    const selected = values.map((value) => value[name]);
    if (selected.some((value) => value === null)) return null;
    return selected.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  const coverage =
    values.length === 0
      ? "unavailable"
      : values.every((value) => value.coverage === "unavailable")
        ? "unavailable"
        : values.every((value) => value.coverage === "complete")
          ? "complete"
          : "partial";
  return {
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    uncachedInputTokens: sum("uncachedInputTokens"),
    cacheWriteInputTokens: sum("cacheWriteInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningOutputTokens: sum("reasoningOutputTokens"),
    coverage,
  };
}

function coverageForRuns(runs: readonly CampaignEvidenceRun[]): CampaignEvidencePage["coverage"] {
  if (runs.length === 0) return "unavailable";
  if (runs.every((run) => run.usage.coverage === "unavailable")) return "unavailable";
  return runs.every((run) => run.usage.coverage === "complete") ? "complete" : "partial";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
