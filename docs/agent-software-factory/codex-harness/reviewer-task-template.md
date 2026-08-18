# Reviewer Task: <outcome>

Review the exact candidate as a fresh non-author Codex. Read the full codebase, canonical design, active Issue/task, base-to-candidate diff and check evidence. Do not read or rely on implementer chat or self-justification.

## Identity

- Task: `<id>`
- Base SHA: `<40-char SHA>`
- Candidate SHA: `<40-char SHA>`
- Check evidence: `<path/summary>`
- Expected design-review requirement: `<required | not_required>`

## Spec review

Determine whether the candidate satisfies the outcome, acceptance, invariants and non-goals. Findings must cite concrete code/evidence and state observed versus expected behavior and impact.

## Design review

Perform this section only when `Expected design-review requirement` is `required`. When it is `not_required`, return `design_verdict: "not_required"` and do not invent design scope. An active route falsifier or canonical direction blocker remains blocking regardless of the Issue's non-goals.

Assess the candidate in the complete codebase, not only against the Issue wording:

- Is each new/changed module deep: small interface, substantial hidden behavior?
- Is the seam placed where behavior actually varies?
- Does the change improve locality for the next likely change?
- Is policy duplicated across callers or conditionals?
- Is a new package only physical movement with one caller?
- Would tests survive internal refactoring?
- Does the candidate layer a new path beside the old seam instead of replacing/deleting it?
- Did a real runtime failure invalidate the chosen route even if the Issue calls it out of scope?

A material design defect is blocking even when all current tests pass and Issue acceptance is met. Do not defer it merely because it crosses the current Issue scope.

## Output discipline

Return only the schema-constrained result. Use stable finding IDs. `approved` cannot coexist with a blocking finding of the same kind. If evidence is insufficient, return `inconclusive`; never infer approval from a completed review process. Evidence must use repository-relative paths and must not expose local absolute paths, usernames, home-directory names, hostnames, or machine-specific identifiers.
