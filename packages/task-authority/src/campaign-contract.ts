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
        maxPlannerActivations: z.number().int().positive().default(1),
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

export const campaignStatusSchema = Schema.Literal("planning");
export type CampaignStatus = Schema.Schema.Type<typeof campaignStatusSchema>;

const campaignOutcomeSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  acceptance: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["planned", "superseded"]),
});

const campaignProposalStatusSchema = Schema.Literals(["planned", "ready", "blocked"]);

const campaignProposalSchema = Schema.Struct({
  proposalId: Schema.String,
  outcomeId: Schema.String,
  sequence: Schema.Natural,
  status: campaignProposalStatusSchema,
  blocker: Schema.NullOr(Schema.String),
  ready: Schema.NullOr(
    Schema.Struct({
      repositoryId: Schema.String,
      baseSha: Schema.String,
      repositoryRevision: Schema.Natural,
      taskId: Schema.NullOr(Schema.String),
      instructions: Schema.String,
      acceptance: Schema.Array(Schema.String),
      nonGoals: Schema.Array(Schema.String),
      effects: Schema.Array(Schema.String),
      budget: Schema.Struct({
        maxImplementerActivations: Schema.Int,
        maxReviewCycles: Schema.Int,
        maxElapsedMs: Schema.Int,
      }),
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
    maxPlannerActivations: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    maxImplementerActivations: Schema.optional(Schema.Int),
    maxReviewCycles: Schema.optional(Schema.Int),
  }),
  status: campaignStatusSchema,
  revision: Schema.Natural,
  proposals: Schema.optional(Schema.Array(campaignProposalSchema)),
});

export type CampaignOutcome = Schema.Schema.Type<typeof campaignOutcomeSchema>;
export type CampaignResource = Schema.Schema.Type<typeof campaignResourceSchema>;
export type CampaignProposalResource = Schema.Schema.Type<typeof campaignProposalSchema>;

export interface CampaignProjection {
  readonly proposals: ReadonlyArray<CampaignProposalResource>;
}

export function decodeCampaignStatus(input: unknown): CampaignStatus {
  return Schema.decodeUnknownSync(campaignStatusSchema)(input);
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
    status: outcome.status === "live" ? ("planned" as const) : ("superseded" as const),
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
      maxPlannerActivations: contract.budget.maxPlannerActivations,
      maxImplementerActivations: contract.budget.maxImplementerActivations,
      maxReviewCycles: contract.budget.maxReviewCycles,
    },
    status,
    revision,
  };
  return projection ? { ...resource, proposals: [...projection.proposals] } : resource;
}

export function campaignIdFor(goalId: string, version: number): string {
  return `${goalId}:v${version}`;
}
