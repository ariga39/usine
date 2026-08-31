# Issue 310 reviewer-profile pilot

## Purpose

Issue #310 is the parent pilot, with Issue #281 as its earlier pilot context. Issue #294 remains the Task behavior authority. This directory contains one [ordinary non-merge Task Contract](contract.json) for the bounded pilot; the contract authorizes delivery and grants no merge authority.

The hypothesis is that candidate reviewer `usine-reviewer-medium` can produce correctness evidence comparable to prior reviewer `usine-reviewer` while reducing bounded review cost or latency. This is a hypothesis only; the recorded bounded result leaves it untested.

## Profile context

The production pilot reviewer is `usine-reviewer-medium`. The prior baseline reviewer is `usine-reviewer` and remains reference evidence only. Both use `gpt-5.6-sol` through `sdk`; `high` versus `medium` reasoning is the only changed factor in that baseline comparison.

Prior public evidence is [`evaluations/308/report.json`](../../evaluations/308/report.json), recorded at merge `709fbf4718dea006349975681802577fdad5f93b`.

## Run bound and recovery

- Run one Task using only `usine-reviewer-medium`, with an initial candidate reviewer Role Run and at most one further candidate reviewer Role Run after an authorized repair. Baseline evidence remains [`evaluations/308/report.json`](../../evaluations/308/report.json).
- Keep correctness adjudication fresh and external, with a separate independent design/ownership adjudication. Neither agent prose nor a process result is completion evidence.
- Keep the Repository registration host-private. Change only `reviewerProfile`; do not publish or commit registration contents.
- Inspect Session Archive content only when an anomaly requires classification; archive content is not routine scoring evidence.
- After classification, restore the prior `reviewerProfile` unconditionally. Rollback covers approval, change requests, inconclusive outcomes, and classified failures.

## Recorded result

Task `issue-294-reviewer-pilot` reached terminal `blocked` with final Candidate `9df17dfd7ec0be41d823a9e10f70bb07852daba4`. The project check failed with exit 1; there were zero reviewer Role Runs, no delivery, and no retry authority.

### Bounded Role Run evidence

| Implementer activation | Effective identity | Elapsed | Tools | Input tokens | Output tokens | Archive | Candidate |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `usine-implementer`, `gpt-5.6-luna`, `high`, `sdk` | 918912 ms | 71 | 7854514 | 33230 | stored/complete | `d8152400017a32c647727ea22ab9568a4732bbc8` |
| 2 | same effective identity | 430900 ms | 37 | 3279365 | 12590 | stored/complete | `9df17dfd7ec0be41d823a9e10f70bb07852daba4` |

The candidate reviewer `usine-reviewer-medium` never ran. There is therefore no reviewer correctness, elapsed, usage, tool, or archive observation, and no external correctness/design adjudication was applicable.

Targeted local diagnosis found that offline dependency installation succeeded, but the host-private project-check sequence ran package tests before producing the required package build artifacts. The check then failed resolving the `@usine/coding-session` package entry.

Under Issue 310's predeclared classification, this result is falsifying because incomplete evidence prevented safe attribution. It falsifies the pilot plan's ability to test the hypothesis, not the reviewer candidate's correctness or efficiency. The hypothesis remains untested; any rerun requires a fresh Issue with corrected check order.

After terminal state, baseline registration was restored; only `reviewerProfile` had changed. No Session Archive or registration contents are published.

The contract and recovery rules follow the repository’s [design authority](../../docs/DESIGN.md), [development protocol](../../docs/DEVELOPMENT.md), and [agent quickstart](../../docs/AGENT_QUICKSTART.md).
