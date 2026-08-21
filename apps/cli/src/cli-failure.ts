export type CliFailureKind = "validation" | "not_found" | "timeout" | "connection" | "server";

export class CliFailure extends Error {
  constructor(
    readonly error: string,
    readonly kind: CliFailureKind,
    readonly fields: Record<string, unknown> = {},
    message = error,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

export function usageFailure(usage: string): CliFailure {
  return new CliFailure("usage", "validation", { usage });
}

export function notFoundFailure(resource: string, field: string, value: string): CliFailure {
  return new CliFailure(`${resource}_not_found`, "not_found", { [field]: value });
}

export async function runCommand(
  fallback: string,
  action: () => Promise<void>,
  forcedKind?: CliFailureKind,
): Promise<void> {
  try {
    await action();
  } catch (cause) {
    reportCommandFailure(fallback, cause, forcedKind);
  }
}

export function reportCommandFailure(
  fallback: string,
  cause: unknown,
  forcedKind?: CliFailureKind,
): void {
  if (cause instanceof CliFailure) {
    process.stderr.write(`${JSON.stringify({ error: cause.error, ...cause.fields })}\n`);
    process.exitCode = exitCodeForKind(cause.kind);
    return;
  }

  const typed =
    cause instanceof Error && "kind" in cause ? (cause as { kind?: string }) : undefined;
  const kind = forcedKind ?? (typed?.kind as CliFailureKind | undefined) ?? "server";
  const diagnostic =
    cause instanceof Error && "diagnostic" in cause
      ? (cause as { diagnostic?: string }).diagnostic
      : undefined;
  process.stderr.write(
    `${JSON.stringify({ error: diagnostic ?? fallback, kind, message: failureMessage(cause) })}\n`,
  );
  process.exitCode = exitCodeForKind(kind);
}

export function exitCodeForKind(kind: string): number {
  if (kind === "not_found") return 3;
  if (kind === "timeout") return 4;
  if (kind === "connection") return 5;
  if (kind === "server") return 6;
  return 2;
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && "kind" in cause) return cause.message;
  return "operation failed";
}
