---
name: codebase-design
description: Use before adding or changing a Usine module, interface, seam, persistent state, or lifecycle.
---

# Codebase design

Use this skill when a change can alter caller knowledge, ownership, authority, persistence, or recovery. It is not a license to pre-design future providers or split files mechanically.

1. Read the relevant sections of [DESIGN](../../../docs/DESIGN.md) and [DECISIONS](../../../docs/DECISIONS.md). Identify the active behavior cluster and its temporary design owner.
2. Name the current caller and the policy the boundary will hide. If there is no current caller or user-observable behavior, stop and keep the change out of scope.
3. Trace the facts across the boundary: Task Contract, Candidate, check/review evidence, delivery effect, or provider-neutral session observation. Keep domain policy independent of Git, subprocess, HTTP, SDK, or database implementation.
4. Prefer the smallest task-oriented interface that returns typed evidence. Do not expose process, pane, transcript, argv, provider response, transaction context, or speculative extension points.
5. Record the deletion or replacement plan in the change description: which old caller, fake, policy copy, or seam becomes unnecessary, and what test will prove the new owner.
6. After editing, inspect the diff and run the narrowest behavior test. Escalate to an independent design review when the canonical trigger applies; a correctness review cannot replace it.

Evidence to retain: current caller, policy ownership, boundary inputs/outputs, affected tests, and the command result. Canonical documents and the active Issue remain authoritative over this skill.
