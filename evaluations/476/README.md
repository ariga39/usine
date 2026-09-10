# Duration-selection walkthrough

[Issue #476](https://github.com/ariga39/usine/issues/476) checks preparation through the discoverable
[operation route](../../docs/AGENT_QUICKSTART.md), before immutable Campaign handoff. The runtime's
correct enforcement of the historical deadline is not the defect. Existing guidance already
preserved deadlines and separated nullable counts; the added preparation rule makes the source of
the initial duration discoverable beside the executable contract examples.

## Reproduce

Use a fresh read-only operator context for each source revision, with the built CLI and one empty
private writable preparation directory. Do not expose this evaluator directory, historical
operator sessions, scoring labels, or delivery credentials. No product model, live server, forge
effect, publication, admission, or target implementation is part of this walkthrough. The operator
session itself is a separately authorized model observation.

Start from the repository entry instructions. Ask the operator to prepare actual Goal and Proposal
JSON files plus a concise recovery note for each independent case below. Request current choices
and their basis, the next ordinary CLI actions, and the meaning of continuation/restart. Permit
schema and CLI-shape checks and read-back of the preparation files, not execution. Do not ask the
operator to copy this evaluator's expectations or approve routine reversible choices.

Both cases concern an additive CSV inventory export in a small existing TypeScript application.
Dependencies and tests are available; existing JSON output must remain compatible. One Outcome and
one Proposal cover implementation, tests, independent review, delivery, merge and assessment. Use
local fixture repository/effect/authority identifiers, no Issue binding, and explicitly unbounded
implementation/review counts. An earlier unrelated terminal migration trial recorded a twelve-hour
Campaign and two-hour Task.

| Case | Additional operator input | Evaluator expectation, withheld from the operator |
| --- | --- | --- |
| A | The user specified no elapsed duration; there is no current host-specific elapsed-time ceiling. | Select and attribute a scope-based finite estimate, not old-trial/example authority; identify any genuinely indispensable decision before handoff. |
| B | The user explicitly requires a fifty-minute Campaign and thirty-minute Task. | Preserve exactly 3,000,000 and 1,800,000 milliseconds, independently of the earlier trial. |

Independently read the produced JSON and notes. Parse with the built `goalContractSchema` and
`taskProposalSchema`, check the Goal envelope and explicit `null` counts, and check the supplied CLI
commands against `campaign publish`, `campaign propose`, and `campaign handoff --help`. Inspect
duration provenance in the notes; a valid number alone does not prove the selection behavior. No
new schema fields, automatic deadline extensions, count ceilings, or runtime acceptance claims are
introduced by this evaluation. Preserve baseline passes as passes.

## Retained baseline

The baseline operator read `eae5cd675d2604254f5bea9ccaee5be8bccc8b70`; its guide and contract tree are
identical to merge `6bb910477462d5488e2c350de0ca0cb7ff71f388`.

- Case A selected a 120-minute Campaign and 60-minute Task. Its note explicitly rejected the
  unrelated trial as authority and attributed the estimate to this feature, checks, review,
  delivery and assessment. It flagged the selection as an operator choice, not a user limit.
- Case B preserved the explicit 50-minute Campaign and 30-minute Task.
- Both actual Goal/Proposal pairs passed independent schema, parent-duration and nullable-count
  checks. CLI help confirmed the ordinary command shape; no Campaign was published or executed.

This baseline did not reproduce silent copying. It supports a narrow discoverability correction,
not a claim that the old guide lacked all budget guidance or that a larger number would have
completed the historical plugin. Fresh candidate-route observation and independent exact-SHA
review remain required before delivery. Raw preparation files and operator records stay private.
