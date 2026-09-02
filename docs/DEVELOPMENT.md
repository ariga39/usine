---
status: current
updated: 2026-08-24
issue: https://github.com/ariga39/usine/issues/267
---

# Developing Usine

This document governs development of the Usine repository. It does not define how the Usine product coordinates a user's repository. Product behavior belongs in [DESIGN](DESIGN.md), durable technical choices belong in [DECISIONS](DECISIONS.md), and product operation belongs in the [agent quickstart](AGENT_QUICKSTART.md).

## 1. Authority and context recovery

`AGENTS.md`, `DESIGN.md`, this document, and `DECISIONS.md` are the canonical repository authorities. README is an entry point. Skills are on-demand methods. An Issue and its PR authorize one concrete outcome, but cannot silently override the canonical design.

At the start of a session, after compaction or handoff, after user correction, and after switching an Issue or worktree:

```text
read AGENTS + active Issue/PR + unresolved review threads
        ↓
inspect branch + base SHA + status + complete diff
        ↓
read the canonical sections relevant to the behavior
        ↓
identify owner + active falsifier + next observable outcome
```

Read an entire canonical document when its authority, direction, or architecture is in question. Otherwise, keep recovery proportional. Git, GitHub, and canonical files outrank summaries, handoffs, and agent claims.

A `PostCompact` hook may remind an agent to repeat this bootstrap. It must not edit files, summarize the design, or become correctness authority. A temporary ignored `.tasks/HANDOFF.md` may record the active Issue/PR, branch/base/head, verified facts, unfinished outcome, active falsifier, blocker, and next action. Durable decisions belong in canonical documents or the Issue.

Four controls survive every context replacement:

- do not prescribe an unknown seam before evidence establishes it;
- a vertical slice is not an exemption for a monolith;
- the active falsifier determines which work is eligible;
- small PRs, green tests, file counts, and commit counts are evidence, not outcomes.

Provider names, credentials, endpoints, model identifiers, service tiers, context-window sizes, and machine-specific configuration are local operating facts. Keep them out of repository and GitHub surfaces.

## 2. Issue, branch, worktree, and PR

Except for an empty repository's root commit, do not develop directly on `main`.

1. Create one Issue with an observable outcome, scope, non-goals, acceptance evidence, draft checkpoint, merge gate, and stopping condition. Use [write-behavior-task](../.agents/skills/write-behavior-task/SKILL.md).
2. Branch from current `main` as `agent/<issue>-<slug>`. Parallel work uses separate linked worktrees outside every existing package workspace so parent dependency resolution cannot capture the checkout.
3. Give the outcome owner every internal layer needed for coherence. Restrict writes only for a real permission, safety, external-authority, or independent-ownership boundary.
4. Commit and push the first checkable state. Open a focused draft PR immediately, then publish further small checkpoints on the same PR.
5. Converge implementation, checks, independent review, and fixes in that PR. A scoped green checkpoint is not the merge gate.
6. When the coherent outcome and every applicable gate pass, the orchestrator merges and continues to the next eligible task without routine user confirmation.

GitHub is the durable task record. An ignored `.tasks/*.md` file is only an execution projection. It may contain the Issue URL, exact base SHA, outcome, authority limits, active falsifier, owner, evidence, and stopping condition, but must not become a second task system.

Committed files and GitHub surfaces use repository-relative paths or explicit placeholders. Never publish secrets, private keys, local absolute paths, usernames, home-directory names, hostnames, transcripts, or other private machine details.

## 3. Ownership, delegation, and bounded parallelism

The primary orchestrator owns direction, task selection, repository-agent policy, integration, review, delivery, and continuation. Repository constitution, orchestration policy, and repo-local tools are maintained directly by that orchestrator rather than delegated as ordinary product implementation.

Every delegated repository session runs through Herdr while `HERDR_ENV=1`:

- implementation uses a fresh agent in an isolated writable checkout without delivery credentials;
- semantic review uses a fresh context over a read-only exact candidate without implementer chat;
- bounded research uses a fresh read-only context when independent evidence is valuable.

Herdr lifecycle state and agent prose are observations, never completion authority. Herdr's absence is a development-environment blocker; do not silently substitute another launcher. These rules govern development of this repository, not the product Coding Session described in `DESIGN.md`.

At most two repository implementation PRs may be active when their outcomes and writable surfaces are independent and their shared interfaces already exist on `main`. This is an attention fence, not a product capacity claim. Serialize work when one failure would force the other task to rewrite an unmerged foundation.

Status reports, routine questions, local commits, and green subsets do not end authorized work. Continue until acceptance is verified or a genuine product/authority decision, irreversible external choice, or required unavailable input prevents progress.

## 4. Eligibility, falsifiers, and design ownership

The work queue is ordered by evidence:

```text
active falsifier or safety/authority defect
> accepted-outcome critical path
> representative real task
> measured bottleneck
> cleanup or aesthetics
```

An unresolved higher-priority failure class makes lower-priority work ineligible. An Issue non-goal, local acceptance criterion, or green suite cannot conceal a repository-wide falsifier. Only the evidence named by the controlling decision can clear it.

Each active behavior cluster has a temporary design owner responsible for its module map, public interface, internal seams, interface-level tests, replacement/deletion plan, and change locality. Ownership may be handed off explicitly; it may not disappear between PRs.

Request an independent design review when a behavior cluster is first implemented, a package or public interface is added, the same large file is changed across three PRs, policy appears in three places, or a real falsifier changes transport or lifecycle. Design review evaluates seam depth, caller knowledge, change locality, and deletion. Exact-SHA correctness review evaluates the authorized behavior and regressions. Neither verdict substitutes for the other.

## 5. Library-first modules

Before writing a scheduler, queue, retry system, migration layer, ORM, GitHub authentication client, process runner, logger, schema validator, or test container:

1. check the relevant durable decision;
2. read the maintained library's current official documentation;
3. prove the thinnest path that covers the present behavior;
4. write only Usine-specific policy.

If custom infrastructure remains necessary, record the evaluated primitive, its concrete gap, and the deletion boundary of the custom code. Future flexibility alone is not evidence. A module earns its boundary by hiding complexity, stabilizing callers, or enabling genuinely independent work—not by increasing package count.

A new direct dependency is a repository decision: name its current caller and why an existing platform or selected dependency cannot own the behavior. Ordinary dependency resolution and updates observe the seven-day pnpm cooldown.

The current product package map and dependency direction are defined in [DESIGN](DESIGN.md#5-behavioral-packages-and-composition). Use [codebase-design](../.agents/skills/codebase-design/SKILL.md) before changing those boundaries and [find-simplifications](../.agents/skills/find-simplifications/SKILL.md) when a touched seam exposes removable machinery.

The root Vite+ workspace is the toolchain authority:

```sh
vp test run <test-file>
vp fmt --check
vp lint
vp check --no-fmt --no-lint
vp run --filter '@usine/cli...' build
corepack pnpm test
corepack pnpm check:links
```

Package-local Vite+ configuration owns packaging and focused tests. The root suite owns public seams. Do not add a second formatter, linter, build orchestrator, or task cache without a demonstrated gap.

## 6. Vertical slices and complexity budget

A PR should finish one behavior observable through a public entry point. Internal foundation work stands alone only when the next authorized slice immediately consumes it.

Prefer the smallest coherent PR, not the smallest diff. Split independently usable and reversible outcomes into serial Issues. Mechanical movement, shorter files, and additional packages are not outcomes unless they remove an old seam, reduce caller knowledge, or concentrate future change.

Publish the first green draft checkpoint, but merge only after the Issue's coherent behavior and applicable correctness/design gates pass. Stop expansion and narrow or document the choice when:

- an unauthorized second runtime, forge, database, sandbox, or distributed runner appears;
- a generic interface has no production caller;
- test volume grows while the end-to-end state does not advance;
- an active falsifier remains untouched;
- a reviewer expands beyond the deployment threat model without evidence;
- a fix needs a new task tree merely to explain it;
- prolonged reasoning produces no tool action, diff, test, or other observable progress.

## 7. Testing

Use test-first development for known contracts, domain policy, state invariants, and regressions. For uncertain third-party APIs, first build the thinnest smoke or characterization path, then lock only the behavior Usine depends on.

Prefer adapter fakes for subprocess, Git, database, and forge behavior, with a small number of real integrations. Test public behavior and authority boundaries rather than private functions, SQL text, migration catalogs, or hypothetical hostile fixtures. Once a deep interface covers the old behavior, delete tests that exist only to preserve its shallow implementation.

A green test is not proof of the user outcome, and review does not explain machine failures. Aggregate failing checks for the implementer; bind semantic verdicts to an immutable candidate SHA.

## 8. Review and clean-room direction audits

Give a reviewer the canonical documents, Issue, exact candidate diff, and relevant evidence—not author chat, old task trees, or the historical archive. The primary review checks the outcome, invariants, regression risk, and obvious omissions. After fixes, use one bounded delta review of the findings and changed surfaces. Only correctness, security, or authority blockers expand scope.

Run a fresh clean-room direction audit before a new canonical design is marked ready or merged, after the first complete task-to-reviewed-PR vertical slice and before capacity or merge-authority expansion, and whenever repeated non-delivery, competing authorities, or context loss makes the route uncertain.

The audit must actively challenge the route:

- Would the same design be chosen today from the user outcome?
- Has infrastructure or review process displaced that outcome?
- What is the cheapest credible alternative?
- What complexity can be deleted?
- What is the strongest argument against the route?
- What evidence would falsify it, and is that evidence present?
- What is the next shortest user-visible slice?

It classifies the result as `continue`, `correct_before_expansion`, or `stop_and_redesign`, and separates direction blockers, current-PR defects, and later concerns. Map every direction blocker to the current PR, a new Issue, or a required user decision. One focused delta audit is enough after corrections. Self-review, tests, and ordinary code review do not replace this checkpoint.

Use [review-change](../.agents/skills/review-change/SKILL.md) for exact-SHA acceptance and [pre-push-checks](../.agents/skills/pre-push-checks/SKILL.md) before publication.

## 9. Documentation lifecycle

Keep each fact under one authority:

- current product architecture and mechanics: `DESIGN.md`;
- durable choices, rationale, supersession, and re-entry conditions: `DECISIONS.md`;
- repository development protocol: this document and the short `AGENTS.md` entry point;
- product setup and operation by an agent: `AGENT_QUICKSTART.md`;
- product overview and navigation: `README.md`;
- one outcome: its Issue and PR;
- temporary prompts, checkpoints, and handoffs: ignored `.tasks/` files;
- reusable methods: `.agents/skills/`;
- raw research and benchmarks: temporary evidence attached only to the decision that needs it.

Do not preserve obsolete task trees or implementation diaries as active documentation. Documentation exists to reduce recovery cost and prevent authority drift; its value is not measured by page count.
