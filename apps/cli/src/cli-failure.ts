import { Runtime } from "effect";

export type CliFailureKind =
  | "usage"
  | "validation"
  | "not_found"
  | "timeout"
  | "connection"
  | "server";

export class CliFailure extends Error {
  readonly [Runtime.errorExitCode]: number;
  readonly [Runtime.errorReported] = false;

  constructor(
    readonly error: string,
    readonly kind: CliFailureKind,
    readonly fields: Record<string, unknown> = {},
    message = error,
  ) {
    super(message);
    this.name = "CliFailure";
    this[Runtime.errorExitCode] = exitCodeForKind(kind);
  }
}

export function usageFailure(fields: Record<string, unknown>): CliFailure {
  return new CliFailure("usage", "usage", fields);
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
  const typedError =
    cause instanceof Error && "code" in cause
      ? (cause as { code?: string; retryable?: boolean })
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      error: typedError?.code ?? diagnostic ?? fallback,
      kind,
      ...(typedError?.retryable ? { retryable: true } : {}),
      message: failureMessage(cause),
    })}\n`,
  );
  process.exitCode = exitCodeForKind(kind);
}

export function exitCodeForKind(kind: string): number {
  if (kind === "usage") return 2;
  if (kind === "not_found") return 3;
  if (kind === "timeout") return 4;
  if (kind === "connection") return 5;
  if (kind === "server") return 6;
  if (kind === "validation") return 7;
  return 2;
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && "kind" in cause) return cause.message;
  return "operation failed";
}
