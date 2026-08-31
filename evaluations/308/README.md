# Issue 308 corrected reviewer evaluation plan

This committed plan compares `usine-reviewer` with `usine-reviewer-medium`; reasoning is the only changed factor. The evaluation is bound to Usine build `950c92a9afab3a387464b0db8ccea77892fb1977`, base `9ef4c933c1637443078add2162e88fca06f36e6c`, and the same committed Task Contract, check evidence, and external labels for both profiles.

The clean Candidate `8c09caf62174c0ea01c7cc93bbaf8be473d39a43` is repeated twice and is externally expected `approved`, referenced to [PR #307](https://github.com/ariga39/usine/pull/307) exact-SHA correctness/security plus design/ownership approvals. The protected defective Candidate `9ef4c933c1637443078add2162e88fca06f36e6c` is repeated twice and is externally expected `changes_requested` because it still forces host-private reviewer registration through committed evidence, the outcome fixed by [Issue #306](https://github.com/ariga39/usine/issues/306) and PR #307.

Both check records are passing `git diff --check 9ef4c933c1637443078add2162e88fca06f36e6c...HEAD` evidence bound to their matching exact Candidate SHA. The non-merge Task Contract is authorized by Issue #306; `authorization.delivery` remains true only because the Task Contract schema requires it. The evaluator does not execute delivery or merge.

The evaluator permits at most eight serial reviewer runs. Registration is resolved from the ignored host-private `../../.tasks/308-registration.json`; it is not committed, and its host-specific contents remain private. No result exists yet: no provider session has been run and `report.json` is intentionally absent.
