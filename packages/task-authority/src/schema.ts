import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const taskRuns = sqliteTable("task_runs", {
  taskId: text("task_id").primaryKey(),
  contractHash: text("contract_hash").notNull(),
  contract: text("contract", { mode: "json" }).notNull(),
  repository: text("repository").notNull(),
  state: text("state").notNull(),
  writerGeneration: integer("writer_generation").notNull(),
  deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
  result: text("result", { mode: "json" }).notNull(),
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
  generation: integer("generation").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});
