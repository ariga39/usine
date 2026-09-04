# Usine

Usine is a local TypeScript and Node.js software-delivery coordinator. Its product direction is to turn one published Goal Contract into accepted Repository outcomes without requiring a person to decompose, start, review, merge, and advance every Task. Durable Campaign and Task facts, rather than process state or agent prose, decide recovery and completion.

## Supported boundary

The implemented Task delivery leaf is intentionally bounded:

- one local server and a finite active-Task capacity;
- one writer lease per registered Repository;
- statically selected Codex SDK, Codex App Server, or qualified source-internal OpenCode2 implementer/reviewer sessions behind one task-oriented adapter;
- GitHub as the current forge and bounded read surface;
- explicit Task Contract delivery authority, with merge authority granted only by `authorization.merge: true`;
- transient live observation plus durable Task-local event history.

The server now also admits one committed Goal Contract through a host-owned publication anchor and exposes its durable Campaign Planned/Ready frontier. Requirement Proxy/Planner execution, Task admission from Ready projections, and automatic frontier advancement remain outside this slice; they remain product behavior, not an external guardian's responsibility. Concurrent writers for one Repository, a distributed scheduler, automatic merge without explicit authority, and provider negotiation remain outside the boundary. The current architecture and durable decisions are documented in [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Quick start

From a fresh checkout with Node 24 and the pinned package manager available:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

For host setup, Repository registration, current leaf Task submission, server operation, observation, and bounded retry, follow [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md). This is not yet the wish-to-outcome Campaign entry path.

## Documentation map

- [`AGENTS.md`](AGENTS.md): short bootstrap for an agent developing Usine itself.
- [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md): task-oriented operation of Usine from prerequisites through recovery.
- [`docs/DESIGN.md`](docs/DESIGN.md): current product architecture, boundaries, and evidence.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): Git, testing, review, and repository-development protocol.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): durable technical decisions and re-entry conditions.
