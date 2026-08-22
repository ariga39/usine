export type CodingSessionPhase = "startup" | "thread" | "turn" | "output";

export type CodingSessionFailureClass =
  | "transport"
  | "network"
  | "rate_limit"
  | "timeout"
  | "cancellation"
  | "configuration"
  | "authority"
  | "unknown";

export class CodingSessionInterruption extends Error {
  constructor(
    readonly phase: CodingSessionPhase,
    readonly failureClass: CodingSessionFailureClass,
    message = `coding session provider interruption (${failureClass})`,
  ) {
    super(message);
    this.name = "CodingSessionInterruption";
  }
}

export function classifyAdapterFailure(error: unknown): CodingSessionFailureClass {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/(rate[ -]?limit|too many requests|429)/.test(message)) return "rate_limit";
  if (/(timeout|timed out|deadline|elapsed)/.test(message)) return "timeout";
  if (/(network|dns|socket|connect|unreachable)/.test(message)) return "network";
  if (/(auth|credential|api key|unauthorized|forbidden|permission|denied)/.test(message))
    return "authority";
  if (/(config|profile|invalid option|unknown option|unsupported|capability)/.test(message))
    return "configuration";
  if (/(transport|protocol|stream|closed|malformed)/.test(message)) return "transport";
  return "unknown";
}
