# Implementer Task: <outcome>

## Identity

- Issue/task: `<id>`
- Base SHA: `<40-char SHA>`
- Writable worktree: `<absolute path>`
- Capability cluster: `<cluster>`
- Active falsifier status: `<status and eligibility effect>`
- Behavior-cluster design owner: `<owner>`
- Draft checkpoint: `<first checkable state to commit and push>`
- Merge gate: `<coherent outcome and required verdicts>`
- Completion artifact: `.tasks/results/<id>-implementation.json`

## Outcome

Describe one observable behavior or one complete old-seam replacement. Do not describe file-count reduction as the outcome.

## Acceptance

- `<observable condition>`
- `<observable condition>`
- Required checks: `<commands>`

## Invariants

- Preserve `<authority/safety/domain invariant>`.
- Do not widen credentials, network, repository or product scope.
- Do not create adjacent tasks or implement non-goals.

## Module context

- Existing accepted interface, if any: `<interface or none>`
- Complexity this module must hide: `<facts callers should not learn>`
- Old seam/code that must be deleted if this is a replacement: `<paths or none>`

Internal file layout is not prescribed. You may reshape implementation inside the authorized cluster when it improves locality and keeps the external interface small.

## Writable scope

- `<paths/modules>`

Stop and report a conflict before modifying another task's worktree or unrelated capability cluster.

## Non-goals

- `<product scope exclusion>`
- Pure code movement, one-function-per-file splitting, or a new package without hidden behavior.

## Execution

1. Inspect the relevant code and tests before editing.
2. Implement the smallest coherent outcome, not the smallest diff.
3. Test through the module/public behavior; do not lock tests to internal structure.
4. Run the required checks.
5. Sanitize any durable output: never copy local absolute paths, usernames, home-directory names, hostnames, or machine identifiers into committed files or GitHub surfaces.
6. Write the completion artifact below. Do not claim completion only in chat.

## Completion artifact

Write valid JSON to `.tasks/results/<id>-implementation.json`:

```json
{
  "status": "candidate",
  "summary": "",
  "changedFiles": [],
  "checks": [{ "command": "", "exitCode": 0 }],
  "designImpact": "none",
  "assumptions": [],
  "blocker": null
}
```

Use `status: "blocked"` with an exact blocker when new authority/input is genuinely required. The orchestrator will independently verify Git and checks; this artifact is a handoff, not completion authority.
