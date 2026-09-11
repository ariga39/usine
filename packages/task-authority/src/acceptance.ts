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

export function acceptanceCriterionForIndex(
  acceptance: readonly AcceptanceCriterion[],
  index: number,
): NormalizedAcceptanceCriterion | undefined {
  return normalizeAcceptanceCriteria(acceptance)[index];
}
