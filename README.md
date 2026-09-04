# Usine

Usine is a local TypeScript and Node.js software-delivery coordinator. Its product direction is to turn one guardian-authored, user-authorized Campaign plan into accepted Repository outcomes without requiring a person to start, review, merge, or advance every Task. Durable Campaign and Task facts, rather than process state or agent prose, decide recovery and completion.

## Supported boundary

The implemented Task delivery leaf is intentionally bounded:

- one local server and a finite active-Task capacity;
- one writer lease per registered Repository;
- statically selected Codex SDK, Codex App Server, or qualified source-internal OpenCode2 implementer/reviewer sessions behind one task-oriented adapter;
- GitHub as the current forge and bounded read surface;
- explicit Task Contract delivery authority, with merge authority granted only by `authorization.merge: true`;
- transient live observation plus durable Task-local event history.

The server also admits a committed Goal Contract through a host-owned publication anchor, accepts its guardian-authored Task Proposals, and after explicit handoff admits eligible Tasks through the delivery leaf, reduces owning accepted exact-SHA delivery into live Outcome evidence, and accepts only complete Campaigns. An exhausted or blocked incomplete plan becomes a durable decision request; explicit host authority can abandon an unresolved Campaign. Automatic semantic decomposition, concurrent writers for one Repository, a distributed scheduler, automatic merge without explicit authority, and provider negotiation remain outside the boundary. The current architecture and durable decisions are documented in [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Quick start

From a fresh checkout with Node 24 and the pinned package manager available:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

For host setup, Repository registration, guardian-authored Campaign handoff, server operation, observation, and bounded retry, follow [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md).

## Documentation map

- [`AGENTS.md`](AGENTS.md): short bootstrap for an agent developing Usine itself.
- [`docs/AGENT_QUICKSTART.md`](docs/AGENT_QUICKSTART.md): task-oriented operation of Usine from prerequisites through recovery.
- [`docs/DESIGN.md`](docs/DESIGN.md): current product architecture, boundaries, and evidence.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): Git, testing, review, and repository-development protocol.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): durable technical decisions and re-entry conditions.
