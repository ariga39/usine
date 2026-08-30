---
status: current
design_version: 0.9
updated: 2026-08-24
issue: https://github.com/ariga39/usine/issues/267
---

# Usine product design

## 1. Problem, first useful behavior, and boundary

Usine coordinates a bounded software-delivery task after a user or an existing project process has supplied an authorized, reviewable Task Contract. Without a coordinator, a person must repeatedly start implementation, inspect the result, run checks, arrange independent review, request repairs, recover interrupted work, and decide whether delivery is authorized. Free-form agent-to-agent coordination makes those decisions difficult to audit and can leave no component responsible for the final outcome.

The first useful behavior is therefore one complete, server-owned path: admit one committed Task Contract, give one Repository writer an isolated workspace, freeze an exact candidate SHA, run the project check, obtain a fresh independent review, and deliver an exact-SHA approved PR. If and only if the immutable contract grants `authorization.merge: true`, the same path revalidates the live PR and merges that exact approved head, recording `merged`; otherwise it records `reviewed_pr`. A bounded implementer retry and restart recovery are part of this path.

The current supported boundary is:

| Area | Current product boundary |
|---|---|
| Host | One local loopback server with a finite active-Task capacity. |
| Work ownership | One writer lease per registered Repository; one isolated workspace per activation. |
| Provider | Codex through one task-oriented Coding Session port, with the official SDK or the bounded local App Server adapter selected statically by named profile. |
| Forge | GitHub for delivery and a bounded, role-scoped read surface through GitHub MCP. |
| Authority | A committed, immutable Task Contract authorizes scope, acceptance, budget, delivery, and optional merge. Durable Task facts decide lifecycle and completion. |
| Observation | Durable Task-local history plus best-effort process-local wait/subscribe observation. |
| Session Archive | Host-local, bounded Coding Session capture retrieved only by direct CLI operations. |

The product does not currently provide a planner for vague requests, a general task DAG, concurrent writers for one Repository, a distributed scheduler or runner, automatic merge without contract authority, provider routing or negotiation, another forge, a web dashboard, or a memory/vector database. It also does not claim exhaustive hostile validation of every Git or SQLite failure mode. These are deferred options, not implicit promises; their re-entry conditions are in [`DECISIONS.md`](DECISIONS.md).

## 2. End-to-end lifecycle

The server admits a contract only after the CLI/server boundary and the registered Repository validate it. The contract, Repository snapshot, deadline, writer identity, and merge authority are then frozen in durable state.

```text
committed Task Contract
        │  validate, resolve Repository, verify committed bytes/ancestry
        ▼
loopback API → persistent local server
        │
        │  Effect Scope owns HTTP resources, Task fibers, cleanup, signals
        ▼
Task Authority: admit + writer lease + durable TaskResult
        │
        ▼
Delivery Run: read state, reserve one activation/fence
        │
        ▼
Candidate Workspace: isolated writer worktree
        │  Codex implementer proposes a change
        ▼
host freezes clean descendant → exact Candidate SHA
        │
        ├────────────── project check in disposable exact-SHA checkout
        │
        └────────────── fresh reviewer in a separate exact-SHA checkout
                              │ explicit approved / changes_requested /
                              │ inconclusive verdict
                              ▼
                 Task Authority exact-SHA gate
                   │ changes_requested → one aggregated repair activation
                   │ inconclusive/failure → blocked
                   ▼
                 Forge Delivery: branch, PR, exact-SHA attestation
                   │
                   ├── no merge authority → reviewed_pr (terminal)
                   │
                   └── explicit merge authority
                              │ re-read live PR head and attestation
                              │ require approved head == Candidate SHA
                              ▼
                       GitHub merge endpoint
                              │
                              ├── proved refusal/ambiguity → blocked
                              └── observed exact merge effect → merged (terminal)
```

Every crossing in this path carries typed domain evidence, not provider transcripts or transport objects. The principal artifacts are the Task Contract, Candidate, Check Result, Review Verdict, Delivery Effect, and provider-neutral session observation. A new Candidate invalidates prior check, review, and delivery evidence by exact-SHA comparison.

## 3. Authority model and invariants

The coordinator is deterministic TypeScript. It performs admission, lease and activation reservation, fact validation, stale-evidence rejection, retry decisions, gate reduction, effect reconciliation, and terminal-state projection. A model may propose code or a structured role result; it cannot announce a Task terminal state. The optional `ai`/`@ai-sdk/openai` integration only normalizes a final role response into its schema and has no lifecycle authority.

The following invariants are product rules:

- The admitted Task Contract and its first deadline are immutable. A same-ID submission returns the existing facts only when the contract hash, Repository identity, snapshot, and merge authority still match.
- Task Authority is the sole owner of Task state, writer lease, activation fence, accepted facts, and terminal facts. Its transaction updates the durable result, appends the corresponding event, and releases the lease on a terminal transition.
- A Candidate, check, review, attestation, and merge effect must identify the same full lowercase 40-character SHA. A stale revision, fence, candidate parent, or live PR head is rejected or quarantined.
- A fresh reviewer must return an explicit structured verdict. Process exit, provider success, a test exit code, an agent message, a hook, or an attestation cannot substitute for semantic approval.
- Merge authority is not implied by delivery authority. Only an admitted `authorization.merge: true` contract may produce `merged`.
- Forge credentials are resolved and used at the host delivery boundary. They are not exposed to implementers, reviewers, project checks, public resources, durable events, prompts, or worker environment variables.
- One Repository has at most one writer lease. Old activation workspaces and execution identities are quarantined before a new writer is allowed to publish a Candidate.
- Normal execution and restart recovery use the same durable reconciliation path. An uncertain external effect is probed before retry; an ambiguous merge is not recorded as success.
- Durable state is authoritative. Process state, provider transcripts, hooks, transient subscriptions, and process-local event order are observations only.

## 4. Domain facts and Task lifecycle

### 4.1 Durable facts

`@usine/task-authority` defines the domain types in [`task-state.ts`](../packages/task-authority/src/task-state.ts), the contract boundary in [`contract.ts`](../packages/task-authority/src/contract.ts), and the persisted decode boundary in [`task-state-schema.ts`](../packages/task-authority/src/task-state-schema.ts). A `TaskResult` contains the contract hash, monotonic revision, original deadline, state, immutable merge-authority projection, Candidate SHA and fence, check, review, delivery, blocker, waiting record, active activation, writer identity, Repository snapshot, and evidence counters.

The main facts are:

| Fact | Meaning and owner |
|---|---|
| Task Contract | Caller-owned scope, acceptance, non-goals, budget, Issue authorization, delivery data, and optional merge authority. Admission freezes it. |
| Run/activation | A durable implementer activation and monotonic fence. It is an attempt identity, not completion evidence. |
| Candidate | A host-verified clean Git commit descending from the recorded parent and original base. |
| Check Result | The registered project command's result in a disposable exact-SHA checkout, with bounded output. |
| Review Verdict | A fresh reviewer result for the checked SHA: `approved`, `changes_requested`, or `inconclusive`. |
| Delivery Effect | Branch/PR identity, exact-SHA approval attestation, and optional observed merge effect. |
| Task event | A bounded, sanitized history projection for recovery and observation. It cannot reconcile state. |

The persistent representation is decoded with Effect Schema at the untrusted SQLite boundary. Existing Zod validation remains the external Task Contract boundary; six behavior packages remain Promise-based unless a caller-specific change proves that Effect removes duplicated validation, error mapping, or lifecycle code.

### 4.2 States and transitions

The legal state names are `admitted`, `waiting`, `candidate`, `checked`, `reviewed`, `reviewed_pr`, `merged`, and `blocked`. `reviewed_pr`, `merged`, and `blocked` are terminal. `waiting` is a durable pause, not a terminal result.

| State | Meaning | Normal next facts |
|---|---|---|
| `admitted` | Contract admitted, lease held, no accepted Candidate yet. | Candidate, waiting, or blocked. |
| `waiting` | The implementer suffered the one currently retryable turn-phase network interruption. The record stores the resume state and activation. | Explicit retry resumes the recorded `admitted`, `checked`, or `reviewed` phase; expiry or invalidity blocks. |
| `candidate` | A clean exact Candidate SHA was accepted under the current activation fence. | Check, a repair Candidate path, waiting, or blocked. |
| `checked` | A Check Result for the current Candidate exists. | Fresh review, repair activation after a failed check, waiting, or blocked. |
| `reviewed` | A review verdict for a passing check exists. | One aggregated repair activation, delivery, waiting, or blocked. |
| `reviewed_pr` | GitHub delivery and exact-SHA attestation succeeded without merge authority. | None. |
| `merged` | GitHub reported and the server observed an exact approved-head merge effect with a merge commit SHA. | None. |
| `blocked` | The coordinator recorded a classified product, provider, evidence, budget, delivery, or platform blocker. | None. |

Task Authority's reducer and the Candidate Workspace enforce the following lifecycle properties:

- A new Candidate clears check, review, delivery, and blocker evidence. The reducer requires its fence to equal the reserved activation and, after the first Candidate, requires its parent to be the accepted prior Candidate. Candidate Workspace separately requires the initial Candidate to descend from the contract base.
- A check must belong to the current Candidate. A review requires a passing check for that same SHA. A delivery requires a passing check and an `approved` review for that same SHA.
- `changes_requested` findings are recorded as one repair batch before one implementer activation. Individual findings do not each wake an agent.
- Only an implementer failure in the `turn` phase with `failureClass: "network"` may become `waiting`. Reviewer interruption, configuration failure, project-check failure, other provider failures, restart, and same-ID submission do not implicitly retry.
- `task retry` is an explicit compare-and-set transition. It preserves the original contract, Repository authority, and deadline and returns to the stored resume state; the subsequent Delivery Run reserves the next activation. Deadline exhaustion blocks the retry, while an exhausted activation budget is rejected as a retry conflict.
- `reviewed_pr` is the no-merge terminal. `merged` requires both immutable merge authority and a Delivery Effect whose approved head and PR number match the reviewed delivery; the merge commit SHA must also be exact.

## 5. Behavioral packages and composition

The six behavior packages are real pnpm workspace packages with public exports. The package manifests and export barrels are the boundary evidence: [`packages/task-authority/package.json`](../packages/task-authority/package.json), [`candidate-workspace/package.json`](../packages/candidate-workspace/package.json), [`coding-session/package.json`](../packages/coding-session/package.json), [`delivery-run/package.json`](../packages/delivery-run/package.json), [`quality-gate/package.json`](../packages/quality-gate/package.json), and [`forge-delivery/package.json`](../packages/forge-delivery/package.json). `@usine/runtime` and `@usine/cli` are composition roots, not a seventh behavior package.

| Package | Current caller | Policy hidden behind its port | Typed artifacts crossing the boundary |
|---|---|---|---|
| [`@usine/task-authority`](../packages/task-authority/) | Runtime and Delivery Run | Contract admission/immutability, Repository lease, CAS revision, legal state transitions, exact-SHA validation, durable persistence, sanitized Task history, and public projections. | `TaskContract`, `RepositorySnapshot`, `TaskResult`, `TaskFact`, `TaskEvent`, public resources. |
| [`@usine/candidate-workspace`](../packages/candidate-workspace/) | Runtime and Delivery Run; Quality Gate uses its checkout capability | Detached writer worktrees, clean commit/finalization, ancestry, disposable checkouts, credential-free Git environment, quarantine. | `WriterWorkspace`, `FrozenCandidate`, SHA and checkout callback. |
| [`@usine/coding-session`](../packages/coding-session/) | Delivery Run and Quality Gate | Role/sandbox policy, profile resolution, worker environment, prompt/output schema projection, provider turn lifecycle, cancellation, timeout, bounded observations, and host-local Session Archive capture. | `SessionRequest`, schema-valid role output, `SessionObservation`, provider-neutral observation, `SessionArchive`. |
| [`@usine/quality-gate`](../packages/quality-gate/) | Delivery Run | Project-check execution and fresh exact-SHA review in separate disposable checkouts; review output validation and finding projection. | `CheckResult`, `ReviewAttemptObservation`, `ReviewVerdict`. |
| [`@usine/forge-delivery`](../packages/forge-delivery/) | Delivery Run and runtime's GitHub-read composition | GitHub App authentication, branch/PR identity, push, approval attestation, live-head validation, merge, and probe-before-retry. | Approved check/review bundle and `DeliveryEffect`; bounded GitHub-read MCP server configuration. |
| [`@usine/delivery-run`](../packages/delivery-run/) | Runtime server | The deterministic phase reducer, activation/review budgets, repair batching, bounded retry, restart re-entry, and next-action ordering. | `DeliveryRunInput`, `DeliveryRunServices`, and the resulting durable `TaskResult`. |

The production dependency direction is acyclic. The diagram below is the production dependency graph formed from package `dependencies`; it excludes test- and tool-only `devDependencies` such as test fixtures. In the diagram, `A → B` means “package A imports package B”; arrows therefore point toward the domain policy owner:

```text
@usine/candidate-workspace ───────→ @usine/task-authority
@usine/coding-session ────────────→ @usine/task-authority
@usine/forge-delivery ────────────→ @usine/task-authority
@usine/quality-gate ──────────────→ @usine/candidate-workspace
                                  ├→ @usine/coding-session
                                  └→ @usine/task-authority
@usine/delivery-run ──────────────→ @usine/candidate-workspace
                                  ├→ @usine/coding-session
                                  ├→ @usine/forge-delivery
                                  ├→ @usine/quality-gate
                                  └→ @usine/task-authority
@usine/runtime ───────────────────→ all six behavior packages
@usine/cli ───────────────────────→ @usine/runtime and @usine/task-authority
```

Domain policy does not import HTTP, Git, subprocess, GitHub, SDK, or database implementation. Cross-package calls use declared package exports; they do not reach into another package's `src` or `dist`. Boundaries carry Task Contract, Candidate, Check Result, Review Verdict, Delivery Effect, and provider-neutral observations. They do not carry HTTP requests, Effect fibers, provider threads/events, panes, argv, raw provider responses, or database transactions.

## 6. Persistent server lifecycle and Coding Session lifecycle

The persistent local server is the coordinator host. [`packages/runtime/src/server.ts`](../packages/runtime/src/server.ts) creates a sequential Effect Scope, applies SQLite migrations, validates loopback binding, checks the durable active-Task count, starts the typed HTTP API, owns a `FiberMap` for Task execution, and installs release cleanup. On shutdown it closes transient listeners and the Effect scope; owned Codex executions are interrupted and reaped. `AbortSignal` is propagated into the Delivery Run and adapters.

At startup the server decodes durable Tasks. Nonterminal Tasks that have valid committed execution input are re-entered through the same run path, after recording sanitized restart/owner-change observations. `waiting` Tasks retain their lease and capacity slot but are not launched automatically. Persisted-state decode failures are rejected at the Task Authority boundary; invalid committed execution input is blocked during startup. A submitting CLI process may exit after admission because execution belongs to the server.

Coding Session is a different lifecycle. [`CodexCodingSession`](../packages/coding-session/src/coding-session.ts) owns one provider run: profile resolution, role policy, bounded environment, optional read-MCP setup, provider thread/turn, structured output parsing or optional final normalization, cancellation/deadline handling, cleanup of the provider execution identity, and capture of a host-local Session Archive. It returns a typed `SessionObservation`; the Delivery Run decides what durable Task fact follows. Provider thread IDs, raw events, transcripts, tool arguments, and raw error text do not cross the domain port or become Task authority.

Each implementer or reviewer run creates one versioned archive under the configured state root, separate from SQLite and `codex-executions`. The archive records the strict caller-owned Task Contract and prompt, a whitelist-only effective profile snapshot, adapter/session identity, completed provider items, raw response, normalized output, usage, phase, failure, and outcome. Resolved Repository path/owner/name, project-check policy, and `delivery.baseBranch` are not part of the role Contract or archive. It is atomically replaced in the same directory, bounded per archive, and subject to finite retention; truncation, write failure, and pruning are explicit status/warning observations. A failed archive never changes the role result, Candidate, review, delivery, or terminal Task state. Task resources and history carry only the opaque archive ID and capture status.

The archive payload is intentionally sensitive. `archive list` and `archive manifest` expose metadata only; `archive export` is an explicit host-local CLI read of one validated archive ID and writes only that archive to stdout. Raw archive content is not served by the unauthenticated loopback HTTP API. Archive IDs and Task IDs are resolved internally and cannot select arbitrary filesystem paths. Archive directories and snapshots are forced private, and reads use a no-follow descriptor plus identity, profile-checksum, declared-byte-length, and hard-bound validation. Corrupt entries are skipped by list/Task cleanup while exact corrupt-ID reads remain typed failures. The profile snapshot is whitelist-only and includes selected identity/model/reasoning/developer-instruction fields plus a stable SHA-256 checksum. Meaningful completed provider evidence is retained explicitly, so its command, file-change, tool-argument, output, prompt, and response bytes may contain sensitive paths or other content. Process environment, credentials, forge capabilities, launcher/workspace identity, MCP URLs, headers, argv, hidden config, and private keys are not intentionally captured. A pruned archive remains available as a bounded metadata tombstone with `captureStatus: "pruned"`; `complete` and `partial` describe whether provider completion data was observed.

The server therefore owns Task fibers, durable re-entry, resource cleanup, and lifecycle authority; the Coding Session adapter owns Codex execution semantics. Neither a provider process nor an Effect fiber is a durable Task state machine.

## 7. SDK and bounded App Server profile selection

A registered Repository supplies opaque implementer and reviewer profile names. Before activation, the Coding Session validates the safe name and resolves `<profile>.config.toml` from `CODEX_HOME` or the Codex default directory. A profile needs a nonblank model; supported configuration includes the current Codex model, reasoning, provider/catalog, verbosity/personality, service tier, and optional developer instructions. Invalid, unreadable, or unsupported configuration fails closed as `codex_profile_unusable`.

`USINE_CODEX_APP_SERVER_PROFILES` is a comma-separated allowlist of profile names. A listed name selects exactly the bounded local Codex App Server adapter; an unlisted name selects the official `@openai/codex-sdk` adapter. This choice is static per named profile and per activation. There is no fallback, registry, capability negotiation, automatic routing, third provider, or general runtime-compatibility claim. Both adapters implement the same task-oriented `run(request) -> typed observation` port. The App Server is not a second task authority.

The coordinator still supplies the frozen Task Contract, role prompt, sandbox (`workspace-write` for implementer and `read-only` for reviewer), output schema, deadline, and cancellation. Profile model/provider/reasoning/service-tier values, credentials, and developer instructions are host-private composition inputs; they do not alter the Task Contract or durable Task model. `ai` + `@ai-sdk/openai`, when configured, is only a final role-output normalizer and is bounded by the same output schema and deadline.

## 8. Candidate, checks, review, delivery, and GitHub capabilities

The implementer receives a detached worktree at the contract base or the current Candidate parent. The host, not the agent, freezes the Candidate: it checks that the worktree advances, is clean, is descended from both the prior parent and original base, and produces a full exact SHA. Git runs with `GIT_CONFIG_NOSYSTEM=1`, a null global config, and terminal prompting disabled; Forge credentials are absent.

Quality Gate runs the registered project command in a disposable exact-SHA checkout with an explicit reduced environment and bounded stdout/stderr. A passed check is required before review. The reviewer receives a fresh checkout, the Task Contract, the exact Candidate SHA, and check evidence. It does not inherit the implementer's workspace or conversation and must return an explicit schema-valid verdict. A missing/invalid/stale output is `inconclusive`, never approval.

Forge Delivery requires a passing exact-SHA check and exact-SHA semantic approval. It probes for an existing branch/PR before writing, pushes with a credential-scoped GitHub capability, and creates or verifies one approval attestation tied to the Task, Issue, SHA, check, and review. Multiple, mismatched, or wrong-identity attestations quarantine delivery. A lost write response is reconciled by probing the same identity.

For merge-authorized contracts, Forge Delivery re-reads the live PR and attestation immediately before calling the GitHub merge endpoint. A changed head, mismatched attestation, non-mergeable platform state, refusal, or ambiguous response does not create a merge fact. A later probe may record `merged` only when the PR is observed merged with an exact merge commit SHA and the approved head/PR identity still matches. GitHub platform policy is the final merge gate.

GitHub read access is optional and separate from Forge delivery. The registered opaque `githubReadProfile` resolves its own GitHub App capability, must bind to the same owner/name, and exposes only an allowlisted `github_issue_*`, `github_pull_request_*`, `github_file_get`, or `github_commit_get` tool set to the selected role through a local Streamable HTTP MCP server. Pull-request reads additionally require an authorized delivered-PR fact. Read credentials never become Forge credentials and never enter workers, prompts, MCP configuration, public resources, durable events, or logs.

## 9. Durable history and transient observation

Task Authority persists one ordered, Task-local `task_events` stream. Authority transactions create admission, activation, Candidate, check, review, repair, waiting/retry, delivery, recovery, blocker, and terminal facts/events with stable event identities. External Coding Session and recovery observations are accepted only through the sanitized observation schema. Event data is bounded and excludes secrets, paths, prompts, transcripts, argv, raw provider payloads, credentials, and private diagnostics; a `coding_session_completed` event may carry only an opaque Session Archive ID and capture status. Duplicate event identities are idempotent; sequence order is assigned durably.

`task history` reads this durable stream after a sequence cursor. `task watch` replays history and then reads the authoritative Task resource, so it can recover an operator view without treating event text as state. The CLI aliases `status` and `follow` remain compatibility surfaces; canonical resource commands are `server health|snapshot`, `repository list|get`, and `task list|get|history|watch|retry`, with `register` and `submit` as mutation entry points.

The server also exposes process-local `wait` and `subscribe` observation through an Effect `PubSub` hub. A listener chooses exactly one scope: Task, Repository, or the whole server. `wait` returns one new sanitized envelope or `null` on bounded timeout; `subscribe` emits a ready marker and future matching envelopes. These are best-effort producer-only notifications with a bounded dropping buffer. They have no durable cursor, acknowledgement, replay, resume, backpressure, or restart-recovery protocol. If a listener disconnects, the server shuts down, or it cannot keep up, the listener closes; callers must read current state/history when correctness matters.

External observers and supervisors are separate glue processes, not part of the Usine server or Task Authority. They use only existing generic loopback resources and mutations, plus process-local `subscribe` invalidations; an invalidation is not state, so correctness requires rereading current Task resources and durable history. The external bridge owns best-effort wake delivery, agent-product configuration/lifecycle, coalescing/retry, and one bounded replaceable MCP session. There is no durable cursor, ledger, replay, acknowledgement, second scheduler, agent-session store, or Hermes-specific server API/fact/event/persistence. Disconnect or restart starts fresh, and terminal transitions while offline may not produce individual wakes. Webhooks, MCP responses, and process-local state are observation evidence, not completion authority.

## 10. Recovery, retry, capacity, and isolation

Recovery is deterministic reconciliation, not replay of process operations. On re-entry the server reads the durable Task Contract, phase, revision, activation, Candidate, and effect identities; it probes Git/worktree/GitHub before repeating uncertain effects. Confirmed effects are recorded once, provably absent effects may be retried with the same stable identity, and unresolved ambiguity is quarantined. A new writer receives a new activation fence and workspace; stale work cannot publish a Candidate. The first deadline is never extended by restart.

The default `USINE_ACTIVE_TASK_CAPACITY` is `1`; it must be a positive finite integer. Admission counts durable nonterminal Tasks and, in the same transaction, acquires the Repository lease. Same-ID idempotent resubmission is checked before capacity rejection. A full capacity returns a retryable error but does not create a queue. On startup, a durable count above the configured capacity rejects readiness rather than launching work beyond the bound. Terminal state releases the Repository lease and the capacity slot. This is bounded process-local capacity, not fairness, dynamic resizing, or distributed scheduling.

Isolation is capability-based:

| Actor | Workspace | Network | GitHub delivery credential |
|---|---|---|---|
| Implementer | Writable activation worktree | Provider/task environment | None |
| Project check | Disposable exact-SHA checkout | Host filesystem/network permissions with reduced explicit environment | None |
| Reviewer | Fresh read-only exact-SHA checkout plus scratch | Provider/task environment and optional bounded read MCP | No Forge credential |
| Delivery | No candidate execution | GitHub and configured Git remote | Short-lived host-scoped Forge capability |

Codex sandbox and host permissions are the default isolation mechanism. Containers, VMs, remote sandboxes, queues, and distributed runners are not hidden prerequisites or domain concepts.

## 11. Current evidence and limits

The repository currently provides focused behavioral evidence rather than a production-scale benchmark. The most direct evidence is:

| Claim | Repository evidence | Limit of the evidence |
|---|---|---|
| Lifecycle reducer, exact-SHA facts, waiting, explicit retry, merge authorization | [`packages/task-authority/tests/task-authority.test.ts`](../packages/task-authority/tests/task-authority.test.ts), [`packages/task-authority/tests/task-authority-sqlite.test.ts`](../packages/task-authority/tests/task-authority-sqlite.test.ts) | Does not prove every hostile database or Git failure mode. |
| Durable sanitized history and event identity | [`packages/task-authority/tests/task-events.test.ts`](../packages/task-authority/tests/task-events.test.ts) | History is Task-local; process-local subscriptions are separately best effort. |
| Persistent server, server-owned execution, restart cleanup, exact-head delivery and optional merge | [`tests/server-milestone.test.ts`](../tests/server-milestone.test.ts), [`tests/server-execution.test.ts`](../tests/server-execution.test.ts) | Hermetic fixtures and bounded scenarios do not prove broad GitHub ruleset or provider behavior. |
| Capacity admission, same-ID idempotency, slot release, and lowered-capacity startup refusal | [`tests/server-capacity.test.ts`](../tests/server-capacity.test.ts) | No performance claim for higher capacity, fairness, multiple runners, or dynamic resizing. |
| Process-local wait/subscribe and CLI history/watch projection | [`tests/server-subscription.test.ts`](../tests/server-subscription.test.ts), [`tests/server-follow.test.ts`](../tests/server-follow.test.ts), [`apps/cli/tests/server-client.test.ts`](../apps/cli/tests/server-client.test.ts) | No replay, acknowledgement, backpressure, or restart guarantee for transient listeners. |
| Static profile selection, bounded SDK/App Server adapters, cancellation, and output normalization | [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts), [`packages/coding-session/src/codex-profile.ts`](../packages/coding-session/src/codex-profile.ts) | Supported provider remains Codex; no general provider compatibility or automatic routing is claimed. |
| Bounded SDK/App Server Session Archive capture and host-local metadata/content operations | [`packages/coding-session/tests/session-archive.test.ts`](../packages/coding-session/tests/session-archive.test.ts), [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts) | Archive content is sensitive and intentionally requires explicit local export; archive persistence is non-authoritative. |
| Disposable checks, fresh review, stale review rejection, and credential-free Git | [`packages/quality-gate/tests/quality-gate.test.ts`](../packages/quality-gate/tests/quality-gate.test.ts), [`packages/candidate-workspace/tests/candidate-workspace.test.ts`](../packages/candidate-workspace/tests/candidate-workspace.test.ts) | Check output is bounded and environment policy remains host-specific. |
| Forge probe/retry, attestation identity, read MCP scoping, and merge effects | [`packages/forge-delivery/tests/forge-delivery.test.ts`](../packages/forge-delivery/tests/forge-delivery.test.ts), [`packages/forge-delivery/tests/github-read.test.ts`](../packages/forge-delivery/tests/github-read.test.ts), [`tests/runtime-policy.test.ts`](../tests/runtime-policy.test.ts) | Private live characterization is optional; no claim is made about every GitHub installation or ruleset. |
| One bounded external exact-head production run | [fund-manager Issue #52](https://github.com/ariga39/fund-manager/issues/52) and [PR #53](https://github.com/ariga39/fund-manager/pull/53) | It is one one-contract run; it does not establish retry recovery, scale, broader merge policy, or provider breadth. |

These limits define the current stopping boundary. A green check, PR, process exit, event stream, or agent statement is evidence for a narrower fact; none independently proves Task completion.
