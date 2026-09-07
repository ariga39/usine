/**
 * Return an opaque identity only when it is safe to retain in durable evidence.
 */
export function safeEvidenceIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/.test(value))
    return null;
  if (
    value.includes("://") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    /(?:api[_-]?key|secret|token|password|credential|bearer)/i.test(value)
  )
    return null;
  const firstSegment = value.split("/")[0]!;
  if (
    firstSegment.includes(".") &&
    /^[A-Za-z0-9.-]+$/.test(firstSegment) &&
    /^[A-Za-z]/.test(firstSegment.split(".").at(-1)!)
  )
    return null;
  if (/:[0-9]+(?:\/|$)/.test(value)) return null;
  return value;
}
