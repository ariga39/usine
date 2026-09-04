import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  revision: integer("revision").notNull().default(1),
  path: text("path").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  baseBranch: text("base_branch").notNull(),
  implementerProfile: text("implementer_profile").notNull(),
  reviewerProfile: text("reviewer_profile").notNull(),
  forgeProfile: text("forge_profile").notNull(),
  githubReadProfile: text("github_read_profile"),
  headSha: text("head_sha"),
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

/** Durable Planner proposal facts owned by Campaign coordination. */
export const campaignProposals = sqliteTable(
  "campaign_proposals",
  {
    campaignId: text("campaign_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    sequence: integer("sequence").notNull(),
    outcomeId: text("outcome_id").notNull(),
    proposal: text("proposal", { mode: "json" }).notNull(),
    status: text("status").notNull(),
    blocker: text("blocker"),
    readyBaseSha: text("ready_base_sha"),
    readyRepositoryRevision: integer("ready_repository_revision"),
    taskId: text("task_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
  },
  (table) => ({
    campaignProposalPrimaryKey: primaryKey({ columns: [table.campaignId, table.proposalId] }),
    campaignProposalOrder: uniqueIndex("campaign_proposals_campaign_order_index").on(
      table.campaignId,
      table.sequence,
    ),
  }),
);

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

/** Durable Campaign publication facts owned by the Campaign coordinator. */
export const campaigns = sqliteTable(
  "campaigns",
  {
    campaignId: text("campaign_id").primaryKey(),
    goalId: text("goal_id").notNull(),
    goalVersion: integer("goal_version").notNull(),
    contractHash: text("contract_hash").notNull(),
    contract: text("contract", { mode: "json" }).notNull(),
    status: text("status").notNull(),
    publicationAuthorized: integer("publication_authorized", { mode: "boolean" })
      .notNull()
      .default(false),
    superseded: integer("superseded", { mode: "boolean" }).notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(unixepoch() * 1000)`)
      .notNull(),
  },
  (table) => ({
    campaignsGoalIdentity: uniqueIndex("campaigns_goal_identity_index").on(
      table.goalId,
      table.goalVersion,
    ),
  }),
);

/** Guardian-authored Campaign plan and decision touches. */
export const campaignTouches = sqliteTable(
  "campaign_touches",
  {
    campaignId: text("campaign_id").notNull(),
    touchId: text("touch_id").notNull(),
    goalVersion: integer("goal_version").notNull(),
    type: text("type").notNull(),
    occurredAtEpochMs: integer("occurred_at_epoch_ms").notNull(),
  },
  (table) => ({
    campaignTouchPrimaryKey: primaryKey({ columns: [table.campaignId, table.touchId] }),
  }),
);
