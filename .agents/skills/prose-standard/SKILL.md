---
name: prose-standard
description: Use when changing Usine documentation, comments, prompts, diagnostics, task text, or other user-visible prose.
---

# Prose standard

Write for the next agent or operator recovering from durable repository facts. Keep the text concise, concrete, and repository-relative.

- State the behavior, owner, constraint, or action first; remove reasoning transcripts, review narration, historical route retellings, and obvious implementation commentary.
- Keep one authority per rule. Link to [DESIGN](../../../docs/DESIGN.md), [DEVELOPMENT](../../../docs/DEVELOPMENT.md), or [DECISIONS](../../../docs/DECISIONS.md) instead of duplicating canonical policy.
- Use precise names for exact-SHA evidence, fresh reviewer context, isolated workspaces, credential separation, and deterministic authority. Do not imply that agent prose, process state, hooks, transcripts, tests, or file counts prove completion.
- Use repository-relative Markdown links and paths. Never write local absolute paths, usernames, home directories, hostnames, secrets, private data, or generated transcripts into committed or GitHub-facing text.
- Preserve active contracts and rationale while deleting stale compatibility promises, speculative interfaces, and generic style catalogs.

Run `corepack pnpm format:check` and `git diff --check`; verify each new local link exists from its containing file. If prose changes encode a design or lifecycle decision, update the canonical document in an authorized Issue rather than hiding authority in a skill or prompt.
