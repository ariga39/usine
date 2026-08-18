---
name: review-change
description: Use in a fresh context before accepting an implementation or documentation change for an Usine PR.
---

# Review change

Review the exact candidate, not the author's explanation. Read the active Issue, the three canonical documents, the base SHA, and the complete diff. Inspect `git status --short`, `git diff --check`, and the changed files' callers.

Check in this order:

1. **Scope:** every changed surface is necessary for the Issue's coherent outcome and respects its authority and non-goals; no generated files, secrets, local machine identifiers, transcripts, or unrelated cleanup. Do not reject a necessary cross-layer change because it was absent from a predicted file list.
2. **Correctness:** facts remain bound to immutable exact SHA; coordinator authority, one-writer isolation, credential separation, and restart/retry semantics remain intact; tests exercise the owning public path.
3. **Design:** callers know only the boundary contract, policy has one owner, and no shallow or speculative seam was added. Require a separate design verdict only when [DEVELOPMENT review triggers](../../../docs/DEVELOPMENT.md#8-review-与-clean-room-预算) apply.
4. **Evidence:** run the narrowest relevant test and the checks required by [pre-push-checks](../pre-push-checks/SKILL.md). Treat green commands, agent exit, hooks, transcripts, and prose as evidence, never completion authority.

Return findings with severity, exact repository-relative file/line, violated contract, and a minimal fix. Separate blocking correctness/authority defects from later concerns. After fixes, perform a focused delta review of original findings and changed surfaces; do not expand the PR for unrelated improvements.
