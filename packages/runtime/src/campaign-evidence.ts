import { asc, eq, sql } from "drizzle-orm";
import {
  campaignEvidencePageSchema,
  campaignProposals,
  campaignTouches,
  campaigns,
  decodeRawPersistedTaskResult,
  deriveUsageReport,
  openSqliteDatabase,
  isTaskStateQuarantinedError,
  taskEvents,
  taskRuns,
  decodeTaskEvent,
  type CampaignAcceptedDelivery,
  type CampaignEvidenceAggregate,
  type CampaignEvidencePage,
  type CampaignEvidenceRun,
  type CampaignEvidenceTotals,
  type CampaignEvidenceTouch,
  type CampaignEvidenceUsage,
  type TaskEvent,
  type TaskResult,
  type UsageInvocation,
  type UsageReportSource,
} from "@usine/task-authority";
import { Schema } from "effect";
import { resolve } from "node:path";

const MAX_PAGE_SIZE = 200;
const EXACT_SHA = /^[0-9a-f]{40}$/;
const CURSOR = Schema.Struct({
  version: Schema.Literal(1),
  campaignId: Schema.String,
  afterTaskId: Schema.String,
});

export interface CampaignEvidenceRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export class CampaignEvidenceCursorError extends Error {
  constructor() {
    super("campaign evidence cursor is invalid");
    this.name = "CampaignEvidenceCursorError";
  }
}

interface CampaignSource {
  readonly campaign: typeof campaigns.$inferSelect;
  readonly proposals: readonly (typeof campaignProposals.$inferSelect)[];
  readonly touches: readonly CampaignEvidenceTouch[];
  readonly sources: readonly UsageReportSource[];
}

export async function lookupCampaignEvidence(
  stateDirectory: string,
  campaignId: string,
  request: CampaignEvidenceRequest = { cursor: null, limit: MAX_PAGE_SIZE },
): Promise<CampaignEvidencePage | null> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_PAGE_SIZE)
    throw new RangeError("campaign evidence page limit is out of range");
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"), { readOnly: true });
  try {
    const campaign = await handle.database.query.campaigns.findFirst({
      where: eq(campaigns.campaignId, campaignId),
    });
    if (!campaign) return null;
    const cursor = decodeCursor(request.cursor, campaignId);
    const source = await loadCampaignSource(handle.database, campaign);
    const allRuns = source.sources.flatMap((item) =>
      deriveUsageReport([item], scope()).invocations.map((run) => projectRun(run, item.task)),
    );
    const sortedRuns = allRuns.toSorted(
      (left, right) =>
        left.taskId.localeCompare(right.taskId) ||
        left.invocationId.localeCompare(right.invocationId),
    );
    const taskIds = source.sources.map((item) => item.task.taskId).toSorted();
    const pageTaskIds = taskIds
      .filter((taskId) => cursor === null || taskId > cursor.afterTaskId)
      .slice(0, request.limit);
    const pageTaskSet = new Set(pageTaskIds);
    const runs = sortedRuns.filter((run) => pageTaskSet.has(run.taskId));
    const aggregates = aggregateRuns(runs);
    const nextTaskId = pageTaskIds.at(-1);
    const nextCursor =
      nextTaskId !== undefined &&
      pageTaskIds.length < taskIds.filter((id) => cursor === null || id > cursor.afterTaskId).length
        ? encodeCursor({ version: 1, campaignId, afterTaskId: nextTaskId })
        : null;
    const deliveries = source.sources
      .filter((item) => pageTaskSet.has(item.task.taskId))
      .flatMap((item) => acceptedDelivery(item.task));
    const firstPage = cursor === null;
    const report: CampaignEvidencePage = {
      schemaVersion: 1,
      campaignId,
      goalId: campaign.goalId,
      goalVersion: campaign.goalVersion,
      cursor: request.cursor,
      nextCursor,
      coverage: coverage(runs),
      runs,
      aggregates,
      totals: totals(source, allRuns),
      touches: firstPage ? source.touches : [],
      deliveries,
    };
    return Schema.decodeUnknownSync(campaignEvidencePageSchema)(report);
  } finally {
    handle.close();
  }
}

function projectRun(run: UsageInvocation, task: TaskResult): CampaignEvidenceRun {
  const association = task.campaign;
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

async function loadCampaignSource(
  database: ReturnType<typeof openSqliteDatabase>["database"],
  campaign: typeof campaigns.$inferSelect,
): Promise<CampaignSource> {
  const proposalRows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaign.campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const touchRows = await database
    .select()
    .from(campaignTouches)
    .where(eq(campaignTouches.campaignId, campaign.campaignId))
    .orderBy(asc(campaignTouches.occurredAtEpochMs), asc(campaignTouches.touchId));
  const taskRows = await database
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .orderBy(asc(taskRuns.taskId));
  const sources: UsageReportSource[] = [];
  for (const row of taskRows) {
    const resultRows = await database
      .select({ rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, row.taskId));
    let result: TaskResult | null = null;
    if (resultRows[0]) {
      try {
        result = decodeRawPersistedTaskResult(resultRows[0].rawResult);
      } catch (error) {
        if (!isTaskStateQuarantinedError(error)) throw error;
      }
    }
    if (!belongsToCampaign(result, campaign)) continue;
    const eventRows = await database
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, row.taskId))
      .orderBy(asc(taskEvents.sequence));
    sources.push({ task: result, events: eventRows.map(decodeTaskEventRow) });
  }
  return {
    campaign,
    proposals: proposalRows,
    touches: touchRows.flatMap((touch) =>
      touch.type === "plan" || touch.type === "decision"
        ? [
            {
              touchId: touch.touchId,
              goalVersion: touch.goalVersion,
              type: touch.type,
              occurredAtEpochMs: touch.occurredAtEpochMs,
            },
          ]
        : [],
    ),
    sources,
  };
}

function decodeTaskEventRow(row: typeof taskEvents.$inferSelect): TaskEvent {
  return decodeTaskEvent({
    taskId: row.taskId,
    sequence: row.sequence,
    eventId: row.eventId,
    occurredAtEpochMs: row.occurredAtEpochMs,
    data: row.data,
  });
}

function belongsToCampaign(
  task: TaskResult | null,
  campaign: typeof campaigns.$inferSelect,
): task is TaskResult & { campaign: NonNullable<TaskResult["campaign"]> } {
  return (
    task?.campaign?.campaignId === campaign.campaignId &&
    task.campaign.goalId === campaign.goalId &&
    task.campaign.goalVersion === campaign.goalVersion
  );
}

function acceptedDelivery(task: TaskResult): CampaignAcceptedDelivery[] {
  const association = task.campaign;
  const delivery = task.delivery;
  if (
    !association ||
    !task.candidateSha ||
    !EXACT_SHA.test(task.candidateSha) ||
    !task.check ||
    task.check.status !== "passed" ||
    task.check.sha !== task.candidateSha ||
    !task.review ||
    task.review.verdict !== "approved" ||
    task.review.sha !== task.candidateSha ||
    !delivery ||
    delivery.sha !== task.candidateSha ||
    !EXACT_SHA.test(delivery.sha)
  )
    return [];
  const merge = delivery.merge ?? null;
  if (
    task.mergeAuthorized &&
    (task.state !== "merged" ||
      !merge ||
      merge.approvedHeadSha !== delivery.sha ||
      merge.prNumber !== delivery.prNumber ||
      !EXACT_SHA.test(merge.mergeCommitSha))
  )
    return [];
  if (!task.mergeAuthorized && (task.state !== "reviewed_pr" || merge !== null)) return [];
  return [
    {
      taskId: task.taskId,
      goalVersion: association.goalVersion,
      outcomeId: association.outcomeId,
      effect: delivery.effect,
      pullRequest: delivery.prNumber,
      sha: delivery.sha,
      url: delivery.url,
      attestationId: delivery.attestationId,
      merged: task.mergeAuthorized,
      mergeCommitSha: merge?.mergeCommitSha ?? null,
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
    .toSorted((left, right) =>
      [
        left.goalVersion,
        left.outcomeId,
        left.taskId,
        left.role,
        left.model,
        left.provider,
        left.adapter,
      ]
        .join("\u0000")
        .localeCompare(
          [
            right.goalVersion,
            right.outcomeId,
            right.taskId,
            right.role,
            right.model,
            right.provider,
            right.adapter,
          ].join("\u0000"),
        ),
    );
}

function totals(
  source: CampaignSource,
  runs: readonly CampaignEvidenceRun[],
): CampaignEvidenceTotals {
  const tasks = source.sources.map((item) => item.task);
  const deliveries = tasks.flatMap(acceptedDelivery);
  return {
    invocations: runs.length,
    elapsedMs: sumNullable(runs.map((run) => run.elapsedMs)),
    reviewCycles: tasks.reduce((total, task) => total + task.evidence.reviewCycles, 0),
    repairBatches: tasks.reduce((total, task) => total + task.evidence.changesRequestedBatches, 0),
    blockedProposals: source.proposals.filter((proposal) => proposal.status === "blocked").length,
    rejectedProposals: source.proposals.filter((proposal) => proposal.status === "rejected").length,
    guardianTouches: source.touches.length,
    acceptedDeliveries: deliveries.length,
    usage: sumUsage(runs.map((run) => run.usage)),
  };
}

function sumNullable(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

function sumUsage(values: readonly CampaignEvidenceUsage[]): CampaignEvidenceUsage {
  const sum = (name: keyof Omit<CampaignEvidenceUsage, "coverage">): number | null => {
    const selected = values.map((value) => value[name]);
    if (selected.some((value) => value === null)) return null;
    let total = 0;
    for (const value of selected) total += value ?? 0;
    return total;
  };
  const coverage =
    values.length === 0 || values.every((value) => value.coverage === "unavailable")
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

function coverage(runs: readonly CampaignEvidenceRun[]): CampaignEvidencePage["coverage"] {
  if (runs.length === 0 || runs.every((run) => run.usage.coverage === "unavailable"))
    return "unavailable";
  return runs.every((run) => run.usage.coverage === "complete") ? "complete" : "partial";
}

function encodeCursor(cursor: Schema.Schema.Type<typeof CURSOR>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string | null,
  campaignId: string,
): Schema.Schema.Type<typeof CURSOR> | null {
  if (value === null) return null;
  try {
    const decoded = Schema.decodeUnknownSync(CURSOR)(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (decoded.campaignId !== campaignId) throw new Error("wrong campaign");
    return decoded;
  } catch {
    throw new CampaignEvidenceCursorError();
  }
}
