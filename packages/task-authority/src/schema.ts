import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const taskRuns = sqliteTable("task_runs", {
  taskId: text("task_id").primaryKey(),
  result: text("result", { mode: "json" }).notNull(),
  contractPath: text("contract_path"),
  repositoryPath: text("repository_path"),
  rawContract: text("raw_contract"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
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
