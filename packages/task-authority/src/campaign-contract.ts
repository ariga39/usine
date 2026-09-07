import { z } from "zod";
import { Schema } from "effect";

const durableId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must be a safe durable identifier of at most 128 characters",
  );

const outcomeSchema = z
  .object({
    id: durableId,
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    dependsOn: z.array(durableId).default([]),
    parentId: durableId.nullable().default(null),
    status: z.enum(["live", "superseded"]).default("live"),
  })
  .strict();

export const goalContractSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: durableId,
    version: z.number().int().positive(),
    objective: z.string().min(1),
    outcomes: z.array(outcomeSchema).min(1),
    authority: z
      .object({
        source: z.string().min(1),
        publish: z.literal(true),
        delivery: z.boolean().default(false),
        merge: z.boolean().default(false),
        /** An omitted allowlist authorizes no repository. */
        repositories: z.array(durableId).default([]),
        /** An omitted effect allowlist authorizes no effect. */
        effects: z.array(durableId).default([]),
      })
      .strict(),
    budget: z
      .object({
        maxElapsedMs: z.number().int().positive(),
        maxTasks: z.number().int().positive(),
        maxImplementerActivations: z.number().int().min(0).max(2).default(0),
        maxReviewCycles: z.number().int().min(0).max(2).default(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((contract, context) => {
    const ids = new Set<string>();
    const outcomesById = new Map<string, (typeof contract.outcomes)[number]>();
    const outcomeIndexes = new Map<string, number>();
    for (const [index, outcome] of contract.outcomes.entries()) {
      if (ids.has(outcome.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index, "id"],
          message: "outcome IDs must be unique",
        });
      }
      ids.add(outcome.id);
      outcomesById.set(outcome.id, outcome);
      outcomeIndexes.set(outcome.id, index);
    }
    for (const [index, outcome] of contract.outcomes.entries()) {
      if (outcome.parentId === outcome.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index, "parentId"],
          message: "an outcome cannot parent itself",
        });
      } else if (outcome.parentId !== null && !ids.has(outcome.parentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index, "parentId"],
          message: "parent outcome does not exist",
        });
      }
      for (const [dependencyIndex, dependency] of outcome.dependsOn.entries()) {
        if (dependency === outcome.id || !ids.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["outcomes", index, "dependsOn", dependencyIndex],
            message: "dependency must name another outcome",
          });
        }
      }
    }

    const findCycles = (
      nextIds: (outcome: (typeof contract.outcomes)[number]) => readonly string[],
    ): string[] => {
      const states = new Map<string, "visiting" | "visited">();
      const cycles: string[] = [];
      const visit = (outcomeId: string): void => {
        const state = states.get(outcomeId);
        if (state === "visited") return;
        if (state === "visiting") {
          cycles.push(outcomeId);
          return;
        }
        states.set(outcomeId, "visiting");
        for (const nextId of nextIds(outcomesById.get(outcomeId)!)) {
          if (outcomesById.has(nextId)) visit(nextId);
        }
        states.set(outcomeId, "visited");
      };
      for (const outcome of contract.outcomes) visit(outcome.id);
      return cycles;
    };

    for (const outcomeId of findCycles((outcome) =>
      outcome.parentId !== null && outcome.parentId !== outcome.id ? [outcome.parentId] : [],
    )) {
      const outcomeIndex = outcomeIndexes.get(outcomeId);
      if (outcomeIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", outcomeIndex, "parentId"],
          message: "parent relationships must not contain a cycle",
        });
      }
    }

    for (const outcomeId of findCycles((outcome) =>
      outcome.dependsOn.filter((dependencyId) => dependencyId !== outcome.id),
    )) {
      const outcomeIndex = outcomeIndexes.get(outcomeId);
      if (outcomeIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", outcomeIndex, "dependsOn"],
          message: "dependencies must not contain a cycle",
        });
      }
    }
  });

export type GoalContract = z.infer<typeof goalContractSchema>;

const legacyPlannerActivationsSchema = z.number().int().positive();

const persistedGoalContractSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const contract = z.record(z.string(), z.unknown()).safeParse(input);
  if (!contract.success) return input;
  const budget = z.record(z.string(), z.unknown()).safeParse(contract.data.budget);
  if (!budget.success) return input;
  const legacyPlannerActivations = budget.data.maxPlannerActivations;
  if (
    legacyPlannerActivations !== undefined &&
    !legacyPlannerActivationsSchema.safeParse(legacyPlannerActivations).success
  )
    return input;
  const { maxPlannerActivations: _legacy, ...currentBudget } = budget.data;
  return { ...contract.data, budget: currentBudget };
}, goalContractSchema);

/** Decode a durable Goal publication while removing the retired Planner budget field. */
export function decodePersistedGoalContract(input: unknown): GoalContract {
  return persistedGoalContractSchema.parse(input);
}

export const taskProposalSchema = z
  .object({
    proposalId: durableId,
    outcomeId: durableId,
    dependsOn: z.array(durableId).default([]),
    repositoryId: durableId,
    instructions: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string().min(1)),
    effects: z.array(durableId).min(1),
    budget: z.object({
      maxImplementerActivations: z.number().int().min(1).max(2),
      maxReviewCycles: z.number().int().min(1).max(2),
      maxElapsedMs: z.number().int().positive(),
    }),
    delivery: z
      .object({
        /** Optional same-Repository GitHub Task Issue used only for delivery metadata. */
        issue: z.number().int().positive(),
      })
      .strict()
      .optional(),
    merge: z.boolean().default(false),
  })
  .strict();

export type TaskProposal = z.infer<typeof taskProposalSchema>;

export function parseTaskProposal(input: unknown): TaskProposal {
  const raw = z.record(z.string(), z.unknown()).safeParse(input);
  if (!raw.success) throw new Error("task proposal must be an object");
  const value = raw.data;
  if ("baseSha" in value) throw new Error("task proposals cannot provide a base SHA");
  const parsed = taskProposalSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`invalid task proposal: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

export const campaignStatusSchema = Schema.Literals([
  "planning",
  "accepted",
  "blocked",
  "abandoned",
]);
export type CampaignStatus = Schema.Schema.Type<typeof campaignStatusSchema>;

const exactSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

const campaignOutcomeEvidenceSchema = Schema.Struct({
  outcomeId: Schema.String,
  taskId: Schema.String,
  effect: Schema.Literal("github"),
  sha: exactSha,
  merged: Schema.Boolean,
  mergeCommitSha: Schema.NullOr(exactSha),
});

export const campaignAssessmentUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Natural),
  cachedInputTokens: Schema.NullOr(Schema.Natural),
  uncachedInputTokens: Schema.NullOr(Schema.Natural),
  cacheWriteInputTokens: Schema.NullOr(Schema.Natural),
  outputTokens: Schema.NullOr(Schema.Natural),
  reasoningOutputTokens: Schema.NullOr(Schema.Natural),
});

const campaignAssessmentFactFields = {
  repositoryId: Schema.String,
  proposalId: Schema.String,
  taskId: Schema.String,
  fact: Schema.Literals(["candidate", "check", "review", "delivery"]),
  status: Schema.String,
  sha: exactSha,
};

/** A mechanically resolved fact supplied to the assessor without a criterion claim. */
export const campaignAssessmentFactSchema = Schema.Struct(campaignAssessmentFactFields);

/** An assessor-owned mapping from one acceptance criterion to one supplied fact. */
const campaignAssessmentEvidenceSchema = Schema.Struct({
  criterionIndex: Schema.Natural,
  ...campaignAssessmentFactFields,
});

export const campaignAssessmentSchema = Schema.Struct({
  role: Schema.Literal("assessor"),
  assessmentId: Schema.String,
  outcomeId: Schema.String,
  evidenceHash: Schema.String,
  verdict: Schema.Literals(["satisfied", "gaps", "inconclusive"]),
  summary: Schema.String,
  gaps: Schema.Array(Schema.String),
  evidence: Schema.Array(campaignAssessmentEvidenceSchema),
  usage: Schema.NullOr(campaignAssessmentUsageSchema),
  startedAtEpochMs: Schema.Int,
  completedAtEpochMs: Schema.Int,
});

const campaignDecisionRequestSchema = Schema.Struct({
  requestId: Schema.String,
  reason: Schema.Literals([
    "plan_exhausted",
    "branches_blocked",
    "assessment_gaps",
    "assessment_inconclusive",
    "replacement_invalid",
    "replacement_duplicate",
    "replacement_unavailable",
    "replacement_budget_exhausted",
    "replacement_exhausted",
  ]),
  outcomeIds: Schema.Array(Schema.String),
});

const campaignOutcomeSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  acceptance: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["planned", "accepted", "superseded"]),
  evidence: Schema.NullOr(campaignOutcomeEvidenceSchema),
  assessment: Schema.optional(Schema.NullOr(campaignAssessmentSchema)),
});

const campaignProposalStatusSchema = Schema.Literals(["planned", "ready", "blocked"]);

const campaignProposalSchema = Schema.Struct({
  proposalId: Schema.String,
  outcomeId: Schema.String,
  sequence: Schema.Natural,
  status: campaignProposalStatusSchema,
  blocker: Schema.NullOr(Schema.String),
  replacement: Schema.optional(
    Schema.Struct({
      assessmentId: Schema.String,
      evidenceHash: Schema.String,
      role: Schema.Literal("replacement-planner"),
      usage: Schema.NullOr(campaignAssessmentUsageSchema),
    }),
  ),
  ready: Schema.NullOr(
    Schema.Struct({
      repositoryId: Schema.String,
      baseSha: Schema.String,
      repositoryRevision: Schema.Natural,
      taskId: Schema.optional(Schema.NullOr(Schema.String)),
      instructions: Schema.String,
      acceptance: Schema.Array(Schema.String),
      nonGoals: Schema.Array(Schema.String),
      effects: Schema.Array(Schema.String),
      budget: Schema.Struct({
        maxImplementerActivations: Schema.Int,
        maxReviewCycles: Schema.Int,
        maxElapsedMs: Schema.Int,
      }),
      delivery: Schema.optional(
        Schema.Struct({
          issue: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
        }),
      ),
      merge: Schema.Boolean,
    }),
  ),
});

export const campaignResourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignId: Schema.String,
  goalId: Schema.String,
  goalVersion: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  contractHash: Schema.String,
  objective: Schema.String,
  outcomes: Schema.Array(campaignOutcomeSchema),
  authority: Schema.Struct({
    source: Schema.String,
    publish: Schema.Literal(true),
    delivery: Schema.Boolean,
    merge: Schema.Boolean,
    repositories: Schema.optional(Schema.Array(Schema.String)),
    effects: Schema.optional(Schema.Array(Schema.String)),
  }),
  budget: Schema.Struct({
    maxElapsedMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    maxTasks: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    maxImplementerActivations: Schema.optional(Schema.Int),
    maxReviewCycles: Schema.optional(Schema.Int),
  }),
  status: campaignStatusSchema,
  planHandedOff: Schema.Boolean,
  decisionRequest: Schema.NullOr(campaignDecisionRequestSchema),
  revision: Schema.Natural,
  proposals: Schema.optional(Schema.Array(campaignProposalSchema)),
});

export type CampaignOutcome = Schema.Schema.Type<typeof campaignOutcomeSchema>;
export type CampaignResource = Schema.Schema.Type<typeof campaignResourceSchema>;
export type CampaignProposalResource = Schema.Schema.Type<typeof campaignProposalSchema>;
export type CampaignOutcomeEvidence = Schema.Schema.Type<typeof campaignOutcomeEvidenceSchema>;
export type CampaignAssessment = Schema.Schema.Type<typeof campaignAssessmentSchema>;
export type CampaignAssessmentFact = Schema.Schema.Type<typeof campaignAssessmentFactSchema>;
export type CampaignAssessmentEvidence = Schema.Schema.Type<
  typeof campaignAssessmentEvidenceSchema
>;
export type CampaignAssessmentUsage = Schema.Schema.Type<typeof campaignAssessmentUsageSchema>;
export type CampaignDecisionRequest = Schema.Schema.Type<typeof campaignDecisionRequestSchema>;

export interface CampaignProjection {
  readonly proposals: ReadonlyArray<CampaignProposalResource>;
  readonly planHandedOff: boolean;
  readonly decisionRequest: CampaignDecisionRequest | null;
  readonly outcomeEvidence?: ReadonlyMap<string, CampaignOutcomeEvidence>;
  readonly assessments?: ReadonlyMap<string, CampaignAssessment>;
  readonly satisfiedOutcomes?: ReadonlySet<string>;
}

export function decodeCampaignStatus(input: unknown): CampaignStatus {
  return Schema.decodeUnknownSync(campaignStatusSchema)(input);
}

export function decodeCampaignDecisionRequest(input: unknown): CampaignDecisionRequest | null {
  return Schema.decodeUnknownSync(Schema.NullOr(campaignDecisionRequestSchema))(input);
}

export function decodeCampaignProposalStatus(input: unknown): CampaignProposalResource["status"] {
  return Schema.decodeUnknownSync(campaignProposalStatusSchema)(input);
}

export function campaignResourceFromContract(
  contract: GoalContract,
  contractHash: string,
  status: CampaignStatus,
  revision = 1,
  projection?: CampaignProjection,
): CampaignResource {
  const outcomes = contract.outcomes.map((outcome) => ({
    id: outcome.id,
    title: outcome.title,
    acceptance: outcome.acceptance,
    dependsOn: outcome.dependsOn,
    parentId: outcome.parentId,
    status:
      outcome.status === "superseded"
        ? ("superseded" as const)
        : projection?.satisfiedOutcomes?.has(outcome.id)
          ? ("accepted" as const)
          : ("planned" as const),
    evidence: projection?.outcomeEvidence?.get(outcome.id) ?? null,
    ...(projection?.assessments?.has(outcome.id)
      ? { assessment: projection.assessments.get(outcome.id) ?? null }
      : {}),
  }));
  const resource: CampaignResource = {
    schemaVersion: 1,
    campaignId: campaignIdFor(contract.id, contract.version),
    goalId: contract.id,
    goalVersion: contract.version,
    contractHash,
    objective: contract.objective,
    outcomes,
    authority: {
      source: contract.authority.source,
      publish: true,
      delivery: contract.authority.delivery,
      merge: contract.authority.merge,
      repositories: contract.authority.repositories,
      effects: contract.authority.effects,
    },
    budget: {
      maxElapsedMs: contract.budget.maxElapsedMs,
      maxTasks: contract.budget.maxTasks,
      maxImplementerActivations: contract.budget.maxImplementerActivations,
      maxReviewCycles: contract.budget.maxReviewCycles,
    },
    status,
    planHandedOff: projection?.planHandedOff ?? false,
    decisionRequest: projection?.decisionRequest ?? null,
    revision,
  };
  return projection ? { ...resource, proposals: [...projection.proposals] } : resource;
}

export function campaignIdFor(goalId: string, version: number): string {
  return `${goalId}:v${version}`;
}
