import { asc, eq, inArray, sql } from "drizzle-orm";
import { Schema } from "effect";
import {
  decodeTaskIdCursor,
  encodeTaskIdCursor,
  pageTaskIds,
  type TaskIdCursor,
} from "./task-id-cursor.js";
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
  const taskRows = await database
    .select({ taskId: taskRuns.taskId, rawResult: sql<string>`${taskRuns.result}` })
    .from(taskRuns)
    .orderBy(asc(taskRuns.taskId));
  const modelRunRows =
    request.cursor === null
      ? await database
          .select()
          .from(campaignModelRuns)
          .where(eq(campaignModelRuns.campaignId, campaignId))
          .orderBy(asc(campaignModelRuns.invocationId))
      : [];
  const tasks = new Map<string, ReturnType<typeof decodeRawPersistedTaskResult>>();
  for (const row of taskRows) {
    try {
      const task = decodeRawPersistedTaskResult(row.rawResult);
      if (
        task.campaign?.campaignId === campaignId &&
        task.campaign.goalId === campaignRow.goalId &&
        task.campaign.goalVersion === campaignRow.goalVersion
      )
        tasks.set(task.taskId, task);
    } catch (error) {
      if (!isTaskStateQuarantinedError(error)) throw error;
    }
  }

  const taskIds = [...tasks.keys()].toSorted();
  const page = pageTaskIds(
    taskIds,
    cursor,
    request.limit,
    `${CAMPAIGN_EVIDENCE_CURSOR_SCOPE}:${campaignId}`,
  );
  const selectedTaskIds = page.taskIds;
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
    row.type === "decision"
      ? [
          {
            touchId: row.touchId,
            goalVersion: row.goalVersion,
            type: "decision" as const,
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
            usage === null
              ? ("unavailable" as const)
              : [
                    usage.inputTokens,
                    usage.cachedInputTokens,
                    usage.uncachedInputTokens,
                    usage.outputTokens,
                  ].every((value) => value !== null)
                ? ("complete" as const)
                : ("partial" as const),
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
      page.nextCursor === null ? null : encodeCampaignEvidenceCursor(page.nextCursor, campaignId),
  };
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
