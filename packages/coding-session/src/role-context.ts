/** Serialize role context without changing JSON omission or meaningful array order. */
export function serializeRoleContext(value: unknown): string {
  return (
    JSON.stringify(value, (_key, child: unknown) => {
      if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
      return Object.fromEntries(
        Object.entries(child).toSorted(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }) ?? "null"
  );
}
