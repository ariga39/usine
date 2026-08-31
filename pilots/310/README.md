# Issue 310 reviewer-profile pilot

## Purpose

Issue #310 is the parent pilot, with Issue #281 as its earlier pilot context. Issue #294 remains the Task behavior authority. This directory contains one [ordinary non-merge Task Contract](contract.json) for the bounded pilot; the contract authorizes delivery and grants no merge authority.

The hypothesis is that candidate reviewer `usine-reviewer-medium` can produce correctness evidence comparable to prior reviewer `usine-reviewer` while reducing bounded review cost or latency. This is a hypothesis only; no result is claimed.

## Profile context

The production pilot reviewer is `usine-reviewer-medium`. The prior baseline reviewer is `usine-reviewer` and remains reference evidence only. Both use `gpt-5.6-sol` through `sdk`; `high` versus `medium` reasoning is the only changed factor in that baseline comparison.

Prior public evidence is [`evaluations/308/report.json`](../../evaluations/308/report.json), recorded at merge `709fbf4718dea006349975681802577fdad5f93b`.

## Run bound and recovery

- Run one Task using only `usine-reviewer-medium`, with an initial candidate reviewer Role Run and at most one further candidate reviewer Role Run after an authorized repair. Baseline evidence remains [`evaluations/308/report.json`](../../evaluations/308/report.json).
- Keep correctness adjudication fresh and external, with a separate independent design/ownership adjudication. Neither agent prose nor a process result is completion evidence.
- Keep the Repository registration host-private. Change only `reviewerProfile`; do not publish or commit registration contents.
- Inspect Session Archive content only when an anomaly requires classification; archive content is not routine scoring evidence.
- After classification, restore the prior `reviewerProfile` unconditionally. Rollback covers approval, change requests, inconclusive outcomes, and classified failures.

## Pre-run status

The pilot has not started. No reviewer result, recommendation, or quality claim is recorded or claimed.

The contract and recovery rules follow the repository’s [design authority](../../docs/DESIGN.md), [development protocol](../../docs/DEVELOPMENT.md), and [agent quickstart](../../docs/AGENT_QUICKSTART.md).
