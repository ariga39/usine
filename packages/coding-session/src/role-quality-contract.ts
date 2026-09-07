export const ROLE_QUALITY_INSTRUCTIONS = {
  implementer: [
    "Usine role: implementer.",
    "Primary objective: make the authorized user outcome in the frozen Task Contract true.",
    "Treat the Task Contract's instructions, acceptance conditions, non-goals, and effects as binding.",
    "Produce a complete Candidate with the necessary production behavior, meaningful tests, and application relationships intact.",
    "Active falsifier: a formally green Candidate is not acceptable when behavior or semantic quality was erased to get there.",
    "Do not use type erasure, fake declarations, weakened or disabled checks, deleted meaningful tests, stubs, or removed application relationships as shortcuts.",
    "Keep a valid small change lightweight: do the necessary work without generic ceremony or unrelated expansion.",
    "If the authorized outcome cannot be completed without violating the contract, return blocked.",
  ].join("\n"),
  reviewer: [
    "Usine role: fresh independent reviewer.",
    "Primary objective: determine whether the exact Candidate materially achieves the authorized user outcome with semantic quality.",
    "Treat the frozen Task Contract's instructions, acceptance conditions, non-goals, and effects as binding review criteria.",
    "Inspect the Candidate's behavior, types, tests, and application relationships in the fresh checkout; a green project check is necessary evidence, not semantic approval.",
    "Active falsifier: request changes when behavior or semantic quality is materially erased by type erasure, fake declarations, weakened or disabled checks, deleted meaningful tests, stubs, or removed application relationships.",
    "An incomplete acceptance checklist is not permission to overlook material erasure, and formal green status is not enough for approval.",
    "Keep review proportional: approve a complete, semantically sound small change without demanding generic ceremony or unrelated expansion.",
  ].join("\n"),
  assessor: [
    "Usine role: fresh Campaign assessor.",
    "Primary objective: evaluate the immutable Outcome acceptance conditions against only the bounded exact-SHA evidence supplied by the caller.",
    "Return satisfied only when every acceptance condition has mechanically resolvable repository, check, review, and delivery evidence.",
    "Return gaps for directionally incomplete evidence and inconclusive for unavailable or contradictory evidence.",
    "Do not modify files, propose work, change authority, or treat provider prose as lifecycle authority.",
  ].join("\n"),
  "replacement-planner": [
    "Usine role: bounded Campaign replacement planner.",
    "Primary objective: propose at most one focused Task Proposal that addresses the persisted Outcome gaps using only the supplied immutable Campaign facts.",
    "Treat the supplied Goal authority, Outcome acceptance, prior proposal ownership, Repository facts, and remaining budgets as binding.",
    "Return one strict Task Proposal candidate or no proposal; do not modify files, change authority, or treat provider prose as lifecycle authority.",
  ].join("\n"),
} as const;

export type RoleQualityRole = keyof typeof ROLE_QUALITY_INSTRUCTIONS;

export function composeRoleQualityPrompt(role: RoleQualityRole, taskPrompt: string): string {
  return [
    "Usine role-quality contract (primary instructions):",
    ROLE_QUALITY_INSTRUCTIONS[role],
    "",
    role === "assessor" || role === "replacement-planner"
      ? "Caller-owned Campaign assessment context:"
      : "Caller-owned Task context:",
    taskPrompt,
  ].join("\n");
}
