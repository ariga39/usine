---
status: current
design_version: 1.0
updated: 2026-09-04
issue: https://github.com/ariga39/usine/issues/366
---

# Usine product design

## 1. Problem, product outcome, and boundary

Usine turns an authorized software wish into accepted Repository outcomes without making a person decompose, start, inspect, review, merge, and advance every delivery Task. A person supplies the wish, steering, and authority; Requirement Proxy and Planner roles perform bounded semantic work; a deterministic coordinator owns durable ordering, liveness, gates, and effects. Free-form agent conversation, a permanent guardian, and an external script that submits each Task are not the product control plane.

The implemented Task delivery loop remains the reusable leaf: it admits one committed Task Contract, gives one Repository writer an isolated workspace, freezes an exact Candidate SHA, runs the project check, obtains a fresh independent review, and delivers or explicitly merges the approved head. The current product outcome is the enclosing Campaign: publish one versioned Goal Contract, maintain a bounded Outcome Tree and rolling Task frontier, run each Ready Task through that leaf, advance dependencies after accepted delivery, replenish useful work, and close only when the Goal Contract's outcome evidence is satisfied.

A Campaign is one execution of a published Goal Contract. It is not a general project-management system or an unbounded task DAG. Its boundary is:

| Area | Product boundary |
|---|---|
| Host | One local loopback server with a finite active-Task capacity. |
| Work supply | One published Goal Contract authorizes a bounded Outcome Tree; a rolling Planner supplies proposals before the Ready frontier is exhausted. |
| Work ownership | One writer lease per registered Repository; one isolated workspace per activation; cross-Repository Tasks may run concurrently. |
| Semantic roles | Requirement Proxy publishes or revises the Goal Contract under delegated authority; Planner proposes bounded frontier changes; neither role mutates lifecycle state. |
| Leaf execution | The existing Task delivery loop implements, checks, independently reviews, repairs, delivers, and optionally merges one Ready Task. |
| Provider | Host-selected profiles run bounded semantic roles behind caller-owned contracts; provider process and transcript details remain outside domain authority. |
| Forge | GitHub for delivery and a bounded, role-scoped read surface through GitHub MCP. |
| Authority | A host-authorized published Goal Contract is the root Campaign authority. Admitted Ready projections are bounded by its repository, effect, budget, delivery, and merge envelope; explicit merge authority still gates merge. |
| Observation | Durable Campaign/Outcome/Task evidence plus best-effort process-local wait/subscribe observation. |
| Session Archive | Host-local, bounded Coding Session capture retrieved only by direct CLI operations. |

The current implementation proves the leaf loop, host-anchored committed Goal publication, and the first durable Campaign Planned/Ready frontier slice. It does not yet invoke Requirement Proxy/Planner roles, admit Ready projections into the delivery leaf, or automatically advance successors after delivery. Those gaps remain product behavior, not a supported manual operating mode. A distributed scheduler or runner, concurrent writers for one Repository, automatic merge without contract authority, provider negotiation, another forge, a web dashboard, and a memory/vector database remain outside the boundary. Re-entry conditions are in [`DECISIONS.md`](DECISIONS.md).

## 2. End-to-end lifecycle

The root handoff is `goal_published`: one immutable Spec version and Goal Contract whose publication is authorized by the user or a previously delegated publication policy. In the local-server composition, the server's host-owned `USINE_GOAL_PUBLICATION_SOURCE` anchor must match the committed authority source; `authority.publish`, source prose, and model-writable file content cannot mint executable authority. Draft discussion and Planner output cannot create that fact. The Campaign coordinator admits bounded Task Proposals only when they trace to a live Outcome, request a subset of the root authority and budget, and have satisfied dependencies. It resolves the exact base SHA from the durable Repository state only when the Task becomes Ready; a proposal never invents a future SHA.

```text
wish + steering
       │
       ▼
Requirement Proxy → versioned Spec + Goal Contract candidate
       │ user confirmation or delegated publish policy
       ▼
goal_published → Campaign + accepted Outcome Tree
       │
       ▼
Planner proposal → bounded rolling frontier
       │                ▲
       │ Ready          │ low watermark / evidence-driven replan
       ▼                │
Task delivery leaf ─────┘
       │ reviewed_pr when merge was not authorized
       │ merged when authorized and exact-head gates pass
       ▼
dependency release → next Ready Task or Goal evidence closure
```

The deterministic coordinator, not the guardian or Planner, repeats the lower loop until the Campaign is accepted, abandoned under explicit authority, or stopped by a durable budget/authority blocker. Independent Tasks may continue while another branch of the Outcome Tree is blocked. Product forks and new authority are grouped into a decision request instead of turning ordinary progress into per-Task approval.

Each Ready Task uses the existing leaf lifecycle. The server admits its contract only after the Campaign and registered Repository validate it. The resolved base, contract, Repository snapshot, deadline, writer identity, and merge authority are then frozen in durable Task state.

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
                              ├── proved refusal/identity conflict → blocked
                              ├── unresolved transient/ambiguous effect → waiting
                              └── observed exact merge effect → merged (terminal)
```

Every crossing in this path carries typed domain evidence, not provider transcripts or transport objects. The principal artifacts are the Task Contract, Candidate, Check Result, Review Verdict, Delivery Effect, and provider-neutral session observation. A new Candidate invalidates prior check, review, and delivery evidence by exact-SHA comparison.

## 3. Authority model and invariants

The coordinator is deterministic TypeScript. At Campaign scope it owns publication identity, Outcome and proposal admission, dependency readiness, active capacity, replenishment triggers, budgets, and completion reduction. At Task scope it performs lease and activation reservation, fact validation, stale-evidence rejection, retry decisions, exact-SHA gate reduction, effect reconciliation, and terminal-state projection. A model may propose a Spec, frontier change, code, or structured review; it cannot publish authority or announce a Campaign or Task terminal state. The optional `ai`/`@ai-sdk/openai` integration only normalizes a final role response into its schema and has no lifecycle authority.

The following invariants are product rules:

- A Goal Contract publication is immutable and idempotent. A revised wish or accepted replan creates a new version and explicitly supersedes affected Outcomes and proposals; it does not rewrite already observed delivery facts.
- A Task Proposal has no execution authority. Admission must trace it to one live Outcome and prove that its requested Repository, effects, budget, and merge capability are within the Goal Contract envelope.
- Campaign coordination owns Ready selection and Planner low-watermark activation. Requirement Proxy, Planner, implementers, reviewers, guardians, hooks, and external observers cannot directly wake arbitrary roles or advance lifecycle state.
- The admitted Task Contract and its first deadline are immutable. A same-ID submission returns the existing facts only when the contract hash, Repository identity, snapshot, and merge authority still match.
- Task Authority is the sole owner of Task state, writer lease, activation fence, accepted facts, and terminal facts. Its transaction updates the durable result, appends the corresponding event, and releases the lease on a terminal transition.
- A Candidate, check, review, attestation, and merge effect must identify the same full lowercase 40-character SHA. A stale revision, fence, candidate parent, or live PR head is rejected or quarantined.
- A fresh reviewer must return an explicit structured verdict. Process exit, provider success, a test exit code, an agent message, a hook, or an attestation cannot substitute for semantic approval.
- Merge authority is not implied by delivery authority. Only an admitted `authorization.merge: true` contract may produce `merged`.
- Forge credentials are resolved and used at the host delivery boundary. They are not exposed to implementers, reviewers, project checks, public resources, durable events, prompts, or worker environment variables.
- One Repository has at most one writer lease. Old activation workspaces are quarantined before a new writer is allowed to publish a Candidate.
- A dependent Task resolves and records its exact base only after predecessor acceptance. The initial serial policy retains a Repository's active delivery ownership through merge so an automatically selected successor starts from the observed accepted head; later overlap requires explicit base/conflict evidence.
- Normal execution and restart recovery use the same durable reconciliation path. An uncertain external effect is probed before retry; an ambiguous merge is not recorded as success.
- Campaign completion requires evidence for every required live Outcome, not an empty Ready list or a Planner statement. An empty frontier while required Outcomes remain causes dependency wait, bounded replenishment, or replan.
- Durable state is authoritative. Process state, provider transcripts, hooks, transient subscriptions, and process-local event order are observations only.

## 4. Domain facts and lifecycle

### 4.1 Campaign facts

The Campaign orchestration behavior cluster owns the policy between a published goal and the existing Task admission seam. Its first caller is the runtime server's goal-publication and proposal entry path; its current slice validates and durably projects Goal publication, Outcomes, proposal identity/order, Planned/Ready/Blocked status, authority and budget subset checks, dependency readiness, and readiness-time Repository heads. It hides Spec-version authority, Outcome traceability, proposal admission, readiness, dependency release, bounded Planner replenishment, Campaign budgets, and terminal reduction. No package or general queue interface is selected until a current caller proves the seam.

The minimum durable meanings are:

| Fact | Meaning and owner |
|---|---|
| Goal publication | Immutable identity of the authorized Spec version, Goal Contract, authority envelope, budgets, host publication anchor result, and publication provenance. Campaign coordination owns admission; a model cannot self-publish it. |
| Campaign | One execution of a Goal publication, including status, cumulative budget, and current Spec version. |
| Outcome | A required user-observable result, its acceptance evidence, dependencies, and live/superseded status. |
| Task Proposal | Planner-authored execution suggestion with an idempotency key and Outcome trace. It has no lease, resolved base, or execution authority; the coordinator durably orders it and projects it as Planned, Ready, or Blocked. |
| Ready Task | An admitted immutable Task projection whose dependencies, authority, capacity, Repository state, and exact activation base have been resolved by the coordinator. The base is recorded from the registered Repository fact at the first Ready transition and is never proposal-supplied. If later reconciliation makes the proposal non-executable, its status changes but the historical Ready fact remains available for recovery. |
| Campaign evidence | Accepted Task delivery effects, Outcome observations, usage, human touches, replans, and terminal reason linked to the Campaign. |

Rolling-wave planning freezes the accepted Outcome Tree and proposes only a bounded near-term frontier. A low watermark, an exhausted but incomplete frontier, or evidence that invalidates the plan may activate one Planner run. Dependency changes and capacity release are mechanical transitions and do not consume a Planner run. A Task may be narrowed or split within its Outcome without adding product scope; a new Outcome or material product behavior requires a versioned replan under the Goal authority.

This frontier slice does not run the delivery leaf or record accepted delivery evidence. Proposal and Outcome dependencies therefore remain Planned until a later coordinator slice owns that evidence; a Ready predecessor is executable work, not completed work.

Campaign terminal meanings are deliberately small: `accepted` requires complete Outcome evidence; `blocked` requires a durable authority, product, or exhausted-budget reason that prevents every remaining useful branch; `abandoned` requires explicit authority. Running, planning, ready, active, and waiting are projections of durable facts rather than independent claims by an agent.

### 4.2 Task facts

`@usine/task-authority` defines the domain types in [`task-state.ts`](../packages/task-authority/src/task-state.ts), the contract boundary in [`contract.ts`](../packages/task-authority/src/contract.ts), and the persisted decode boundary in [`task-state-schema.ts`](../packages/task-authority/src/task-state-schema.ts). A `TaskResult` contains the contract hash, monotonic revision, original deadline, state, immutable merge-authority projection, Candidate SHA and fence, check, review, delivery, blocker, waiting record, active activation, writer identity, Repository snapshot, and evidence counters.

The main facts are:

| Fact | Meaning and owner |
|---|---|
| Task Contract | Caller-owned scope, acceptance, non-goals, budget, root-authorization provenance, delivery data, and optional merge authority. Admission freezes it. The implemented standalone boundary still requires a matching GitHub Issue and must be revised for Campaign-derived Tasks. |
| Run/activation | A durable implementer activation and monotonic fence. It is an attempt identity, not completion evidence. |
| Candidate | A host-verified clean Git commit descending from the recorded parent and original base. |
| Check Result | The registered project command's result in a disposable exact-SHA checkout, with bounded output. |
| Review Verdict | A fresh reviewer result for the checked SHA: `approved`, `changes_requested`, or `inconclusive`. |
| Delivery Effect | Branch/PR identity, exact-SHA approval attestation, and optional observed merge effect. |
| Task event | A bounded, sanitized history projection for recovery and observation. It cannot reconcile state. |

The persistent representation is decoded with Effect Schema at the untrusted SQLite boundary. Existing Zod validation remains the external Task Contract boundary; six behavior packages remain Promise-based unless a caller-specific change proves that Effect removes duplicated validation, error mapping, or lifecycle code.

### 4.3 Task states and transitions

The legal state names are `admitted`, `waiting`, `candidate`, `checked`, `reviewed`, `reviewed_pr`, `merged`, and `blocked`. `reviewed_pr`, `merged`, and `blocked` are terminal. `waiting` is a durable pause, not a terminal result.

| State | Meaning | Normal next facts |
|---|---|---|
| `admitted` | Contract admitted, lease held, no accepted Candidate yet. | Candidate, waiting, or blocked. |
| `waiting` | The implementer suffered the one currently retryable turn-phase network interruption, or delivery ended with an unresolved external effect. The record stores the resume state and activation. | Explicit retry resumes the recorded phase; delivery reconciliation resumes `reviewed` with the same approved bundle; expiry or invalidity blocks. |
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
- Only an implementer failure in the `turn` phase with `failureClass: "network"`, or the Forge boundary's typed unresolved delivery outcome, may become `waiting`. Reviewer interruption, configuration failure, project-check failure, other provider failures, restart, and same-ID submission do not implicitly retry.
- `task retry` is an explicit compare-and-set transition. It preserves the original contract, Repository authority, and deadline and returns to the stored resume state; the subsequent Delivery Run reserves the next activation only for implementer recovery. Delivery reconciliation reuses the same approved Candidate/check/review bundle. Deadline exhaustion blocks the retry, while an exhausted activation budget is rejected only for implementer recovery.
- `reviewed_pr` is the no-merge terminal. `merged` requires both immutable merge authority and a Delivery Effect whose approved head and PR number match the reviewed delivery; the merge commit SHA must also be exact.

## 5. Behavioral packages and composition

The six implemented behavior packages form the Task delivery leaf. Their package manifests and export barrels are the boundary evidence: [`packages/task-authority/package.json`](../packages/task-authority/package.json), [`candidate-workspace/package.json`](../packages/candidate-workspace/package.json), [`coding-session/package.json`](../packages/coding-session/package.json), [`delivery-run/package.json`](../packages/delivery-run/package.json), [`quality-gate/package.json`](../packages/quality-gate/package.json), and [`forge-delivery/package.json`](../packages/forge-delivery/package.json). `@usine/runtime` and `@usine/cli` are composition roots, not another behavior package.

Campaign coordination is an in-progress behavior cluster owned by the runtime server's published-goal entry path. The current production slice owns committed Goal Contract validation, immutable publication identity, and the durable Campaign read projection; it may reuse Task Authority's SQLite host without overloading `TaskResult`, faking a per-Task GitHub Issue, or teaching Delivery Run about planning. The replacement target is the guardian-authored Task-list/submit loop: once Campaign admission and advancement own that behavior, an external guardian becomes an observer and exception handler only.

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

The Campaign boundary adds Goal Publication, Outcome, Task Proposal, readiness, and Campaign Evidence. It hands one admitted Ready Task to the existing leaf and consumes the resulting durable Task fact; it does not expose Planner transcripts, provider sessions, database transactions, or Git process details across the boundary.

## 6. Persistent server lifecycle and Coding Session lifecycle

The persistent local server is the coordinator host. [`packages/runtime/src/server.ts`](../packages/runtime/src/server.ts) creates a sequential Effect Scope, applies SQLite migrations, validates loopback binding, checks the durable active-Task count, starts the typed HTTP API, owns a `FiberMap` for Task execution, and installs release cleanup. On shutdown it closes transient listeners and the Effect scope, propagates `AbortSignal` to the active Delivery Run and adapters, and each adapter owns cleanup of its current-run resources. The official Codex SDK and App Server each own their current-run child; qualified OpenCode2 directly owns its sandboxed server child and private per-run directory.

At startup the server decodes durable Tasks. Nonterminal Tasks that have valid committed execution input are re-entered through the same run path, after recording a sanitized restart observation. `waiting` Tasks retain their lease and capacity slot but are not launched automatically. Persisted-state decode failures are rejected at the Task Authority boundary; invalid committed execution input is blocked during startup. A submitting CLI process may exit after admission because execution belongs to the server.

Campaign recovery extends this same fact-first rule. Startup must reconcile nonterminal Campaigns, active Task facts, Repository heads, capacity, and pending Planner requests, then perform the single next mechanical action for each eligible Campaign. It does not need to recover an LLM conversation. A lost low-watermark notification is repaired by reconciliation; an already-recorded Task or Planner proposal is not duplicated. The operating-system service manager may restart the server, but no launcher process, PID file, hook, or external guardian becomes durable Campaign authority.

Coding Session is a different lifecycle. [`CodexCodingSession`](../packages/coding-session/src/coding-session.ts) owns one provider run: profile resolution, static adapter selection, role policy, bounded environment, optional read-MCP setup, provider thread/turn, structured output parsing or optional final normalization, cancellation/deadline handling, adapter-specific cleanup of current-run resources, and capture of a host-local Session Archive. It returns a typed `SessionObservation`; the Delivery Run decides what durable Task fact follows. Provider thread IDs, raw events, transcripts, tool arguments, and raw error text do not cross the domain port or become Task authority.

The implemented `SessionRequest` is specific to implementer and reviewer Tasks. Requirement Proxy and Planner execution must reuse the proven provider-lifecycle primitives without passing a fake Task Contract or weakening Task role policy. Their first caller owns a narrow request and structured result for Spec or frontier work; only shared lifecycle behavior proven by that caller moves behind a common internal primitive.

Each implementer or reviewer run creates one versioned archive in the configured Session Archive storage, separate from SQLite. The archive records the strict caller-owned Task Contract and prompt, a whitelist-only effective profile snapshot, adapter/session identity, completed provider items, raw response, normalized output, usage, phase, failure, and outcome. Resolved Repository path/owner/name, project-check policy, and `delivery.baseBranch` are not part of the role Contract or archive. Provider maps and model catalog content are never retained in the archive. It is atomically replaced in the same directory, bounded per archive, and subject to finite retention; truncation, write failure, and pruning are explicit status/warning observations. A failed archive never changes the role result, Candidate, review, delivery, or terminal Task state. The typed Coding Session observation remains the provider-neutral result for one run; its evidence projection exposes only a sanitized requested profile and effective `{profileName, configSha256, adapter, model, modelProvider, reasoningEffort, serviceTier, developerInstructionsSha256}` fields, optional usage, and an opaque archive reference/status/completeness. `configSha256` is a digest-only identity of the full supported resolved profile and is separate from the archive profile snapshot's `sha256`, which validates only the persisted whitelist bytes. Provider thread/session identity remains archive-private. Task resources and history carry only bounded archive metadata/reference, never archive content.

The archive payload is intentionally sensitive. `archive list` and `archive manifest` expose metadata only; `archive export` is an explicit host-local CLI read of one validated archive ID and writes only that archive to stdout. Raw archive content is not served by the unauthenticated loopback HTTP API. Archive IDs and Task IDs are resolved internally and cannot select arbitrary filesystem paths. Archive directories and snapshots are forced private, and reads use a no-follow descriptor plus identity, profile-checksum, declared-byte-length, and hard-bound validation. Corrupt entries are skipped by list/Task cleanup while exact corrupt-ID reads remain typed failures. The profile snapshot is whitelist-only and includes selected identity/model/reasoning/developer-instruction fields plus a stable SHA-256 checksum. Meaningful completed provider evidence is retained explicitly, so its command, file-change, tool-argument, output, prompt, and response bytes may contain sensitive paths or other content. Process environment, credentials, forge capabilities, workspace identity, MCP URLs, headers, argv, hidden config, and private keys are not intentionally captured. A pruned archive remains available as a bounded metadata tombstone with `captureStatus: "pruned"`; `complete` and `partial` describe whether provider completion data was observed.

The server therefore owns Task fibers, durable re-entry, server lifecycle resources, and lifecycle authority; Coding Session owns provider execution semantics and current-run resources behind its adapter port. Neither a provider process nor an Effect fiber is a durable Task state machine.

## 7. Static adapter profile selection

A registered Repository supplies opaque implementer and reviewer profile names. Before activation, the Coding Session validates the safe name and resolves `<profile>.config.toml` from `CODEX_HOME` or the Codex default directory. A profile needs a nonblank model; supported configuration includes the current Codex model, reasoning, provider/catalog, verbosity/personality, service tier, and optional developer instructions. Invalid, unreadable, or unsupported configuration fails closed as `codex_profile_unusable`.

`USINE_CODEX_APP_SERVER_PROFILES` and `USINE_OPENCODE2_PROFILES` are comma-separated static profile selections. A name listed in the first selects exactly the bounded local Codex App Server adapter; a name listed in the second selects exactly the qualified OpenCode2 adapter; every other name selects the official `@openai/codex-sdk` adapter. A name in both lists is a configuration error. This choice is static per named profile and per activation. The selection values are consumed only by host-side Coding Session composition and are excluded from every provider worker environment. There is no fallback, registry, capability negotiation, automatic routing, or general runtime-compatibility claim. All three adapters implement the same task-oriented `run(request) -> typed observation` port. The App Server is not a second task authority, and OpenCode2 is not a general provider-support claim.

The coordinator still supplies the frozen Task Contract, role prompt, sandbox (`workspace-write` for implementer and `read-only` for reviewer), output schema, deadline, and cancellation. Profile model/provider/reasoning/service-tier values, credentials, and developer instructions are host-private composition inputs; they do not alter the Task Contract or durable Task model. `ai` + `@ai-sdk/openai`, when configured, is only a final role-output normalizer and is bounded by the same output schema and deadline.

`USINE_CODEX_PATH_OVERRIDE` is a host-private qualification/test input mapped directly to the SDK's public executable override, excluded from provider worker environments; normal operation uses the SDK's pinned runtime.

OpenCode2 is a source-internal, qualified adapter and is not part of the canonical supported-provider claim. Its Coding Session boundary owns both explicit OpenCode permission rules and the host sandbox. Implementer profiles allow reads and workspace edits; reviewer profiles allow reads but deny workspace edits. Both roles deny external-directory, task, question, web, LSP, loop, and skill permissions, with a deny-all catch rule. An unexpected V2 permission request is rejected through OpenCode's permission-reply endpoint and becomes a bounded typed authority interruption. OpenCode2 has no built-in equivalent to Codex “Approve for me”; the V2 permission reply may support a future Usine-owned reviewer, but this Issue does not build or imply that reviewer.

Before starting the owned OpenCode2 process, `@usine/coding-session` runs a real boundary probe. The probe verifies workspace read access, role-specific workspace write behavior, private adapter-state writes, denied external reads and writes, and denied writes from an inherited subprocess. Only a macOS host where `/usr/bin/sandbox-exec` successfully applies the generated deny-default Seatbelt profile may launch OpenCode2. The profile imports only macOS system allowances, names the workspace, private adapter state, Node runtime, and resolved OpenCode executable, and permits network egress only for provider/MCP transport. A failed or timed-out probe fails closed before provider startup. The current managed macOS host repeatedly rejects the strict profile application, so it is not evidence of OpenCode2 support. A prompt success, model refusal, OpenCode permission label, or process exit alone is never isolation evidence.

## 8. Candidate, checks, review, delivery, and GitHub capabilities

The implementer receives a detached worktree at the contract base or the current Candidate parent. The host, not the agent, freezes the Candidate: it checks that the worktree advances, is clean, is descended from both the prior parent and original base, and produces a full exact SHA. Git runs with `GIT_CONFIG_NOSYSTEM=1`, a null global config, and terminal prompting disabled; Forge credentials are absent.

Quality Gate runs the registered project command in a disposable exact-SHA checkout with an explicit reduced environment and bounded stdout/stderr. A passed check is required before review. The reviewer receives a fresh checkout, the Task Contract, the exact Candidate SHA, and check evidence. It does not inherit the implementer's workspace or conversation and must return an explicit schema-valid verdict. A missing/invalid/stale output is `inconclusive`, never approval.

Forge Delivery requires a passing exact-SHA check and exact-SHA semantic approval. It probes for an existing branch/PR before writing, pushes with a credential-scoped GitHub capability, and creates or verifies one approval attestation tied to the Task, authorization source, SHA, check, and review. Multiple, mismatched, or wrong-identity attestations quarantine delivery. A lost write response is reconciled by probing the same identity.

For merge-authorized contracts, Forge Delivery re-reads the live PR and attestation immediately before calling the GitHub merge endpoint. A changed head, mismatched attestation, non-mergeable platform state, or refusal does not create a merge fact and remains blocked; an unresolved response becomes explicitly retryable without changing the approved bundle. A later probe may record `merged` only when the PR is observed merged with an exact merge commit SHA and the approved head/PR identity still matches. GitHub platform policy is the final merge gate.

GitHub read access is optional and separate from Forge delivery. The registered opaque `githubReadProfile` resolves its own GitHub App capability, must bind to the same owner/name, and exposes only an allowlisted `github_issue_*`, `github_pull_request_*`, `github_file_get`, or `github_commit_get` tool set to the selected role through a local Streamable HTTP MCP server. Pull-request reads additionally require an authorized delivered-PR fact. Read credentials never become Forge credentials and never enter workers, prompts, MCP configuration, public resources, durable events, or logs.

## 9. Durable history and transient observation

Task Authority persists one ordered, Task-local `task_events` stream. Authority transactions create admission, activation, Candidate, check, review, repair, waiting/retry, delivery, recovery, blocker, and terminal facts/events with stable event identities. External Coding Session and recovery observations are accepted only through the sanitized observation schema. Event data is bounded and excludes secrets, paths, prompts, transcripts, argv, raw provider payloads, credentials, and private diagnostics; the evidence payload of `coding_session_completed` may carry only sanitized requested/effective profile identities and checksums, adapter, optional usage, normalizer usage, and an opaque archive reference, capture status, and completeness. Incremental `coding_usage_observed` events preserve provider and optional role-output-normalizer usage before a session completes or is interrupted. Its local correlation ID is not a provider thread/session identity. Duplicate event identities are idempotent; sequence order is assigned durably.

`task list` drains the complete set from the Task Authority's bounded ordered `GET /v1/tasks` pages. A raw response is one page; pass its `nextCursor` as `cursor` to continue. `task history` reads this durable stream after a sequence cursor. `task watch` replays history and then reads the authoritative Task resource, so it can recover an operator view without treating event text as state. `task evidence` drains history, rereads the current Task resource, and reports bounded Role Run observations joined to current Candidate, check, review, repair, and delivery facts. `usage` reads persisted `task_events` directly with optional Task, Repository, and epoch-millisecond bounds (`fromEpochMs` inclusive, `toEpochMs` exclusive); `occurredAtEpochMs` is session completion or interruption time, falling back to session start when no closing observation exists. It emits per-invocation rows and deterministic aggregates as JSON through its own stable bounded Task-ID cursor. It does not use the Task list. The CLI aliases `status` and `follow` remain compatibility surfaces; canonical resource commands are `server health|snapshot`, `repository list|get`, `task list|get|history|watch|evidence|retry`, and `usage`, with `register` and `submit` as mutation entry points.

Campaign evidence must reuse these Task and Role Run facts rather than copy their payloads. Each admitted Task and semantic role invocation carries a durable Campaign/Outcome association, allowing deterministic totals for uncached input, cached input, output, model/provider identity, elapsed time, review/repair rounds, accepted deliveries, replans, discarded proposals, and human touches. An episode review may propose a Project rule, skill, checker, evaluator, or routing change, but no lesson changes future authority or policy merely because a model generated it. Promotion requires versioned evidence and the applicable repository or user authority.

The server also exposes process-local `wait` and `subscribe` observation through an Effect `PubSub` hub. A listener chooses exactly one scope: Task, Repository, or the whole server. `wait` returns one new sanitized envelope or `null` on bounded timeout; `subscribe` emits a ready marker and future matching envelopes. These are best-effort producer-only notifications with a bounded dropping buffer. They have no durable cursor, acknowledgement, replay, resume, backpressure, or restart-recovery protocol. If a listener disconnects, the server shuts down, or it cannot keep up, the listener closes; callers must read current state/history when correctness matters.

External observers and supervisors are separate glue processes, not part of the Usine server or Task Authority. They use only existing generic loopback resources and mutations, plus process-local `subscribe` invalidations; an invalidation is not state, so correctness requires rereading current Task resources and durable history. The external bridge owns best-effort wake delivery, agent-product configuration/lifecycle, coalescing/retry, and one bounded replaceable MCP session. There is no durable cursor, ledger, replay, acknowledgement, second scheduler, agent-session store, or Hermes-specific server API/fact/event/persistence. Disconnect or restart starts fresh, and terminal transitions while offline may not produce individual wakes. Webhooks, MCP responses, and process-local state are observation evidence, not completion authority.

## 10. Recovery, retry, capacity, and isolation

Recovery is deterministic reconciliation, not replay of process operations. On re-entry the server reads the durable Task Contract, phase, revision, activation, Candidate, and effect identities; it probes Git/worktree/GitHub before repeating uncertain effects. Confirmed effects are recorded once, provably absent effects may be retried with the same stable identity, and an unresolved Forge effect remains durably waiting for explicit reconciliation. Proven identity conflicts are quarantined. A new writer receives a new activation fence and workspace; stale work cannot publish a Candidate. The first deadline is never extended by restart.

The default `USINE_ACTIVE_TASK_CAPACITY` is `1`; it must be a positive finite integer. Direct standalone Task admission retains its current bounded behavior: same-ID idempotency is checked before capacity rejection, and startup refuses readiness when durable active Tasks already exceed the configured limit. Campaign proposals are different: they remain durably planned or Ready without consuming active capacity, and the coordinator admits at most the available number of Ready Tasks. A Task terminal transition releases capacity and mechanically selects the next eligible Task. This is a domain frontier for one local coordinator, not a generic queue service, fairness framework, dynamic resizing mechanism, or distributed scheduler.

Isolation is capability-based:

| Actor | Workspace | Network | GitHub delivery credential |
|---|---|---|---|
| Implementer | Writable activation worktree | Provider/task environment | None |
| Project check | Disposable exact-SHA checkout | Host filesystem/network permissions with reduced explicit environment | None |
| Reviewer | Fresh read-only exact-SHA checkout plus scratch | Provider/task environment and optional bounded read MCP | No Forge credential |
| Delivery | No candidate execution | GitHub and configured Git remote | Short-lived host-scoped Forge capability |

Codex sandbox and host permissions are the default isolation mechanism. Containers, VMs, remote sandboxes, queues, and distributed runners are not hidden prerequisites or domain concepts.

## 11. Current evidence and limits

The repository currently provides focused evidence for the Task delivery leaf rather than the complete product or a production-scale benchmark. The most direct evidence is:

| Claim | Repository evidence | Limit of the evidence |
|---|---|---|
| Task Authority list pages, HTTP/API cursor continuation, and CLI page draining | [`packages/task-authority/tests/task-authority-sqlite.test.ts`](../packages/task-authority/tests/task-authority-sqlite.test.ts), [`apps/cli/tests/server-client.test.ts`](../apps/cli/tests/server-client.test.ts), [`tests/server-boundary.test.ts`](../tests/server-boundary.test.ts) | Does not claim concurrent mutation snapshots beyond the bounded cursor contract. |
| Lifecycle reducer, exact-SHA facts, waiting, explicit retry, merge authorization | [`packages/task-authority/tests/task-authority.test.ts`](../packages/task-authority/tests/task-authority.test.ts), [`packages/task-authority/tests/task-authority-sqlite.test.ts`](../packages/task-authority/tests/task-authority-sqlite.test.ts) | Does not prove every hostile database or Git failure mode. |
| Durable sanitized history and event identity | [`packages/task-authority/tests/task-events.test.ts`](../packages/task-authority/tests/task-events.test.ts) | History is Task-local; process-local subscriptions are separately best effort. |
| Durable usage rows, detailed token dimensions, explicit coverage, and persisted-event reporting beyond the Task list cap | [`packages/task-authority/tests/usage-report.test.ts`](../packages/task-authority/tests/usage-report.test.ts), [`tests/http-api-contract.test.ts`](../tests/http-api-contract.test.ts), [`apps/cli/tests/usage-command.test.ts`](../apps/cli/tests/usage-command.test.ts) | Each response page is bounded to 200 Tasks and carries a stable cursor; the CLI drains pages, and the page bound is not a pricing or capacity policy. |
| Persistent server, server-owned execution, restart re-entry, exact-head delivery and optional merge | [`tests/server-milestone.test.ts`](../tests/server-milestone.test.ts), [`tests/server-execution.test.ts`](../tests/server-execution.test.ts), [`tests/server-opencode2.test.ts`](../tests/server-opencode2.test.ts) | Hermetic fixtures and bounded scenarios do not prove broad GitHub ruleset or provider behavior. |
| Capacity admission, same-ID idempotency, slot release, and lowered-capacity startup refusal | [`tests/server-capacity.test.ts`](../tests/server-capacity.test.ts) | No performance claim for higher capacity, fairness, multiple runners, or dynamic resizing. |
| Process-local wait/subscribe and CLI history/watch projection | [`tests/server-subscription.test.ts`](../tests/server-subscription.test.ts), [`tests/server-follow.test.ts`](../tests/server-follow.test.ts), [`apps/cli/tests/server-client.test.ts`](../apps/cli/tests/server-client.test.ts) | No replay, acknowledgement, backpressure, or restart guarantee for transient listeners. |
| Static profile selection, bounded SDK/App Server/OpenCode2 adapters, cancellation, and output normalization | [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts), [`packages/coding-session/tests/opencode2-adapter.test.ts`](../packages/coding-session/tests/opencode2-adapter.test.ts), [`packages/coding-session/src/codex-profile.ts`](../packages/coding-session/src/codex-profile.ts) | OpenCode2 remains source-internal and qualified only on its evidenced host boundary; no general provider compatibility or automatic routing is claimed. |
| Bounded SDK/App Server/OpenCode2 Session Archive capture and host-local metadata/content operations | [`packages/coding-session/tests/session-archive.test.ts`](../packages/coding-session/tests/session-archive.test.ts), [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts), [`packages/coding-session/tests/opencode2-adapter.test.ts`](../packages/coding-session/tests/opencode2-adapter.test.ts) | Archive content is sensitive and intentionally requires explicit local export; archive persistence is non-authoritative. |
| Disposable checks, fresh review, stale review rejection, and credential-free Git | [`packages/quality-gate/tests/quality-gate.test.ts`](../packages/quality-gate/tests/quality-gate.test.ts), [`packages/candidate-workspace/tests/candidate-workspace.test.ts`](../packages/candidate-workspace/tests/candidate-workspace.test.ts) | Check output is bounded and environment policy remains host-specific. |
| Forge probe/retry, attestation identity, read MCP scoping, and merge effects | [`packages/forge-delivery/tests/forge-delivery.test.ts`](../packages/forge-delivery/tests/forge-delivery.test.ts), [`packages/forge-delivery/tests/github-read.test.ts`](../packages/forge-delivery/tests/github-read.test.ts), [`tests/runtime-policy.test.ts`](../tests/runtime-policy.test.ts) | Private live characterization is optional; no claim is made about every GitHub installation or ruleset. |
| One bounded external exact-head production run | [fund-manager Issue #52](https://github.com/ariga39/fund-manager/issues/52) and [PR #53](https://github.com/ariga39/fund-manager/pull/53) | It is one one-contract run; it does not establish retry recovery, scale, broader merge policy, or provider breadth. |
| First Repository-level factory trial | [Issue #363](https://github.com/ariga39/usine/issues/363) records the resulting direction correction. | The guardian still had to decompose the wish, author and start Tasks, and decide continuation. This falsifies the manual Task loop as the factory product but does not invalidate the leaf executor. |

These limits define current implementation evidence, not permission to redefine the product around the implemented subset. A green check, PR, process exit, event stream, or agent statement is evidence for a narrower fact; none independently proves Task or Campaign completion. Usine is not ready for another factory trial until one published goal can cause more than one dependent Task to be planned, executed through exact-SHA review, merged when authorized, and advanced without routine guardian commands while retaining Campaign usage evidence.
