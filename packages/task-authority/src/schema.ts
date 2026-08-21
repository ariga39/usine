import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const taskRuns = sqliteTable("task_runs", {
  taskId: text("task_id").primaryKey(),
  result: text("result", { mode: "json" }).notNull(),
  contractPath: text("contract_path"),
  rawContract: text("raw_contract"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  baseBranch: text("base_branch").notNull(),
  implementerProfile: text("implementer_profile").notNull(),
  reviewerProfile: text("reviewer_profile").notNull(),
  forgeProfile: text("forge_profile").notNull(),
  projectCheckCommand: text("project_check_command").notNull(),
  projectCheckTimeoutMs: integer("project_check_timeout_ms").notNull(),
  gitAuthorName: text("git_author_name").notNull(),
  gitAuthorEmail: text("git_author_email").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});

export const taskQuarantines = sqliteTable("task_quarantines", {
  taskId: text("task_id").primaryKey(),
  reason: text("reason").notNull(),
  result: text("result").notNull(),
  contractPath: text("contract_path"),
  repositoryPath: text("repository_path"),
  rawContract: text("raw_contract"),
  quarantinedAt: integer("quarantined_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});

export const repositoryLeases = sqliteTable("repository_leases", {
  repositoryIdentity: text("repository_identity").primaryKey(),
  taskId: text("task_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});

export const taskHistory = sqliteTable(
  "task_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    activation: integer("activation"),
    cycle: integer("cycle"),
    role: text("role"),
    profile: text("profile"),
    observedModel: text("observed_model"),
    observedProvider: text("observed_provider"),
    executionOwner: text("execution_owner"),
    previousExecutionOwner: text("previous_execution_owner"),
    startedAtEpochMs: integer("started_at_epoch_ms").notNull(),
    endedAtEpochMs: integer("ended_at_epoch_ms"),
    outcome: text("outcome").notNull(),
    failure: text("failure"),
    candidateSha: text("candidate_sha"),
    candidateFence: integer("candidate_fence"),
    tokenUsage: text("token_usage", { mode: "json" }),
  },
  (table) => ({
    taskHistoryTaskIdId: index("task_history_task_id_id_index").on(table.taskId, table.id),
  }),
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    taskId: text("task_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventId: text("event_id").notNull(),
    occurredAtEpochMs: integer("occurred_at_epoch_ms").notNull(),
    data: text("data", { mode: "json" }).notNull(),
  },
  (table) => ({
    taskEventsPrimaryKey: primaryKey({ columns: [table.taskId, table.sequence] }),
    taskEventsTaskIdEventId: uniqueIndex("task_events_task_id_event_id_index").on(
      table.taskId,
      table.eventId,
    ),
  }),
);
