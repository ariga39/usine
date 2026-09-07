import type {
  RepositoryResource,
  ServerHealth,
  ServerSnapshot,
  TaskEvent,
  TaskEventPage,
  TaskListPage,
  TaskResource,
  UsageReport,
  CampaignEvidencePage,
} from "@usine/task-authority";
import type { ForgeReadinessResult, SessionArchiveManifest } from "@usine/runtime";

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function renderToken(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function renderTaskList(page: TaskListPage, json: boolean): string {
  if (json) return renderJson(page);
  return [
    "TASK ID\tSTATE\tREVISION",
    ...page.tasks.map((task) => `${task.taskId}\t${task.state}\t${task.revision}`),
    "",
  ].join("\n");
}

export function renderTask(task: TaskResource, json: boolean): string {
  return json
    ? renderJson(task)
    : `Task ${task.taskId}: ${task.state} (revision ${task.revision})\n`;
}

export function renderRepositoryList(
  page: { repositories: RepositoryResource[] },
  json: boolean,
): string {
  if (json) return renderJson(page);
  return [
    "REPOSITORY ID\tOWNER/NAME\tREVISION",
    ...page.repositories.map(
      (repository) =>
        `${repository.id}\t${repository.owner}/${repository.name}\t${repository.revision}`,
    ),
    "",
  ].join("\n");
}

export function renderRepository(repository: RepositoryResource, json: boolean): string {
  return json
    ? renderJson(repository)
    : `Repository ${repository.id}: ${repository.owner}/${repository.name} (revision ${repository.revision})\n`;
}

export function renderTaskEvents(
  page: TaskEventPage,
  afterSequence: number,
  json: boolean,
): string {
  if (json) return renderJson(page);
  return [
    `Task ${page.taskId} events after ${afterSequence}:`,
    ...page.events.map((event) => `#${event.sequence}\t${event.data.type}`),
    "",
  ].join("\n");
}

export function renderEvent(event: TaskEvent): string {
  return renderJson(event);
}

export function renderServerHealth(health: ServerHealth, json: boolean): string {
  return json ? renderJson(health) : `Server: ${health.status} (revision ${health.revision})\n`;
}

export function renderServerSnapshot(snapshot: ServerSnapshot, json: boolean): string {
  if (json) return renderJson(snapshot);
  return [
    `Server: ${snapshot.server.status} (revision ${snapshot.revision})`,
    `Repositories: ${snapshot.repositories.length}`,
    `Tasks: ${snapshot.tasks.length}`,
    `Coding sessions: ${snapshot.codingSessions.length}`,
    "",
  ].join("\n");
}

export function renderForgeReadiness(
  result: Extract<ForgeReadinessResult, { ready: true }>,
  json: boolean,
): string {
  return json
    ? renderJson(result)
    : `Forge readiness: ready for ${result.repository} (installation ${result.installationId})\n`;
}

export function renderUsageReport(report: UsageReport, json: boolean): string {
  if (json) return renderJson(report);
  return [
    `Usage: ${report.coverage} (${report.invocations.length} invocations)`,
    `Aggregates: ${report.aggregates.length}`,
    "TASK ID\tROLE\tCONFIGURED_MODEL\tCONFIGURED_PROVIDER\tACTUAL_MODEL\tACTUAL_PROVIDER\tINPUT\tOUTPUT",
    ...report.invocations.map(
      (run) =>
        `${run.taskId}\t${run.role}\t${run.configuredModel}\t${run.configuredProvider}\t${run.actualModel}\t${run.actualProvider}\t${renderToken(run.usage.inputTokens)}\t${renderToken(run.usage.outputTokens)}`,
    ),
    "",
  ].join("\n");
}

export function renderCampaignEvidence(report: CampaignEvidencePage, json: boolean): string {
  if (json) return renderJson(report);
  return [
    `Campaign ${report.campaignId} evidence: ${report.coverage}`,
    `Totals: ${report.totals.invocations} runs, ${report.totals.reviewCycles} review cycles, ${report.totals.repairBatches} repair batches`,
    `Proposals: ${report.totals.blockedProposals} blocked`,
    `Guardian touches: ${report.totals.guardianTouches}; accepted deliveries: ${report.totals.acceptedDeliveries}`,
    `Tokens: input=${renderToken(report.totals.usage.inputTokens)} cached=${renderToken(report.totals.usage.cachedInputTokens)} uncached=${renderToken(report.totals.usage.uncachedInputTokens)} output=${renderToken(report.totals.usage.outputTokens)}`,
    "TASK ID\tOUTCOME\tROLE\tCONFIGURED_MODEL\tCONFIGURED_PROVIDER\tACTUAL_MODEL\tACTUAL_PROVIDER\tADAPTER\tINPUT\tCACHED\tUNCACHED\tOUTPUT",
    ...report.runs.map(
      (run) =>
        `${run.taskId}\t${run.outcome}\t${run.role}\t${run.configuredModel}\t${run.configuredProvider}\t${run.actualModel}\t${run.actualProvider}\t${run.adapter}\t${renderToken(run.usage.inputTokens)}\t${renderToken(run.usage.cachedInputTokens)}\t${renderToken(run.usage.uncachedInputTokens)}\t${renderToken(run.usage.outputTokens)}`,
    ),
    "",
  ].join("\n");
}

export function renderArchiveList(
  manifests: readonly SessionArchiveManifest[],
  json: boolean,
): string {
  if (json) return renderJson({ archives: manifests });
  return [
    "ARCHIVE ID\tTASK ID\tROLE\tATTEMPT\tSTATUS\tCAPTURE\tCOMPLETENESS",
    ...manifests.map(
      (archive) =>
        `${archive.archiveId}\t${archive.taskId}\t${archive.role}\t${archive.attempt}\t${archive.status}\t${archive.captureStatus}\t${archive.completeness}`,
    ),
    "",
  ].join("\n");
}
