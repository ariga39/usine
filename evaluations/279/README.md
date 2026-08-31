# Issue 279 controlled implementer evaluation

This plan holds the Usine build, exact base, Task semantics, project check, reviewer profile, budgets, adapter, model, service tier, and delivery authority fixed. The only implementer factor is reasoning effort: the baseline uses `high` and the candidate uses `medium`.

The falsifiable hypothesis is that medium reasoning preserves accepted exact-SHA delivery for this focused correction without increasing activations, repair batches, interruptions, elapsed time, tokens, or tool failures. The candidate is ineligible if either repetition fails the correctness gate or if required evidence is unavailable.

The four Tasks are evaluation-only; any resulting PRs must remain unmerged. The generated [report](report.json) uses public Task Evidence; Session Archive content remains host-local and is inspected separately only for diagnostic usefulness.

## Observed result

The evaluation is inconclusive. All four implementer runs produced a Candidate, but every exact-SHA project check failed before review or delivery. The report therefore marks both profiles as failed, leaves the efficiency comparison unknown, and does not treat the candidate's lower raw elapsed, token, and tool-failure totals as a win. Per-run raw values remain available, but accepted outcomes and reviewer evidence are missing, so their variance is not comparable.

The run required no retries, repair batches, interruptions, or operator intervention between the four serial Tasks. Setup required the committed plan and contracts, four Task Issues, one host-private candidate profile, and one evaluator/server run. Completion required one host-local archive inspection and one fresh-checkout diagnostic replay; Repository registration was restored automatically.

The host-local inspection found a complete, untruncated archive with no capture warnings. Its retained iteration evidence supported a diagnostic hypothesis without publishing archive content: the new identity-projection coverage supplied an unprojected expected provider identity and classified the matching case as unknown. A fresh-checkout replay reproduced that failure, but this diagnostic is not Task authority. No implementer candidate from this plan is eligible for the next improvement stage.
