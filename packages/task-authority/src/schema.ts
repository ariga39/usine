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
  acceptanceChecks: text("acceptance_checks", { mode: "json" }).notNull(),
  gitAuthorName: text("git_author_name").notNull(),
  gitAuthorEmail: text("git_author_email").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(unixepoch() * 1000)`)
    .notNull(),
});

/** Durable Campaign proposal facts owned by Campaign coordination. */
export const campaignProposals = sqliteTable(
  "campaign_proposals",
  {
    campaignId: text("campaign_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    sequence: integer("sequence").notNull(),
    outcomeId: text("outcome_id").notNull(),
    proposal: text("proposal", { mode: "json" }).notNull(),
    requirementAddition: integer("requirement_addition", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").notNull(),
    blocker: text("blocker"),
    supersededByProposalId: text("superseded_by_proposal_id"),
    supersedesProposalId: text("supersedes_proposal_id"),
    readyBaseSha: text("ready_base_sha"),
    readyRepositoryRevision: integer("ready_repository_revision"),
    taskId: text("task_id"),
    replacementAssessmentId: text("replacement_assessment_id"),
    replacementEvidenceHash: text("replacement_evidence_hash"),
    replacementUsage: text("replacement_usage", { mode: "json" }),
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
    planHandedOff: integer("plan_handed_off", { mode: "boolean" }).notNull().default(false),
    assessmentRequested: integer("assessment_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    checkpointRequested: integer("checkpoint_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    decisionRequest: text("decision_request", { mode: "json" }),
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

/** Guardian-authored Campaign decision touches; plan touches are projected from Campaign facts. */
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

/** Durable read-only Campaign Outcome assessment facts. */
export const campaignAssessments = sqliteTable(
  "campaign_assessments",
  {
    campaignId: text("campaign_id").notNull(),
    outcomeId: text("outcome_id").notNull(),
    role: text("role").notNull().default("assessor"),
    evidenceHash: text("evidence_hash").notNull(),
    assessmentId: text("assessment_id").notNull(),
    assessment: text("assessment", { mode: "json" }).notNull(),
    startedAtEpochMs: integer("started_at_epoch_ms").notNull(),
    completedAtEpochMs: integer("completed_at_epoch_ms").notNull(),
  },
  (table) => ({
    campaignAssessmentIdentity: primaryKey({
      columns: [table.campaignId, table.outcomeId, table.assessmentId],
    }),
  }),
);

/** Append-only replacement-planner attempt and result for one Campaign/Outcome assessment. */
export const campaignReplacementRuns = sqliteTable(
  "campaign_replacement_runs",
  {
    campaignId: text("campaign_id").notNull(),
    outcomeId: text("outcome_id").notNull(),
    assessmentId: text("assessment_id").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    invocationId: text("invocation_id").notNull(),
    role: text("role").notNull().default("replacement-planner"),
    status: text("status").notNull(),
    proposal: text("proposal", { mode: "json" }),
    usage: text("usage", { mode: "json" }),
    startedAtEpochMs: integer("started_at_epoch_ms").notNull(),
    completedAtEpochMs: integer("completed_at_epoch_ms"),
  },
  (table) => ({
    campaignReplacementRunIdentity: primaryKey({
      columns: [table.campaignId, table.outcomeId, table.invocationId],
    }),
    campaignReplacementRunInvocation: uniqueIndex("campaign_replacement_runs_invocation_index").on(
      table.invocationId,
    ),
  }),
);

/** Durable provider observation for one Campaign-only assessor or planner run. */
export const campaignModelRuns = sqliteTable("campaign_model_runs", {
  invocationId: text("invocation_id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  outcomeId: text("outcome_id").notNull(),
  role: text("role").notNull(),
  assessmentId: text("assessment_id"),
  evidenceHash: text("evidence_hash"),
  status: text("status").notNull(),
  failureClass: text("failure_class"),
  startedAtEpochMs: integer("started_at_epoch_ms").notNull(),
  completedAtEpochMs: integer("completed_at_epoch_ms"),
  elapsedMs: integer("elapsed_ms"),
  repositoryId: text("repository_id"),
  repository: text("repository"),
  profile: text("profile"),
  configuredProvider: text("configured_provider"),
  configuredModel: text("configured_model"),
  actualProvider: text("actual_provider"),
  actualModel: text("actual_model"),
  adapter: text("adapter"),
  serviceTier: text("service_tier"),
  reasoningEffort: text("reasoning_effort"),
  usage: text("usage", { mode: "json" }),
});

/** Minimum durable acknowledgement owned by the optional PostHog observer. */
export const posthogCaptureAcknowledgements = sqliteTable(
  "posthog_capture_acknowledgements",
  {
    deployment: text("deployment").notNull(),
    eventUuid: text("event_uuid").notNull(),
  },
  (table) => ({
    posthogCaptureAcknowledgementPrimaryKey: primaryKey({
      columns: [table.deployment, table.eventUuid],
    }),
  }),
);
