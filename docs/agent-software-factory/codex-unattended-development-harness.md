# Usine unattended development guide

Status: distilled repository operating guide, not design authority
Updated: 2026-08-18

This guide retains only the external harness practices that reinforce Usine's current development rules. It does not import the source harness wholesale. `AGENTS.md`, the three canonical documents, the active GitHub Issue/PR, and exact Git state override it on conflict.

The harness is successful only when it preserves direction and helps ship coherent, maintainable behavior. Process conformance, green checks, review volume, and artifact count cannot compensate for a wrong route, shallow modules, or poor code. If operating the harness starts consuming attention without improving the current outcome or its design quality, stop the process expansion and return to the active Issue and canonical route.

## Recovery first

At every new session, compaction, handoff, direction correction, Issue change, or worktree change:

1. Read `AGENTS.md` and the three canonical documents completely.
2. Read this guide completely when acting as the primary orchestrator.
3. Read the active Issue, its PR, and unresolved review threads.
4. Inspect branch, base SHA, worktree status, complete diff, open worktrees, and active agents.
5. Restate the active falsifier, eligible task class, behavior cluster, design owner, and next observable action.

Resume an existing task or PR before selecting another. GitHub, Git, result artifacts, and host-observed facts outrank pane status, chat summaries, or agent claims.

## Select one eligible task

Use this priority:

```text
active falsifier or safety/authority defect
> accepted-outcome critical path
> representative real task
> measured bottleneck
> cleanup
```

Do not dispatch a lower-priority task while a higher-priority failure blocks the route. Do not treat file movement, line-count reduction, test count, or a new interface with no current caller as an outcome.

Each task needs one Issue, one isolated branch/worktree, one PR-sized coherent outcome, a temporary design owner, an early draft checkpoint, a merge gate, bounded writable scope, checks, and a stopping condition. Substantive worker instructions live in an uncommitted `.tasks/<issue>-<role>.md` file.

## Candidate evidence

An implementer completion claim is only evidence. The orchestrator verifies:

- a completion artifact exists;
- the worktree and full diff match the authorized scope;
- durable content contains no secret, transcript, local absolute path, username, home-directory name, hostname, or other machine-specific identifier;
- host-run checks pass;
- a commit freezes the exact candidate SHA.

After freezing the candidate, the implementer no longer writes it. Any modification creates a new SHA and invalidates prior checks and review.

Agent `idle`, `done`, prompt settlement, pane survival, process exit, hooks, and prose never grant completion authority. If an agent settles without an artifact or observable change, classify the attempt as incomplete and inspect the worktree and output before one bounded retry or route correction.

## Review and delivery

Use a fresh non-author reviewer with the complete read-only codebase, active Issue, canonical documents, base SHA, candidate SHA, exact diff, and check evidence. Do not give it implementer chat or self-justification.

The reviewer returns a schema-valid spec verdict. It returns a design verdict only when canonical triggers require one; otherwise `not_required`. Every verdict binds the exact candidate SHA. Blocking findings are aggregated into one fix activation; after a new commit, run a focused delta review or full review when the seam changed.

Push and open a draft PR at the first checkable state. Merge only after the coherent outcome, host checks, exact-SHA spec verdict, and any required design verdict pass. Then continue to the next eligible task without waiting for routine user supervision.

## Failure routing

- A real liveness, authority, data-loss, duplicate-effect, or infrastructure failure invalidates lower-priority cleanup even if a local Issue calls it a non-goal.
- A project check failure returns evidence to the implementer; a reviewer does not diagnose a broken pipeline.
- One evidence-backed retry is allowed for a stalled or incomplete agent. Repetition is a harness/route failure, not a reason for unlimited prompting.
- Repeated design findings trigger module redesign or route replacement, not more local patches.
- Status reports and compact boundaries do not terminate unfinished authorized work.

## Current route

The repository is classified `stop_and_redesign`. Issue #65 falsified the Herdr/transcript lifecycle route. Until the reviewed module and salvage/rewrite decision in Issue #76 merges:

- do not start product implementation;
- do not select a replacement launcher or transport;
- do not perform cleanup, package/file movement, concurrency, or authority expansion;
- preserve the future worker policy of a fresh Luna/high/default-tier/no-fast worker in an isolated workspace without treating any launcher as preselected.

Issue #76 must define the minimum coordinator-to-worker contract and the exact representative evidence required to clear the active falsifier. Completing design alone does not clear it.
