---
name: find-simplifications
description: Use when a touched seam exposes duplicated policy, shallow wrappers, obsolete lifecycle machinery, or custom infrastructure replaceable by a maintained primitive.
---

# Find simplifications

Keep this audit bounded to the behavior owned by the current Issue, tracing every layer needed to understand that behavior. A smaller diff or fewer files is not evidence by itself.

1. Read the relevant [design module map](../../../docs/DESIGN.md#5-behavioral-packages-and-composition) and active [decisions](../../../docs/DECISIONS.md). Use `rg` to locate duplicate policy, pass-through exports, compatibility branches, and callers.
2. For each candidate, classify one action: delete dead behavior; merge ownership; demote a non-authoritative observer; or replace custom infrastructure with the already-selected library/platform primitive.
3. Require a current caller and an observable benefit: less caller knowledge, one owner for a fact, fewer recovery paths, or a smaller authority surface. Do not add a generic interface, adapter, package, or cleanup backlog for hypothetical variation.
4. Preserve the Usine invariants: deterministic coordinator authority, one writer, isolated workspace, immutable exact SHA, credential separation, and independent review. Never simplify by making process exit, transcript text, hook state, or test count authoritative.
5. Implement only simplifications that belong to the current coherent outcome. Leave unrelated candidates as a concise later Issue with evidence, not as drive-by edits.

Verify with the owning focused test plus `git diff --check`; use [pre-push-checks](../pre-push-checks/SKILL.md) when the result is publishable. Report the removed seam and the evidence that its behavior is covered.
