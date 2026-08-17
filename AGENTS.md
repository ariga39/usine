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
- One completed task produces one PR, but a product milestone may span many tasks/PRs. Each Issue must authorize the smallest independently useful, testable, and revertible outcome; never interpret “complete vertical” as a requirement for one large PR.
- At most two implementation tasks may be active under one orchestrator. They must have independent ownership and non-overlapping writable surfaces; otherwise serialize them.
- Substantive delegated instructions live in a temporary `.tasks/<issue>-<role>.md` file and must name `first_merge_checkpoint` plus its evidence. Command-line prompts only point to that file. `.tasks/` is never design authority.
- Use test-first development for stable contracts, invariants, and bug reproductions. For uncertain integrations, establish the thinnest observable vertical behavior first and add tests around the behavior; do not pre-specify internals through hundreds of seam tests.
- Review the diff against the Issue and canonical design. After fixes, request a delta review. New non-blocking concerns become separate Issues instead of extending the current PR indefinitely.
- Do not commit secrets, tokens, private keys, generated agent transcripts, local checkpoints, or historical clean-room archives.

## Completion discipline

- For an authorized build, change, fix, or design-delivery task, continue making in-scope progress until the Issue's verifiable stopping condition is reached. A plan, summary, status report, local commit, passing subset of checks, or one agent turn is not completion.
- Commentary and checkpoints report progress; they do not terminate the task. After reporting, continue with the next safe in-scope action.
- Stop only when: the stated acceptance and delivery condition is verified; the user pauses/replaces the objective; or progress genuinely requires new authority, unavailable input, or an external state change that cannot be safely worked around.
- When blocked, exhaust safe in-scope diagnostics and alternatives, then record the exact blocker and required decision. Do not label difficult, slow, or partially complete work as blocked.
- Codex `/goal` is an optional internal persistence mechanism, not a prompt or approval the user must provide. If used, it must name one objective, its non-goals, evidence of progress, and a verifiable stopping condition; it never replaces the Issue, canonical documents, Git state, or these rules.

## Autonomous rapid iteration

- The user is not the routine supervisor. Authorized work does not wait for the user to send `/goal`, “continue,” review, merge, or next-task confirmation. The orchestrator owns continuation and only asks for a genuine product/authority decision, unavailable required input, or an irreversible external choice outside existing scope.
- Prefer small commits and small PRs that each move one observable outcome. Push and open a draft PR at the first checkable state; keep subsequent fix commits visible. After scoped checks and fresh semantic review pass, merge and continue to the next authorized Issue without a human approval queue.
- The first merge checkpoint dominates later acceptance. Once its scoped evidence is green, stop implementing adjacent seams or later failure modes, push/merge that checkpoint, and continue the larger milestone through a new Issue. A local green checkpoint without a remote PR is a drift condition, not progress.
- Process, compliance, planning, and review are tools, not outcomes. They may block early iteration only when they expose a concrete correctness, security/authority, destructive-action, or product-direction risk. Non-blocking concerns become later Issues.
- User corrections update canonical documents or the active Issue promptly. The user may inspect occasionally and redirect work, but is not required to supervise normal progress.
- Every implementation Issue starts a newly created Herdr pane and a new Codex agent using `-p usine-implementer` (GPT-5.6 Luna high, `service_tier = "default"`, no fast). Never reuse an implementer agent across Issues; release only the agent/pane created for that Issue after its merge checkpoint lands. Fresh semantic review uses Sol, and bounded read-only research may use Terra. Direct `codex exec -p usine-implementer` is allowed only when Herdr itself is unavailable; authentication, permission, model, or profile failures must not bypass this route.

## Independent direction audits

- The primary orchestrator may self-review a diff, but it may not certify its own overall direction. Mandatory direction checkpoints require a fresh agent/session that did not author or implement the work.
- Run a clean-room direction audit before accepting a new canonical design, after the first complete end-to-end autonomous delivery loop before scaling/generalizing it, and before materially expanding authority, runtime/forge count, distribution, or development concurrency.
- Also trigger an early audit when three consecutive PRs fail to advance a user-visible vertical outcome, canonical authorities conflict, repeated compaction makes the route unclear, or implementation repeatedly grows low-level infrastructure instead of product behavior.
- The audit must use a bounded evidence packet and must not inherit author chat or the historical task archive. Code claims may be checked in a read-only checkout. Details and budget are defined in `docs/DEVELOPMENT.md`.
- A direction audit blocks expansion, not useful work on an already-safe path. Resolve blocking findings or record an explicit user decision before crossing the checkpoint; summaries and ordinary PR review cannot waive it.

## Drift stop rule

Stop and re-read the canonical documents before continuing when any of these occurs:

- work no longer advances the Issue's user-visible outcome;
- a new package, service, table, abstraction, or generalized interface is proposed without a current caller;
- review repeatedly expands beyond the changed seam;
- a first merge checkpoint is green locally but has not been pushed as a remote PR;
- an agent spends substantial time planning without making an observable change;
- context has compacted and the current objective cannot be restated from durable artifacts.

When the existing design is insufficient, amend `docs/DECISIONS.md` in the same PR or open a separate design Issue. Do not resolve ambiguity by inventing an implicit architecture.
