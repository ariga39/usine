# Issue 287 reviewer evaluation plan

This committed plan compares `usine-reviewer` (`gpt-5.6-sol`, reasoning `high`) with `usine-reviewer-medium` (`gpt-5.6-sol`, reasoning `medium`). Reasoning is the only changed factor; the exact Usine build, Task Contract, Candidate cases, checks, labels, and review budget stay fixed. The evaluation has four case entries—clean and protected defective Candidates, each repeated twice—and permits at most eight reviewer runs.

The clean Candidate is externally labelled `approved`; the protected defective Candidate is labelled `changes_requested` because the strict typecheck found four TS18048 errors later fixed by the clean Candidate. The labels reference PR #302 exact-SHA evidence. Both reviewer arms receive identical committed evidence through the [schema-version-1 evaluator](../../docs/AGENT_QUICKSTART.md#controlled-reviewer-profile-evaluation).

The report at `evaluations/287/report.json` is reserved for the real evaluator and is intentionally absent. The evaluator must not execute delivery or merge. Registration remains host-private at the plan's `.tasks` path; no local path or Session Archive content belongs in this repository.
