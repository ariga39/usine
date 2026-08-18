export class ElapsedBudgetError extends Error {
  constructor() {
    super("elapsed budget exhausted");
  }
}

export function remainingUntil(
  deadlineEpochMs: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const remaining = deadlineEpochMs - Date.now() - 100;
  if (remaining <= 0) throw new ElapsedBudgetError();
  return Math.max(1, Math.min(remaining, maximum));
}

export function deadlineExpired(deadlineEpochMs: number): boolean {
  return Date.now() >= deadlineEpochMs;
}
