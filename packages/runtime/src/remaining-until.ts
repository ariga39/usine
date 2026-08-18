import { ElapsedBudgetError } from "@usine/review-extractor";

export function remainingUntil(
  deadlineEpochMs: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const remaining = deadlineEpochMs - Date.now();
  if (remaining <= 0) throw new ElapsedBudgetError();
  return Math.max(1, Math.min(remaining, maximum));
}
