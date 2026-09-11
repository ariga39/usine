import { z } from "zod";

const criterionId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe acceptance criterion identifier");

const criterionTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  });

export const acceptanceCriterionSchema = z.union([
  criterionTextSchema,
  z
    .object({
      id: criterionId,
      criterion: criterionTextSchema,
      mandatory: z.boolean().default(true),
      checkId: criterionId.optional(),
    })
    .strict(),
]);

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const acceptanceCriteriaSchema = z
  .array(acceptanceCriterionSchema)
  .min(1)
  .superRefine((criteria, context) => {
    const ids = new Set<string>();
    for (const [index, criterion] of criteria.entries()) {
      if (typeof criterion === "string") continue;
      if (ids.has(criterion.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "acceptance criterion IDs must be unique",
        });
      ids.add(criterion.id);
    }
  });

/** Add obligations without changing the meaning of an existing identifier. */
export function combineAcceptanceCriteria(
  existing: readonly AcceptanceCriterion[],
  additions: readonly AcceptanceCriterion[],
): AcceptanceCriterion[] {
  const combined = [...existing];
  for (const addition of additions) {
    if (typeof addition === "string") {
      if (!combined.includes(addition)) combined.push(addition);
      continue;
    }
    const previous = combined.find(
      (criterion) => typeof criterion !== "string" && criterion.id === addition.id,
    );
    if (previous && typeof previous !== "string") {
      if (
        previous.criterion !== addition.criterion ||
        previous.mandatory !== addition.mandatory ||
        previous.checkId !== addition.checkId
      )
        throw new Error(
          "acceptance criterion identity conflicts with an existing requirement; use a new identifier or an authorized Goal revision",
        );
    } else combined.push(addition);
  }
  return combined;
}

export interface NormalizedAcceptanceCriterion {
  readonly id: string;
  readonly criterion: string;
  readonly mandatory: boolean;
  readonly checkId?: string;
}

export type TextAcceptanceOutcome = {
  readonly acceptance: readonly string[];
  readonly criteria: readonly NormalizedAcceptanceCriterion[];
};

export function acceptanceCriterionText(criterion: AcceptanceCriterion): string {
  return typeof criterion === "string" ? criterion : criterion.criterion;
}

export function normalizeAcceptanceCriteria(
  acceptance: readonly AcceptanceCriterion[],
): NormalizedAcceptanceCriterion[] {
  return acceptance.map((criterion, index) =>
    typeof criterion === "string"
      ? { id: `criterion-${index}`, criterion, mandatory: true }
      : criterion,
  );
}

export function mandatoryAcceptanceCheckIds(
  acceptance: readonly AcceptanceCriterion[],
): readonly string[] {
  return [
    ...new Set(
      normalizeAcceptanceCriteria(acceptance)
        .filter((criterion) => criterion.mandatory && criterion.checkId)
        .map((criterion) => criterion.checkId!),
    ),
  ];
}
