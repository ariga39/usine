# Issue 308 corrected reviewer evaluation plan

This committed plan compares `usine-reviewer` with `usine-reviewer-medium`; reasoning is the only changed factor. Both arms used `gpt-5.6-sol` through `sdk`, with `high` versus `medium` reasoning. The evaluation is bound to Usine build `950c92a9afab3a387464b0db8ccea77892fb1977`, base `9ef4c933c1637443078add2162e88fca06f36e6c`, and the same committed Task Contract, check evidence, and external labels for both profiles.

The clean Candidate `8c09caf62174c0ea01c7cc93bbaf8be473d39a43` is repeated twice and is externally expected `approved`, referenced to [PR #307](https://github.com/ariga39/usine/pull/307) exact-SHA correctness/security plus design/ownership approvals. The protected defective Candidate `9ef4c933c1637443078add2162e88fca06f36e6c` is repeated twice and is externally expected `changes_requested` because it still forces host-private reviewer registration through committed evidence, the outcome fixed by [Issue #306](https://github.com/ariga39/usine/issues/306) and PR #307.

Both check records are passing `git diff --check 9ef4c933c1637443078add2162e88fca06f36e6c...HEAD` evidence bound to their matching exact Candidate SHA. The non-merge Task Contract is authorized by Issue #306; `authorization.delivery` remains true only because the Task Contract schema requires it. The evaluator does not execute delivery or merge.

The evaluator permits at most eight serial reviewer runs. Registration is resolved from the ignored host-private `../../.tasks/308-registration.json`; it is not committed, and its host-specific contents remain private.

## Observed proof

The completed report records eight current archives, all `stored` and `complete`. Each arm correctly approved the clean Candidate `8c09caf62174c0ea01c7cc93bbaf8be473d39a43` twice and requested changes on the protected defective Candidate `9ef4c933c1637443078add2162e88fca06f36e6c` twice. Each arm therefore has 4 correct verdicts, 0 false approvals, 0 false changes requested, 0 inconclusive runs, and 0 hard regressions.

Baseline metrics are 895793 ms, 1812216 input tokens, 19343 output tokens, and 7 tool failures. Candidate metrics are 703366 ms, 1465620 input tokens, 15244 output tokens, and 2 tool failures. The candidate-minus-baseline delta is -192427 ms, -346596 input tokens, -4099 output tokens, and -5 tool failures.

The recommendation is `candidate`, with no inconclusive reasons. `usine-reviewer-medium` is eligible for Issue #280 classification; this result does not change production registration.
