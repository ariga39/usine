import { asc, eq, inArray, sql } from "drizzle-orm";
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
  type CampaignEvidenceDecisionTouch,
  type CampaignEvidencePageRequest,
  type CampaignEvidenceProposal,
  type CampaignEvidenceSource,
  type CampaignEvidenceSourcesPage,
} from "./campaign-evidence.js";
import { campaigns, campaignProposals, campaignTouches, taskEvents, taskRuns } from "./schema.js";
import { decodeCampaignProposalStatus } from "./campaign-contract.js";
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
  };
  const proposals: CampaignEvidenceProposal[] = proposalRows.map((row) => ({
    proposalId: row.proposalId,
    sequence: row.sequence,
    outcomeId: row.outcomeId,
    status: decodeCampaignProposalStatus(row.status),
    blocker: row.blocker,
    taskId: row.taskId,
    admittedAtEpochMs: row.createdAt.getTime(),
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
  return {
    campaign,
    proposals,
    decisionTouches,
    sources,
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
