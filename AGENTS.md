# Usine repository guide

## Project

Usine is a TypeScript/Node coordinator and CLI that moves an authorized development task through isolated implementation, project checks, independent exact-SHA review, and credential-scoped GitHub delivery. Durable facts—not agent prose, hooks, or process state—decide lifecycle and completion.

The design authorities are [DESIGN](docs/DESIGN.md), [DEVELOPMENT](docs/DEVELOPMENT.md), and [DECISIONS](docs/DECISIONS.md). GitHub Issues authorize individual outcomes. Repo skills under `.agents/skills/` are on-demand methods, never competing authority.

To operate Usine for an authorized project task, use [the agent quickstart](docs/AGENT_QUICKSTART.md). To develop Usine itself, follow this bootstrap and [DEVELOPMENT](docs/DEVELOPMENT.md).

## Start work

Read the active Issue, its PR and unresolved review threads, then inspect the branch, base SHA, status, and complete diff. Read the canonical sections relevant to the behavior and identify its owner, active falsifier, and next observable outcome before editing. Repeat after compaction, handoff, worktree/Issue changes, or user direction corrections. Repository and GitHub facts override summaries and agent claims.

One outcome owns one Issue, isolated branch/worktree, and coherent PR. Place linked worktrees outside every existing package workspace so the parent workspace cannot capture tool or dependency resolution. Use [write-behavior-task](.agents/skills/write-behavior-task/SKILL.md) to frame work by observable behavior, authority, evidence, and stopping condition—not by file, function, or layer checklists. The outcome owner may revise every internal layer needed for coherence unless a real permission, safety, or independent-ownership boundary forbids it.

Publish the first checkable state as a small commit and draft PR; continue visible checkpoint commits until the Issue gate passes. Green commands and a PR are evidence, not completion.

## Ownership and roles

The primary orchestrator owns direction, task selection, repository-agent policy, integration, review, delivery, and continuation. It launches every delegated repository implementer and reviewer through Herdr: verify `HERDR_ENV=1`, then use Herdr to start, prompt, inspect, and wait for the agent. Do not substitute native/internal subagent APIs; if Herdr is unavailable, report the development-environment blocker.

Every delegated implementation worker is a leaf writer. It begins the authorized repository work directly and does not launch another implementer or reviewer unless the primary explicitly delegates orchestration authority.

Repository product-code implementation uses a fresh worker in an isolated writable workspace. Exact-SHA review uses a fresh context with a read-only candidate and no implementer chat. These are repository-development isolation rules, not Usine product runtime rules: product Coding Session remains defined by the canonical design. Herdr lifecycle state and agent prose are evidence, never completion authority.

Continue through the authorized stopping condition; a plan, local commit, green subset, status report, or tool-success message is not completion. Decide reversible implementation details without asking. Stop only for missing product intent or authority, unavailable required input, an irreversible external choice, or verified acceptance.

Keep one writer per repository, isolated workspaces, immutable candidate SHAs, independent exact-SHA evidence, and credential separation. Never put secrets, private keys, transcripts, usernames, hostnames, local absolute paths, or other machine-specific/private data in committed or GitHub-facing surfaces.

## Commands

```sh
vp test run <test-file>
vp fmt --check
vp lint
vp check --no-fmt --no-lint
vp run --filter '@usine/cli...' build
corepack pnpm test
corepack pnpm check:links
```

Use [codebase-design](.agents/skills/codebase-design/SKILL.md) for boundaries and ownership, [find-simplifications](.agents/skills/find-simplifications/SKILL.md) for deletion or replacement, [prose-standard](.agents/skills/prose-standard/SKILL.md) for visible text, [pre-push-checks](.agents/skills/pre-push-checks/SKILL.md) before publication, and [review-change](.agents/skills/review-change/SKILL.md) in a fresh context before acceptance.

## Effect

This repository uses Effect. Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its linked guidance when relevant. Search `node_modules/effect/src` when the guide does not cover an API or concept.
