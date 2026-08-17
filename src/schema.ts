import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const taskRuns = pgTable("task_runs", {
  taskId: text("task_id").primaryKey(),
  contractHash: text("contract_hash").notNull(),
  contract: jsonb("contract").notNull(),
  repository: text("repository").notNull(),
  state: text("state").notNull(),
  writerGeneration: integer("writer_generation").notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).defaultNow().notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const repositoryLeases = pgTable("repository_leases", {
  repositoryIdentity: text("repository").primaryKey(),
  taskId: text("task_id").notNull().unique(),
  generation: integer("generation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
