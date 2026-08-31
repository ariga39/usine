# Issue 287 reviewer evaluation plan

This committed plan compares `usine-reviewer` (`gpt-5.6-sol`, reasoning `high`) with `usine-reviewer-medium` (`gpt-5.6-sol`, reasoning `medium`). Reasoning is the only changed factor; the exact Usine build, Task Contract, Candidate cases, checks, labels, and review budget stay fixed. The evaluation has four case entries—clean and protected defective Candidates, each repeated twice—and permits at most eight reviewer runs.

The clean Candidate is externally labelled `approved`; the protected defective Candidate is labelled `changes_requested` because the strict typecheck found four TS18048 errors later fixed by the clean Candidate. The labels reference PR #302 exact-SHA evidence. Both reviewer arms receive identical committed evidence through the [schema-version-1 evaluator](../../docs/AGENT_QUICKSTART.md#controlled-reviewer-profile-evaluation).

The evaluator did not execute delivery or merge. Registration remains host-private; no local path or Session Archive content belongs in this repository.

## Observed result

Recommendation: `inconclusive`; neither reviewer profile is eligible for Issue #280.

Both effective arms used `gpt-5.6-sol` through `sdk`; the baseline used reasoning `high` and the candidate used reasoning `medium`. This experimental identity is retained as attribution evidence.

- Baseline (`high`): the clean Candidate was `changes_requested` in both repetitions. The protected defective Candidate was `inconclusive` because of transport/partial-archive evidence once, then correctly `changes_requested` once. Aggregate elapsed time was 1,907,150 ms with 6 tool failures. Token and correctness comparisons remain `null` because required data is missing.
- Candidate (`medium`): the clean Candidate was `changes_requested` once and `inconclusive` once because of transport/partial-archive evidence. The protected defective Candidate was correctly `changes_requested` in both repetitions. Aggregate elapsed time was 529,817 ms with 1 tool failure. Token and correctness comparisons remain `null` because required data is missing.

No observed run approved the protected defective Candidate. The report's aggregate `falseApprovals` fields remain `null`; this is not a numeric false-approval result.

## Diagnostic summary

Two host-local manifest inspections confirmed that the partial archives were transport failures, not truncation. Other inspected archives were complete, stored, and warning-free.

A complete clean-disagreement archive was diagnostically useful without publishing its contents: multiple reviewers independently surfaced a symlink-confinement concern. Primary adjudication confirmed that lexical-only input/report path handling can follow symlinks outside the evaluation Repository. Another archive showed that partial archive evidence can mask a protected false approval; retention also permits 200 runs with only 100 default live archives and no final manifest revalidation.

One archived finding asked to redact model identity. That finding was rejected: the repository-development rule about local agent/provider configuration does not override this controlled experiment's requirement to retain effective model identity as attribution evidence.

The manual burden actually observed was one committed plan/profile setup, eight serial runs without between-run intervention, two transport-partial archives, manifest inspection, and bounded manual adjudication. No Task, Candidate, delivery, event, or production mutation occurred.
