import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { Schema } from "effect";
import { decodeTaskIdCursor, encodeTaskIdCursor, type TaskIdCursor } from "./task-id-cursor.js";
import {
  CampaignEvidenceCursorError,
  MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
  type CampaignEvidenceCampaign,
  type CampaignEvidenceRun,
  type CampaignEvidenceDecisionTouch,
  type CampaignEvidencePageRequest,
  type CampaignEvidenceProposal,
  type CampaignEvidenceSource,
  type CampaignEvidenceSourcesPage,
} from "./campaign-evidence.js";
import {
  campaigns,
  campaignModelRuns,
  campaignProposals,
  campaignTouches,
  taskEvents,
  taskRuns,
} from "./schema.js";
import {
  campaignAssessmentUsageSchema,
  decodeCampaignProposalStatus,
} from "./campaign-contract.js";
import { taskFailureClassFromProvider } from "./task-state.js";
import { decodeRawPersistedTaskResult, isTaskStateQuarantinedError } from "./task-state-schema.js";
import { decodeTaskEvent } from "./task-event.js";
import type { RuntimeDatabase } from "./sqlite-database.js";
import type { TaskEvent } from "./task-event.js";

const CAMPAIGN_EVIDENCE_CURSOR_SCOPE = "campaign-evidence" as const;
const CAMPAIGN_EVIDENCE_CURSOR_LENGTH = 4096;

export async function listCampaignEvidenceSources(
  database: RuntimeDatabase,
  campaignId: string,
  request: CampaignEvidencePageRequest = {
    cursor: null,
    limit: MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE,
  },
): Promise<CampaignEvidenceSourcesPage | null> {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_CAMPAIGN_EVIDENCE_PAGE_SIZE
  )
    throw new RangeError("campaign evidence page limit is out of range");

  const campaignRow = await database.query.campaigns.findFirst({
    where: eq(campaigns.campaignId, campaignId),
  });
  if (!campaignRow) return null;

  const cursor =
    request.cursor === null ? null : decodeCampaignEvidenceCursor(request.cursor, campaignId);
  const proposalRows = await database
    .select()
    .from(campaignProposals)
    .where(eq(campaignProposals.campaignId, campaignId))
    .orderBy(asc(campaignProposals.sequence));
  const decisionRows = await database
    .select()
    .from(campaignTouches)
    .where(eq(campaignTouches.campaignId, campaignId))
    .orderBy(asc(campaignTouches.occurredAtEpochMs), asc(campaignTouches.touchId));
  const taskPage = await readCampaignTaskPage(database, campaignRow, cursor, request.limit);
  const modelRunRows =
    request.cursor === null
      ? await database
          .select()
          .from(campaignModelRuns)
          .where(eq(campaignModelRuns.campaignId, campaignId))
          .orderBy(asc(campaignModelRuns.invocationId))
      : [];
  const tasks = new Map(taskPage.tasks.map((task) => [task.taskId, task]));
  const selectedTaskIds = [...tasks.keys()];
  const eventsByTask = new Map<string, TaskEvent[]>();
  if (selectedTaskIds.length > 0) {
    const eventRows = await database
      .select()
      .from(taskEvents)
      .where(inArray(taskEvents.taskId, selectedTaskIds))
      .orderBy(asc(taskEvents.taskId), asc(taskEvents.sequence));
    for (const row of eventRows) {
      const events = eventsByTask.get(row.taskId) ?? [];
      events.push(decodeTaskEvent(row));
      eventsByTask.set(row.taskId, events);
    }
  }

  const campaign: CampaignEvidenceCampaign = {
    campaignId: campaignRow.campaignId,
    goalId: campaignRow.goalId,
    goalVersion: campaignRow.goalVersion,
    publishedAtEpochMs: campaignRow.createdAt.getTime(),
    revision: campaignRow.revision,
    updatedAtEpochMs: campaignRow.updatedAt.getTime(),
  };
  const proposals: CampaignEvidenceProposal[] = proposalRows.map((row) => ({
    proposalId: row.proposalId,
    sequence: row.sequence,
    outcomeId: row.outcomeId,
    status: decodeCampaignProposalStatus(row.status),
    blocker: row.blocker,
    taskId: row.taskId,
    admittedAtEpochMs: row.createdAt.getTime(),
    ...(row.supersededByProposalId ? { supersededByProposalId: row.supersededByProposalId } : {}),
    ...(row.supersedesProposalId ? { supersedesProposalId: row.supersedesProposalId } : {}),
    ...(row.replacementAssessmentId && row.replacementEvidenceHash
      ? {
          replacement: {
            assessmentId: row.replacementAssessmentId,
            evidenceHash: row.replacementEvidenceHash,
          },
        }
      : {}),
  }));
  const decisionTouches: CampaignEvidenceDecisionTouch[] = decisionRows.flatMap((row) =>
    row.type === "decision" || row.type === "warning"
      ? [
          {
            touchId: row.touchId,
            goalVersion: row.goalVersion,
            type: row.type,
            occurredAtEpochMs: row.occurredAtEpochMs,
          },
        ]
      : [],
  );
  const sources: CampaignEvidenceSource[] = selectedTaskIds.flatMap((taskId) => {
    const task = tasks.get(taskId);
    return task ? [{ task, events: eventsByTask.get(taskId) ?? [] }] : [];
  });
  const campaignRuns: CampaignEvidenceRun[] = modelRunRows.flatMap((row) => {
    if (row.status === "pending") return [];
    const outcome =
      row.status === "cancelled"
        ? "cancelled"
        : row.status === "completed" || row.status === "succeeded"
          ? "succeeded"
          : "failed";
    let usage: Schema.Schema.Type<typeof campaignAssessmentUsageSchema> | null = null;
    try {
      usage = row.usage ? Schema.decodeUnknownSync(campaignAssessmentUsageSchema)(row.usage) : null;
    } catch {
      usage = null;
    }
    return [
      {
        invocationId: row.invocationId,
        goalVersion: campaignRow.goalVersion,
        outcomeId: row.outcomeId,
        taskId: null,
        pullRequest: null,
        repositoryId: row.repositoryId ?? "unavailable",
        repository: row.repository ?? "unavailable",
        role: row.role === "assessor" ? ("assessor" as const) : ("replacement-planner" as const),
        activation: null,
        reviewCycle: null,
        configuredProvider: row.configuredProvider ?? "unavailable",
        configuredModel: row.configuredModel ?? "unavailable",
        actualModel: row.actualModel ?? "unavailable",
        actualProvider: row.actualProvider ?? "unavailable",
        provider: row.actualProvider ?? "unavailable",
        adapter: row.adapter ?? "unavailable",
        model: row.actualModel ?? "unavailable",
        profile: row.profile ?? "unavailable",
        serviceTier: row.serviceTier ?? "unavailable",
        reasoningEffort: row.reasoningEffort ?? "unavailable",
        outcome,
        failureClass: row.failureClass ? taskFailureClassFromProvider(row.failureClass) : null,
        occurredAtEpochMs: row.completedAtEpochMs ?? row.startedAtEpochMs,
        elapsedMs: row.elapsedMs,
        usage: {
          inputTokens: usage?.inputTokens ?? null,
          cachedInputTokens: usage?.cachedInputTokens ?? null,
          uncachedInputTokens: usage?.uncachedInputTokens ?? null,
          cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
          coverage:
            usage?.coverage ??
            (usage === null
              ? ("unavailable" as const)
              : [
                    usage.inputTokens,
                    usage.cachedInputTokens,
                    usage.uncachedInputTokens,
                    usage.outputTokens,
                  ].every((value) => value !== null)
                ? ("complete" as const)
                : ("partial" as const)),
        },
      },
    ];
  });
  return {
    campaign,
    proposals,
    decisionTouches,
    sources,
    campaignRuns,
    cursor: request.cursor,
    nextCursor:
      taskPage.nextCursor === null
        ? null
        : encodeCampaignEvidenceCursor(taskPage.nextCursor, campaignId),
  };
}

async function readCampaignTaskPage(
  database: RuntimeDatabase,
  campaign: typeof campaigns.$inferSelect,
  cursor: CampaignEvidenceCursor | null,
  limit: number,
) {
  const safeJson = sql`CASE WHEN json_valid(${taskRuns.result}) THEN ${taskRuns.result} ELSE '{}' END`;
  const association = and(
    sql`json_extract(${safeJson}, '$.campaign.campaignId') = ${campaign.campaignId}`,
    sql`json_extract(${safeJson}, '$.campaign.goalId') = ${campaign.goalId}`,
    sql`json_extract(${safeJson}, '$.campaign.goalVersion') = ${campaign.goalVersion}`,
  );
  const decode = (rawResult: string) => {
    try {
      const task = decodeRawPersistedTaskResult(rawResult);
      return task.campaign?.campaignId === campaign.campaignId &&
        task.campaign.goalId === campaign.goalId &&
        task.campaign.goalVersion === campaign.goalVersion
        ? task
        : null;
    } catch (error) {
      if (!isTaskStateQuarantinedError(error)) throw error;
      return null;
    }
  };
  const read = async (
    after: string | null,
    upper: string | null,
    count: number,
    descending = false,
  ) => {
    const tasks: ReturnType<typeof decodeRawPersistedTaskResult>[] = [];
    let boundary = after;
    while (tasks.length < count) {
      const rows = await database
        .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
        .from(taskRuns)
        .where(
          and(
            association,
            upper === null ? undefined : lte(taskRuns.taskId, upper),
            boundary === null
              ? undefined
              : descending
                ? lt(taskRuns.taskId, boundary)
                : gt(taskRuns.taskId, boundary),
          ),
        )
        .orderBy(descending ? desc(taskRuns.taskId) : asc(taskRuns.taskId))
        .limit(count - tasks.length);
      if (rows.length === 0) break;
      for (const row of rows) {
        const task = decode(row.rawResult);
        if (task !== null) tasks.push(task);
      }
      boundary = rows.at(-1)!.taskId;
    }
    return tasks;
  };

  if (cursor !== null) {
    const rows = await database
      .select({ rawResult: sql<string>`${taskRuns.result}` })
      .from(taskRuns)
      .where(and(association, inArray(taskRuns.taskId, [cursor.upperTaskId, cursor.afterTaskId])));
    const validIds = new Set(
      rows.flatMap((row) => {
        const task = decode(row.rawResult);
        return task === null ? [] : [task.taskId];
      }),
    );
    if (!validIds.has(cursor.upperTaskId) || !validIds.has(cursor.afterTaskId))
      throw new CampaignEvidenceCursorError();
  }
  const upperTaskId = cursor?.upperTaskId ?? (await read(null, null, 1, true))[0]?.taskId ?? null;
  const selected =
    upperTaskId === null ? [] : await read(cursor?.afterTaskId ?? null, upperTaskId, limit + 1);
  const tasks = selected.slice(0, limit);
  const last = tasks.at(-1);
  const nextCursor: CampaignEvidenceCursor | null =
    selected.length > limit && last && upperTaskId !== null
      ? {
          version: 1,
          scope: `${CAMPAIGN_EVIDENCE_CURSOR_SCOPE}:${campaign.campaignId}`,
          upperTaskId,
          afterTaskId: last.taskId,
        }
      : null;
  return { tasks, nextCursor };
}

type CampaignEvidenceCursor = TaskIdCursor<string>;

function encodeCampaignEvidenceCursor(cursor: CampaignEvidenceCursor, campaignId: string): string {
  return encodeTaskIdCursor({
    ...cursor,
    scope: `${CAMPAIGN_EVIDENCE_CURSOR_SCOPE}:${campaignId}`,
  });
}

function decodeCampaignEvidenceCursor(value: string, campaignId: string): CampaignEvidenceCursor {
  try {
    if (value.length === 0 || value.length > CAMPAIGN_EVIDENCE_CURSOR_LENGTH) throw new Error();
    return decodeTaskIdCursor(value, `${CAMPAIGN_EVIDENCE_CURSOR_SCOPE}:${campaignId}`);
  } catch {
    throw new CampaignEvidenceCursorError();
  }
}
