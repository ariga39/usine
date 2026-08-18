# Usine agent constitution

This file is intentionally short and authoritative. It applies to every agent working in this repository.

## Mandatory context bootstrap

Before planning, editing, reviewing, or delegating work:

1. Read this file completely.
2. Read `docs/DESIGN.md`, `docs/DEVELOPMENT.md`, and `docs/DECISIONS.md` completely.
3. When acting as the primary development orchestrator, read the distilled operating guide at `docs/agent-software-factory/codex-unattended-development-harness.md` completely. It selectively retains useful harness constraints and never overrides the canonical files. Implementers and reviewers read their assigned task file instead.
4. Read the active GitHub Issue and, when present, its PR and unresolved review threads.
5. Inspect the current branch, base SHA, working tree, and diff.
6. Identify any active route falsifier, the highest eligible task class, the active behavior cluster and its design owner. Restate why the proposed work is eligible before acting.

Repeat these six steps after context compaction, session replacement, handoff, or any user correction that changes direction. A summary from an earlier context is navigation aid, not authority. If repository state and a summary disagree, repository state wins and the discrepancy must be reported.

## Product guardrails

- Optimize for valid, valuable, reviewed delivery outcomes per unit of human attention, time, and model cost. Commits, tests, task documents, agent turns, and PR count alone are not progress.
- Build the shortest end-to-end behavior that changes the user's experience. Do not let local hardening, framework work, or documentation replace the autonomous delivery loop.
- The deterministic coordinator owns authority and lifecycle state. LLMs perform bounded semantic work; their prose, exit status, and hooks are evidence, never completion authority.
- Preserve one active writer per repository, isolated writable workspaces, immutable candidate SHAs, independent exact-SHA review, and credential separation.
- Prefer mature libraries and platform primitives. Custom infrastructure requires evidence that an existing dependency cannot satisfy the need.
- Lightweight bounded semantic transforms (classification, extraction, normalization, and short summaries) call a configured schema-constrained OpenAI-compatible API directly; do not route them through Herdr, Codex, or OpenCode agent runtimes unless repository, tool, or session capabilities are actually required.
- Module quality is part of the outcome. A boundary must hide policy, reduce caller knowledge, or concentrate future change; package count, file count, line count, test count, and mechanical equivalence are not architecture evidence.
- Add architecture only when a current requirement crosses an existing boundary. Deferred ideas re-enter through an observed trigger and a new decision, not speculative placeholders.

## Development guardrails

- No implementation work without a GitHub Issue, an isolated branch/worktree, and an explicit PR-sized outcome. The empty-repository bootstrap commit is the sole exception.
- One completed task produces one PR, but a product milestone may span many tasks/PRs. Each Issue must authorize the smallest coherent module behavior or user-observable behavior that is independently useful, testable, and revertible; never interpret “complete vertical” as a requirement for one large PR.
- The current `correct_before_expansion` checkpoint permits exactly one full-refactor implementation task. Until representative executable code task plus induced live coordinator restart recovery evidence exists, no second implementation task may be active; afterward at most two may be active with independent ownership and non-overlapping writable surfaces.
- Substantive delegated instructions live in a temporary `.tasks/<issue>-<role>.md` file and must name the early draft checkpoint, merge gate, active falsifier status, and behavior-cluster owner. Command-line prompts only point to that file. `.tasks/` is never design authority.
- Use test-first development for stable contracts, invariants, and bug reproductions. For uncertain integrations, establish the thinnest observable vertical behavior first and add tests around the behavior; do not pre-specify internals through hundreds of seam tests.
- Review the diff against the Issue and canonical design. After fixes, request a delta review. New non-blocking concerns become separate Issues instead of extending the current PR indefinitely.
- Do not commit secrets, tokens, private keys, generated agent transcripts, local checkpoints, or historical clean-room archives.
- Never put local absolute paths, usernames, home-directory names, hostnames, or other machine-specific identifiers in committed files or GitHub Issues, PRs, reviews, and comments. Use repository-relative paths or explicit placeholders. Local `.tasks/` files may contain paths required for execution, but they remain uncommitted and must be sanitized before any content is copied to GitHub.

## Completion discipline

- When an authorized active Issue has not reached its stopping condition, answer any interim status, confirmation, or clarification interruption and resume the next safe in-scope action in the same turn.
- For an authorized build, change, fix, or design-delivery task, continue making in-scope progress until the Issue's verifiable stopping condition is reached. A plan, summary, status report, local commit, passing subset of checks, or one agent turn is not completion.
- Commentary and checkpoints report progress; they do not terminate the task. After reporting, continue with the next safe in-scope action.
- Stop only when: the stated acceptance and delivery condition is verified; the user pauses/replaces the objective; or progress genuinely requires new authority, unavailable input, or an external state change that cannot be safely worked around.
- When blocked, exhaust safe in-scope diagnostics and alternatives, then record the exact blocker and required decision. Do not label difficult, slow, or partially complete work as blocked.
- Codex `/goal` is an optional internal persistence mechanism, not a prompt or approval the user must provide. If used, it must name one objective, its non-goals, evidence of progress, and a verifiable stopping condition; it never replaces the Issue, canonical documents, Git state, or these rules.

## Autonomous rapid iteration

- The user is not the routine supervisor. Authorized work does not wait for the user to send `/goal`, “continue,” review, merge, or next-task confirmation. The orchestrator owns continuation and only asks for a genuine product/authority decision, unavailable required input, or an irreversible external choice outside existing scope.
- Prefer small commits and small PRs that each move one observable outcome. Push and open a draft PR at the first checkable state; keep subsequent fix commits visible. Early green evidence authorizes publication, not merge.
- Merge only when the PR delivers its coherent module behavior or user-observable behavior and passes its applicable spec/correctness and design gates. Pure movement is mergeable only when it deletes an old seam, reduces interface knowledge, or demonstrably concentrates change locality. After the merge gate passes, merge and continue without a human approval queue.
- Process, compliance, planning, and review are tools, not outcomes. They may block early iteration only when they expose a concrete correctness, security/authority, destructive-action, or product-direction risk. Non-blocking concerns become later Issues.
- User corrections update canonical documents or the active Issue promptly. The user may inspect occasionally and redirect work, but is not required to supervise normal progress.

## Current route correction

- Issue #65's settled-without-observation falsifier remains active. Issue #76 selected a Codex SDK-backed `clean_implementation` around six deep modules; Herdr panes, prompt settlement, hooks, and rendered transcripts are not production completion authority.
- Classification is `correct_before_expansion`. Exactly one full-refactor implementation task may run serially, in one PR with small visible commits. Do not recreate the closed backlog, preserve transitional seams as separate PRs, add a second runtime/forge/lane, or build a custom agent runtime.
- The refactor must preserve a fresh GPT-5.6 Luna high/default-tier/no-fast implementer in an isolated workspace. It clears the falsifier only with a representative executable task and induced live coordinator restart during an active coding session; design, fixture-only evidence, file splitting, or green unit tests do not clear it.

## Independent direction audits

- The primary orchestrator may self-review a diff, but it may not certify its own overall direction. Mandatory direction checkpoints require a fresh agent/session that did not author or implement the work.
- Run a clean-room direction audit before accepting a new canonical design, after the first complete end-to-end autonomous delivery loop before scaling/generalizing it, and before materially expanding authority, runtime/forge count, distribution, or development concurrency.
- Also trigger an early audit when three consecutive PRs fail to advance a user-visible vertical outcome, canonical authorities conflict, repeated compaction makes the route unclear, or implementation repeatedly grows low-level infrastructure instead of product behavior.
- The audit must use a bounded evidence packet and must not inherit author chat or the historical task archive. It must actively challenge the selected mechanism and may cross current Issue non-goals to recommend deletion, replacement, `correct_before_expansion`, or `stop_and_redesign`. Code claims may be checked in a read-only checkout. Details and budget are defined in `docs/DEVELOPMENT.md`.
- A direction audit blocks expansion, not useful work on an already-safe path. Resolve blocking findings or record an explicit user decision before crossing the checkpoint; summaries and ordinary PR review cannot waive it.

## Task eligibility and design authority

- Dispatch priority is: active falsifier or safety/authority defect; accepted-outcome critical path; representative real task; measured bottleneck; cleanup or aesthetics. A lower class is ineligible while an unresolved higher class blocks the route.
- A local Issue, passing test, small diff, or non-goal cannot waive an active global falsifier. Clearing a falsifier requires the evidence named by the decision that activated it.
- Each active behavior cluster has one temporary design owner responsible for its module map, external interface, internal seams, test placement, deletion plan, and coherent PR slices. Ownership may transfer explicitly; it may not disappear between Issues.
- Run a separate design review when first implementing a behavior cluster, adding a package/interface, changing a falsified transport or lifecycle, modifying the same large file in three consecutive PRs, or finding the same policy in three places. It may cross local Issue non-goals to judge depth, locality, and replacement; spec/correctness review cannot substitute for it.

## Drift stop rule

Stop and re-read the canonical documents before continuing when any of these occurs:

- work no longer advances the Issue's user-visible outcome;
- a new package, service, table, abstraction, or generalized interface is proposed without a current caller;
- review repeatedly expands beyond the changed seam;
- a draft checkpoint is green locally but has not been pushed as a remote PR;
- an active falsifier exists but the selected task does not characterize, delete, replace, or repair it;
- a proposed merge relies on file shortening, physical movement, or test count without a coherent behavior or locality improvement;
- an agent spends substantial time planning without making an observable change;
- context has compacted and the current objective cannot be restated from durable artifacts.

When the existing design is insufficient, amend `docs/DECISIONS.md` in the same PR or open a separate design Issue. Do not resolve ambiguity by inventing an implicit architecture.
