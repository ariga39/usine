# Usine

Usine is a local TypeScript and Node.js coordinator for authorized software-delivery tasks. It admits a committed Task Contract, gives one Repository writer an isolated implementation workspace, runs project checks, obtains an independent exact-SHA review, and delivers through a credential-scoped GitHub capability. Durable Task facts, rather than process state or agent prose, decide recovery and completion.

## Supported boundary

The current product path is intentionally bounded:

- one local server and a finite active-Task capacity;
- one writer lease per registered Repository;
- statically selected Codex SDK, Codex App Server, or qualified source-internal OpenCode2 implementer/reviewer sessions behind one task-oriented adapter;
- GitHub as the current forge and bounded read surface;
- explicit Task Contract delivery authority, with merge authority granted only by `authorization.merge: true`;
- transient live observation plus durable Task-local event history.

Usine does not currently provide a general task planner, concurrent writers for one Repository, a distributed scheduler, automatic merge without explicit authority, or a provider router. The current architecture and durable decisions are documented in [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Quick start

From a fresh checkout with Node 24 and the pinned package manager available:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

For host setup, Repository registration, Task Contract submission, server operation, observation, and bounded retry, follow [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md).

## Documentation map

- [`AGENTS.md`](AGENTS.md): short bootstrap for an agent developing Usine itself.
- [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md): task-oriented operation of Usine from prerequisites through recovery.
- [`docs/DESIGN.md`](docs/DESIGN.md): current product architecture, boundaries, and evidence.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): Git, testing, review, and repository-development protocol.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): durable technical decisions and re-entry conditions.
