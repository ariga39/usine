import { ElapsedBudgetError } from "@usine/review-extractor";

export function processTimedOut(error: unknown): boolean {
  return (
    error instanceof ElapsedBudgetError ||
    (typeof error === "object" && error !== null && "timedOut" in error && error.timedOut === true)
  );
}
