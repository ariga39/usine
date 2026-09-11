import { serializeRoleContext } from "@usine/coding-session";

/** Evidence and allowlists are sets; criterion and proposal histories are not. */
export function orderedContextFacts<T>(facts: readonly T[]): T[] {
  return facts
    .map((fact) => ({ fact, key: serializeRoleContext(fact) }))
    .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ fact }) => fact);
}
