import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    model: text("model"),
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
