export class ElapsedBudgetError extends Error {
  constructor() {
    super("elapsed budget exhausted");
  }
}

export function remainingUntil(deadlineEpochMs: number, maximum?: number): number;
export function remainingUntil(deadlineEpochMs: number | undefined, maximum: number): number;
export function remainingUntil(deadlineEpochMs: number | undefined): number | undefined;
export function remainingUntil(
  deadlineEpochMs: number | undefined,
  maximum?: number,
): number | undefined {
  if (deadlineEpochMs === undefined) return maximum;
  const remaining = deadlineEpochMs - Date.now() - 100;
  if (remaining <= 0) throw new ElapsedBudgetError();
  return Math.max(1, maximum === undefined ? remaining : Math.min(remaining, maximum));
}

export function deadlineExpired(deadlineEpochMs: number | undefined): boolean {
  return deadlineEpochMs !== undefined && Date.now() >= deadlineEpochMs;
}
