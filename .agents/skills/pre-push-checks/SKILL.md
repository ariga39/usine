---
name: pre-push-checks
description: Use before publishing a draft checkpoint, pushing a branch, or claiming an authorized Usine change is ready.
---

# Pre-push checks

Run from the repository root. First inspect `git status --short`, the complete `git diff`, and the Issue's outcome, authority, and non-goals. Verify that every changed surface is necessary for the coherent behavior; do not enforce a file whitelist unless it represents a real permission or independent-ownership boundary.

Run the smallest relevant checks, then the full repository checks when the change is shared documentation, tooling, or otherwise broad:

```sh
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
git diff --check
```

For documentation-only changes, verify every new repository-relative Markdown link/path with the repository tool:

```sh
corepack pnpm check:links
```

It resolves links against each linking file's directory, rejects missing and local absolute targets, and ignores external `http(s)` URLs. Inspect changed text separately for home-directory names, hostnames, secrets, and private transcripts; the script cannot prove those content properties.

Finally inspect `git diff --stat` and the full diff, confirm no unrelated or generated files changed, and record exact command results. Checks are evidence for the exact candidate; they do not replace fresh independent exact-SHA review or the Issue's merge gate.
