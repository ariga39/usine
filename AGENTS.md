# Usine agent constitution

This file is intentionally short and authoritative. It applies to every agent working in this repository.

## Mandatory context bootstrap

Before planning, editing, reviewing, or delegating work:

1. Read this file completely.
2. Read `docs/DESIGN.md`, `docs/DEVELOPMENT.md`, and `docs/DECISIONS.md` completely.
3. Read the active GitHub Issue and, when present, its PR and unresolved review threads.
4. Inspect the current branch, base SHA, working tree, and diff.

Repeat these four steps after context compaction, session replacement, handoff, or any user correction that changes direction. A summary from an earlier context is navigation aid, not authority. If repository state and a summary disagree, repository state wins and the discrepancy must be reported.

## Product guardrails

- Optimize for valid, valuable, reviewed delivery outcomes per unit of human attention, time, and model cost. Commits, tests, task documents, agent turns, and PR count alone are not progress.
- Build the shortest end-to-end behavior that changes the user's experience. Do not let local hardening, framework work, or documentation replace the autonomous delivery loop.
- The deterministic coordinator owns authority and lifecycle state. LLMs perform bounded semantic work; their prose, exit status, and hooks are evidence, never completion authority.
- Preserve one active writer per repository, isolated writable workspaces, immutable candidate SHAs, independent exact-SHA review, and credential separation.
- Prefer mature libraries and platform primitives. Custom infrastructure requires evidence that an existing dependency cannot satisfy the need.
- Add architecture only when a current requirement crosses an existing boundary. Deferred ideas re-enter through an observed trigger and a new decision, not speculative placeholders.

## Development guardrails

- No implementation work without a GitHub Issue, an isolated branch/worktree, and an explicit PR-sized outcome. The empty-repository bootstrap commit is the sole exception.
- One completed task produces one PR. Do not combine unrelated work or silently modify another task's files.
- At most two implementation tasks may be active under one orchestrator. They must have independent ownership and non-overlapping writable surfaces; otherwise serialize them.
- Substantive delegated instructions live in a temporary `.tasks/<issue>-<role>.md` file. Command-line prompts only point to that file. `.tasks/` is never design authority.
- Use test-first development for stable contracts, invariants, and bug reproductions. For uncertain integrations, establish the thinnest observable vertical behavior first and add tests around the behavior; do not pre-specify internals through hundreds of seam tests.
- Review the diff against the Issue and canonical design. After fixes, request a delta review. New non-blocking concerns become separate Issues instead of extending the current PR indefinitely.
- Do not commit secrets, tokens, private keys, generated agent transcripts, local checkpoints, or historical clean-room archives.

## Drift stop rule

Stop and re-read the canonical documents before continuing when any of these occurs:

- work no longer advances the Issue's user-visible outcome;
- a new package, service, table, abstraction, or generalized interface is proposed without a current caller;
- review repeatedly expands beyond the changed seam;
- an agent spends substantial time planning without making an observable change;
- context has compacted and the current objective cannot be restated from durable artifacts.

When the existing design is insufficient, amend `docs/DECISIONS.md` in the same PR or open a separate design Issue. Do not resolve ambiguity by inventing an implicit architecture.
