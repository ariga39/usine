---
status: current
design_version: 1.1
updated: 2026-09-11
issue: https://github.com/ariga39/usine/issues/483
---

# Usine product design

## 1. Problem, product outcome, and boundary

Usine turns one guardian-authored, user-authorized Campaign plan into accepted Repository outcomes without making a person start, inspect, review, merge, or advance every delivery Task. The guardian uses the complete user and Repository context to prepare the bounded Goal Contract, Outcome Tree, and Task Proposals once. After that handoff, a deterministic coordinator owns durable ordering, liveness, gates, effects, Outcome reduction, and Campaign completion. Free-form agent conversation, repeated guardian submission, and an external script that advances each Task are not the product control plane.

The reusable Task delivery leaf admits one contract, isolates one Repository writer, freezes an exact Candidate SHA, runs project checks and fresh independent review, and delivers or explicitly merges the approved head. Campaign coordination uses that leaf, releases successors from accepted delivery facts, and assesses current Outcome requirements. Current gaps continue through correction and reassessment; acceptance requires satisfied criterion references to owning exact-SHA evidence. Genuine authority, product or inconclusive-evidence blockers produce a decision request.

A Campaign is one execution of a published Goal Contract. It is not a general project-management system or an unbounded task DAG. Its boundary is:

| Area | Product boundary |
|---|---|
| Host | One local loopback server with a finite active-Task capacity. |
| Work supply | The guardian publishes one Goal Contract and complete initial set of Outcome-traced Task Proposals. After handoff, the coordinator may continue attributable correction and recovery work from current Outcome evidence; it has no Campaign count or deadline ceiling. |
| Work ownership | One writer lease per registered Repository; one isolated workspace per activation; cross-Repository Tasks may run concurrently. |
| Planning handoff | The guardian owns semantic decomposition before handoff. Implementer, reviewer, assessor, and one bounded replacement-planner role have separate contracts inside the current factory loop. |
| Leaf execution | The existing Task delivery loop implements, checks, independently reviews, repairs, delivers, and optionally merges one Ready Task. |
| Provider | Host-selected profiles run bounded implementer and reviewer roles behind caller-owned contracts; provider process and transcript details remain outside domain authority. |
| Forge | GitHub for delivery and a bounded, role-scoped read surface through GitHub MCP. |
| Authority | A host-authorized published Goal Contract bounds repository, effect, delivery, and merge authority. Campaign-derived Tasks have unbounded counts and no deadline; explicit merge authority still gates merge. |
| Observation | Durable Campaign/Outcome/Task evidence plus best-effort process-local wait/subscribe observation. |
| Session Archive | Host-local, bounded Coding Session capture retrieved only by direct CLI operations. |

The current implementation proves the leaf loop, host-anchored committed Goal publication, durable Campaign Planned/Ready facts, automatic admission of eligible Ready proposals into the delivery leaf, deterministic successor release after accepted delivery, Outcome evidence reduction, attributable correction and recovery after current gaps assessments, explicit plan handoff, and terminal Campaign projection. Same-Repository overlap remains prohibited. Automatic initial semantic decomposition, a distributed scheduler or runner, automatic merge without contract authority, provider negotiation, another forge, a web dashboard, and a memory/vector database remain outside the boundary. Re-entry conditions are in [`DECISIONS.md`](DECISIONS.md).

## 2. End-to-end lifecycle

The root handoff is a complete initial Campaign plan: one immutable Goal Contract and its Outcome-traced Task Proposals, prepared by the guardian from the user-authorized wish and steering. In the local-server composition, the server's host-owned `USINE_GOAL_PUBLICATION_SOURCE` anchor must match the committed authority source; `authority.publish`, source prose, guardian prose, and model-writable file content cannot mint executable authority. The coordinator admits proposals only when they trace to a live Outcome, request a subset of the root authority, and have satisfied dependencies. It resolves the exact base SHA from durable Repository state when the Task becomes Ready; a proposal never invents a future SHA.

```text
wish + steering + Repository context
       │ guardian decomposition under user authority
       ▼
committed Goal Contract + complete bounded Task Proposal set
       │ host-authorized publication and proposal admission
       ▼
Campaign + accepted Outcome Tree + durable Task frontier
       │ Ready
       ▼
Task delivery leaf
       │ reviewed_pr when merge was not authorized
       │ merged when authorized and exact-head gates pass
       ▼
dependency release → next Ready Task or Outcome evidence reduction
       │
       ├── every required live Outcome evidenced → accepted
       ├── current assessment finds gaps → correction → delivery → reassessment
       └── no feasible correction or missing authority → blocked + decision request
```

The deterministic coordinator repeats the lower loop until verified acceptance, explicit abandonment, or a genuine product or authority blocker. Independent Tasks may continue around a blocked branch. An incomplete frontier is assessed and corrected before it can become acceptance; missing authority, inconclusive evidence or a completed no-feasible-work result produces a decision request instead of per-Task approval.

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

The coordinator is deterministic TypeScript. At Campaign scope it owns publication identity, Outcome and proposal admission, dependency readiness, active capacity, correction reservations, and completion reduction. At Task scope it owns leases, activation reservation, fact validation, stale-evidence rejection, retry decisions, exact-SHA gates, effect reconciliation, and terminal projection. A model may implement code or propose structured evidence or corrective work; it cannot publish authority, admit Task supply, or announce a terminal state. The optional `ai`/`@ai-sdk/openai` integration only normalizes a final role response into its schema and has no lifecycle authority.

The following invariants are product rules:

- A Goal Contract publication is immutable and idempotent. A guardian-authored revision authorized by the user creates a new version and explicitly supersedes affected Outcomes and proposals; it does not rewrite already observed delivery facts.
- A Task Proposal has no execution authority. Admission must trace it to one live Outcome and prove that its requested Repository, effects, and merge capability are within the Goal Contract envelope.
- After plan handoff, Campaign coordination alone owns Ready selection and Task advancement. Implementers, reviewers, guardians, hooks, and external observers cannot directly wake arbitrary roles or advance lifecycle state.
- The admitted Task Contract and any first deadline are immutable. New Campaign Tasks have no deadline; standalone Tasks retain their finite elapsed contracts. A same-ID submission returns existing facts only when contract hash, Repository identity, snapshot, and merge authority still match.
- Task Authority is the sole owner of Task state, writer lease, activation fence, accepted facts, and terminal facts. Its transaction updates the durable result, appends the corresponding event, and releases the lease on a terminal transition.
- A Candidate, check, review, attestation, and merge effect must identify the same full lowercase 40-character SHA. A stale revision, fence, candidate parent, or live PR head is rejected or quarantined.
- A fresh reviewer must return an explicit structured verdict. Process exit, provider success, a test exit code, an agent message, a hook, or an attestation cannot substitute for semantic approval.
- Merge authority is not implied by delivery authority. Only an admitted `authorization.merge: true` contract may produce `merged`.
- Forge credentials are resolved and used at the host delivery boundary. They are not exposed to implementers, reviewers, project checks, public resources, durable events, prompts, or worker environment variables.
- One Repository has at most one writer lease. Old activation workspaces are quarantined before a new writer is allowed to publish a Candidate.
- A dependent Task resolves and records its exact base only after predecessor acceptance. The initial serial policy retains a Repository's active delivery ownership through merge so an automatically selected successor starts from the observed accepted head; later overlap requires explicit base/conflict evidence.
- Normal execution and restart recovery use the same durable reconciliation path. An uncertain external effect is probed before retry; an ambiguous merge is not recorded as success.
- Campaign completion requires a current satisfied assessment for every required live Outcome, with each criterion bound to owning exact-SHA evidence. At apparent completion, remaining gaps continue through correction and reassessment; an empty Ready list or merged PRs are not acceptance. Inconclusive evidence and genuine product or authority blockers remain non-accepting.
- Durable state is authoritative. Process state, provider transcripts, hooks, transient subscriptions, and process-local event order are observations only.
- A replacement proposal is append-only and attributed to a persisted assessor verdict and exact evidence hash. The coordinator may supersede only a still-wholly-unowned source and records both sides of that lineage. Recoverable interruption, malformed output, and duplicate attempts may be retried without a lifetime opportunity limit. A completed semantic no-proposal result is a no-feasible-work blocker, not an infrastructure-failure substitute.

## 4. Domain facts and lifecycle

### 4.1 Campaign facts

Campaign coordination owns the policy between the guardian-authored plan and Task admission. Its caller is the runtime server's Goal publication, proposal and checkpoint entry path. It owns immutable publication, attributable requirements, proposal identity/order, authority validation, dependency readiness, correction reservations, and exact-evidence completion. Repository heads are resolved at readiness. These are Campaign domain facts, not a general queue or separate budget service.

The minimum durable meanings are:

| Fact | Meaning and owner |
|---|---|
| Goal publication | Immutable Goal Contract, authority envelope, host publication anchor result, optional warning threshold, and publication provenance. Campaign coordination owns admission; a model cannot self-publish it. |
| Campaign | One execution of a Goal publication, including status, current requirements and correction lineage. |
| Outcome | A required user-observable result, its acceptance evidence, dependencies, and live/superseded status. |
| Task Proposal | Guardian-authored or coordinator-admitted replacement execution unit with an idempotency key and Outcome trace. It has no lease, resolved base, or execution authority; the coordinator durably orders it and projects it as Planned, Ready, Blocked, or superseded. A replacement retains its assessment ID and exact evidence hash; a checkpoint revision also records the superseded source and its replacement. Its optional positive `delivery.issue` is same-Repository delivery metadata, not Campaign or Task authority. |
| Ready Task | An admitted immutable Task projection whose dependencies, authority, capacity, Repository state, and exact activation base have been resolved by the coordinator. The base is recorded from the registered Repository fact at the first Ready transition and is never proposal-supplied. If later reconciliation makes the proposal non-executable, its status changes but the historical Ready fact remains available for recovery. |
| Campaign evidence | Accepted Task delivery effects, Outcome observations, role usage, guardian plan or decision touches, and terminal reason linked to the Campaign. |

The guardian supplies a complete initial frontier before handoff. Handoff starts coordinator-owned admission; it does not prohibit later guardian corrections. A guardian may append a new proposal to a nonterminal Campaign within its existing live Outcome, Repository, effect and merge authority. Admission records whether the addition is authorized as an immutable fact. Current Outcome acceptance combines the original Goal criteria with these authorized additions, including additions whose execution proposal was later superseded or temporarily eligibility-blocked. Rejected authority cannot mint requirements; replacing an execution plan cannot revoke them. Initial Goal and admitted Task contracts remain unchanged, and historical terminal Campaigns are not backfilled or reopened.

At an exhausted frontier or explicit checkpoint, a current persisted `gaps` assessment permits a read-only replacement-planner attempt. The coordinator validates the candidate and its assessment/evidence lineage before appending work. At a checkpoint it may replace only a proposal with no historical Ready, admission, Task, review, delivery or evidence ownership and no live dependent; the planner must name an exposed source ID. The transaction appends the correction and records source supersession together. A checkpoint survives recoverable attempts and remaining unowned sources across Outcomes; unrelated activity cannot invent checkpoint authority. Further gaps may require further corrections. New Outcomes or broader external authority still require an explicitly authorized Goal revision.

The coordinator releases successor dependencies only from durable accepted Task facts. Each nonsuperseded proposal for an Outcome must have owning accepted delivery before that Outcome has complete delivery evidence. The reducer validates assessment references against current requirements and exact Task evidence. Late additions invalidate stale satisfaction without rewriting earlier contracts, checks, reviews or deliveries. Passing checks, PR creation, model assertions, empty frontiers, and process state do not satisfy an Outcome.

Campaign terminal meanings are deliberately small: `accepted` requires current satisfied assessments bound to exact evidence; `blocked` requires a genuine authority, product, no-feasible-work or assessment-inconclusive reason; `abandoned` requires explicit authority. Old quota-exhaustion terminal records remain readable, but new execution does not produce those reasons. Recoverable failed or malformed assessor/planner observations remain attributable and permit continuation, not acceptance. Repeated malformed attempts have no hidden cutoff; the external guardian observes usage and may abandon the work.

Campaign assessment and replacement-planner sessions have no Campaign deadline or per-call time ceiling. Their provider operations remain cancellable and their observations are fenced to the current Goal, Outcome, requirements, and exact evidence identity. Runtime persists late, interrupted, malformed, and otherwise non-accepting observations without fabricating acceptance; terminal Campaigns are not reopened.

An optional positive `warningThresholdMs` measures elapsed time from Campaign creation. Reconciliation or Campaign/evidence observation records one durable `warning` touch when a live Campaign crosses it. It never pauses work, cancels a call, consumes an attempt, requires acknowledgement or prevents acceptance. Repeated observation and restart do not duplicate it; automatic warnings are excluded from guardian-touch totals. Omission means no synthetic threshold. PostHog maps the existing observation to `usine_campaign_warning` without acquiring lifecycle authority.

Public abandonment first records the authorized terminal Campaign fact, then cancels its active Task/model work and pending pipeline recovery, awaits owned cleanup, and blocks remaining admitted Tasks to release leases and capacity. Retry and startup refuse abandoned work. Already observed effects and real usage remain; cancellation cannot retract a completed external effect or authorize a later delivery.

### 4.2 Task facts

References to Task budgets or deadlines below apply only to limits present in the admitted contract; they never introduce limits for new quota-free Campaign Tasks.

`@usine/task-authority` defines the domain types in [`task-state.ts`](../packages/task-authority/src/task-state.ts), the contract boundary in [`contract.ts`](../packages/task-authority/src/contract.ts), and the persisted decode boundary in [`task-state-schema.ts`](../packages/task-authority/src/task-state-schema.ts). A `TaskResult` contains the contract hash, monotonic revision, original deadline, state, immutable merge-authority projection, Candidate SHA and fence, check, review, delivery, blocker, waiting record, active activation, writer identity, Repository snapshot, and evidence counters.

The main facts are:

| Fact | Meaning and owner |
|---|---|
| Task Contract | Caller-owned scope, acceptance, non-goals, budget, root-authorization provenance, delivery data, and optional merge authority. Standalone admission requires a matching GitHub Issue; Campaign coordination admits bounded issue-less or Task-Issue-bearing Campaign-derived contracts and freezes their Campaign/Goal-version/Outcome association. |
| Run/activation | A durable implementer activation and monotonic fence. It is an attempt identity, not completion evidence. |
| Candidate | A host-verified clean Git commit descending from the recorded parent and original base. |
| Check Result | The registered project command's result in a disposable exact-SHA checkout, with bounded output. A pre-execution Quality Gate capability blocker is not a Check Result. |
| Review Verdict | A fresh reviewer result for the checked SHA: `approved`, `changes_requested`, or `inconclusive`. |
| Delivery Effect | Branch/PR identity, exact-SHA approval attestation, and optional observed merge effect. |
| Task event | A bounded, sanitized history projection for recovery and observation. It cannot reconcile state. |

New Campaign Goal and Proposal inputs contain no budget fields. Campaign admission supplies `null` for all three Task budget dimensions and omits `deadlineEpochMs`; no large number or infinite deadline substitutes for absence. Standalone Task Contracts retain positive finite elapsed budgets and finite-or-null implementation/review counts. Existing admitted finite contracts and their first deadlines remain readable and retain their meaning. Resource capacity, explicit per-command project-check bounds, transport/message bounds, cancellation, authority and exact-SHA gates remain in force.

The persistent representation is decoded with Effect Schema at the untrusted SQLite boundary. Existing Zod validation remains the external Task Contract boundary; six behavior packages remain Promise-based unless a caller-specific change proves that Effect removes duplicated validation, error mapping, or lifecycle code.

### 4.3 Task states and transitions

The legal state names are `admitted`, `waiting`, `candidate`, `checked`, `reviewing`, `reviewed`, `reviewed_pr`, `merged`, and `blocked`. `reviewed_pr`, `merged`, and `blocked` are terminal. `waiting` is a durable pause, not a terminal result.

| State | Meaning | Normal next facts |
|---|---|---|
| `admitted` | Contract admitted, lease held, no accepted Candidate yet. | Candidate, waiting, or blocked. |
| `waiting` | The implementer suffered a retryable turn-phase interruption, the Quality Gate demonstrated that its project-check shell could not start, a reviewer suffered a typed interruption, delivery ended with an unresolved external effect, an explicitly enabled external review gate has mutable pending evidence, or an allowlisted pipeline entry is not yet successful on the exact live PR head. The record stores the resume state, activation, and any typed reviewer failure class or public waiting diagnostic. | Delivery Run re-observes a project-check capability wait against the same Candidate on explicit retry, automatically claims one fresh reviewer attempt for an eligible reviewer interruption, and keeps implementer recovery, delivery reconciliation, and external-review release as explicit retry paths. Pipeline evidence is re-observed by the server for the same approved bundle until the original deadline or cancellation, including after restart; expiry, drift, or invalidity blocks. |
| `candidate` | A clean exact Candidate SHA was accepted under the current activation fence. | Check, a repair Candidate path, waiting, or blocked. |
| `checked` | A Check Result for the current Candidate exists. | Fresh review, repair activation after a failed check, waiting, or blocked. |
| `reviewing` | Delivery Run has atomically claimed one fresh reviewer attempt for the current Candidate and passing Check Result. | Review verdict, typed interruption recovery, cancellation release back to `checked`, or blocked. |
| `reviewed` | A review verdict for a passing check exists. | One aggregated repair activation, delivery, waiting, or blocked. |
| `reviewed_pr` | GitHub delivery and exact-SHA attestation succeeded without merge authority. | None. |
| `merged` | GitHub reported and the server observed an exact approved-head merge effect with a merge commit SHA. | None. |
| `blocked` | The coordinator recorded a classified product, provider, evidence, budget, delivery, or platform blocker. | None. |

Task Authority's reducer and the Candidate Workspace enforce the following lifecycle properties:

- A new Candidate clears check, review, delivery, and blocker evidence. The reducer requires its fence to equal the reserved activation and, after the first Candidate, requires its parent to be the accepted prior Candidate. Candidate Workspace separately requires the initial Candidate to descend from the contract base.
- A check must belong to the current Candidate. A review requires a passing check for that same SHA. A delivery requires a passing check and an `approved` review for that same SHA.
- `changes_requested` findings are recorded as one repair batch before one implementer activation. Individual findings do not each wake an agent.
- Only an implementer failure in the `turn` phase with `failureClass: "network"` or `"transient_transport"`, the Quality Gate's typed pre-execution project-check capability blocker, the Forge boundary's typed unresolved delivery outcome, a mutable external-review gate fact, or a reviewer interruption with a typed transient class (`transient_capacity`, `transient_transport`, `network`, or `timeout`) may become `waiting`. Delivery Run claims a fresh replacement reviewer while the original Candidate, passing Check Result, review budget, and deadline remain valid; each claim is one fresh attempt and an explicitly finite review-cycle limit stops further recovery. If the owning run is cancelled after reserving `reviewing`, Task Authority releases that reservation to `checked` without recording a verdict so restart can make a fresh bounded attempt. Deterministic protocol, configuration, authority, cancellation, unknown, and semantic inconclusive failures remain fail-closed; partial provider state never supplies recovery authority.
- `task retry` is an explicit compare-and-set transition. It preserves the original contract, Repository authority, Candidate fence, and deadline and returns to the stored resume state; a project-check capability wait returns to `candidate` for re-observation without reserving a writer, while the subsequent Delivery Run reserves the next activation only for implementer recovery. Delivery reconciliation and an external-review wait reuse the same approved Candidate/check/review bundle. Deadline exhaustion blocks the retry, while an exhausted activation budget is rejected only for implementer recovery. No external-review polling loop exists; after the independent reviewer changes GitHub-native facts, the guardian explicitly retries the waiting Task.
- `reviewed_pr` is the no-merge terminal. `merged` requires both immutable merge authority and a Delivery Effect whose approved head and PR number match the reviewed delivery; the merge commit SHA must also be exact.

## 5. Behavioral packages and composition

The six implemented behavior packages form the Task delivery leaf. Their package manifests and export barrels are the boundary evidence: [`packages/task-authority/package.json`](../packages/task-authority/package.json), [`candidate-workspace/package.json`](../packages/candidate-workspace/package.json), [`coding-session/package.json`](../packages/coding-session/package.json), [`delivery-run/package.json`](../packages/delivery-run/package.json), [`quality-gate/package.json`](../packages/quality-gate/package.json), and [`forge-delivery/package.json`](../packages/forge-delivery/package.json). `@usine/runtime` and `@usine/cli` are composition roots, not another behavior package.

Campaign coordination is a behavior cluster owned by the runtime server's published-goal entry path. The current production slice owns committed Goal Contract validation, immutable publication identity, durable Planned/Ready/Blocked/superseded projection, deterministic admission of Ready proposals through the existing leaf, release of eligible successors from accepted Task facts, reduction of accepted exact-SHA delivery into live Outcome evidence, read-only Outcome assessment at an exhausted frontier or explicit checkpoint, attributable correction/recovery with durable lineage, and terminal Campaign projection; it may reuse Task Authority's SQLite host without overloading `TaskResult`, faking a per-Task GitHub Issue, or teaching Delivery Run about planning. The Campaign plan handoff replaces the guardian-authored per-Task submit/continue loop: after supplying the complete initial plan, the guardian is an observer and exception handler.

| Package | Current caller | Policy hidden behind its port | Typed artifacts crossing the boundary |
|---|---|---|---|
| [`@usine/task-authority`](../packages/task-authority/) | Runtime and Delivery Run | Contract admission/immutability, Repository lease, CAS revision, legal state transitions, exact-SHA validation, durable persistence, sanitized Task history, and public projections. | `TaskContract`, `RepositorySnapshot`, `TaskResult`, `TaskFact`, `TaskEvent`, public resources. |
| [`@usine/candidate-workspace`](../packages/candidate-workspace/) | Runtime and Delivery Run; Quality Gate uses its checkout capability | Detached writer worktrees, clean commit/finalization, ancestry, disposable checkouts, credential-free Git environment, quarantine. | `WriterWorkspace`, `FrozenCandidate`, SHA and checkout callback. |
| [`@usine/coding-session`](../packages/coding-session/) | Delivery Run and Quality Gate | Role/sandbox policy, profile resolution, worker environment, prompt/output schema projection, provider turn lifecycle, cancellation, timeout, bounded observations, and host-local Session Archive capture. | `SessionRequest`, schema-valid role output, `SessionObservation`, provider-neutral observation, `SessionArchive`. |
| [`@usine/quality-gate`](../packages/quality-gate/) | Delivery Run | Project-check execution and fresh exact-SHA review in separate disposable checkouts; review output validation and finding projection. It owns the typed evidence that the project-check shell could not start. | `CheckResult`, `ProjectCheckCapabilityBlocker`, `ReviewAttemptObservation`, `ReviewVerdict`. |
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

The Campaign boundary adds Goal Publication, current Outcome requirements, Task Proposal, readiness, Campaign Evidence, and attributable assessment/planner attempts. It hands admitted Ready work to the existing leaf and consumes durable Task facts without exposing provider sessions, database transactions or Git process details. The read-only assessor receives current requirements and an exact-SHA projection of candidate, check, review and delivery facts. A schema-valid result is non-authoritative until the reducer resolves its criterion references. The read-only replacement planner receives current gaps, evidence identity, prior ownership, Repository facts and eligible checkpoint source IDs, and returns an untrusted proposal candidate. The coordinator alone appends validated work; prompts and transcripts remain private evidence.

## 6. Persistent server lifecycle and Coding Session lifecycle

The persistent local server is the coordinator host. [`packages/runtime/src/server.ts`](../packages/runtime/src/server.ts) creates a sequential Effect Scope, applies SQLite migrations, validates loopback binding, checks the durable active-Task count, starts the typed HTTP API, owns a `FiberMap` for Task execution, and installs release cleanup. On shutdown it closes transient listeners and the Effect scope, propagates `AbortSignal` to the active Delivery Run and adapters, and each adapter owns cleanup of its current-run resources. The official Codex SDK and App Server each own their current-run child; qualified OpenCode2 directly owns its sandboxed server child and private per-run directory.

At startup the server decodes durable Tasks. Nonterminal Tasks that have valid committed execution input are re-entered through the same run path, after recording a sanitized restart observation. Ordinary `waiting` Tasks retain their lease and capacity slot but are not launched automatically; a `waiting` Task with `review_interruption` resumes automatically when its deadline and review budget permit. A durable `reviewing` reservation is taken over on startup under the same deadline and review-budget checks. Persisted-state decode failures are rejected at the Task Authority boundary; invalid committed execution input is blocked during startup. A submitting CLI process may exit after admission because execution belongs to the server.

Campaign recovery reconciles nonterminal Campaigns, proposals, Task facts, Repository heads, capacity and current assessments through the same path used by Task events. It reserves fresh assessment work for changed requirements/evidence or a recoverable failed attempt, and fresh corrective work for current gaps. Pending reservations recovered after a crash remain attributable failures rather than consumed lifetime opportunities. Completed facts and source/replacement lineage are not duplicated; abandoned and other terminal Campaigns do not resume. Recovery needs durable facts, not a guardian/model conversation or launcher process as authority.

Coding Session is a different lifecycle. [`CodexCodingSession`](../packages/coding-session/src/coding-session.ts) owns one provider run: profile resolution, static adapter selection, role policy, bounded environment, optional read-MCP setup, provider thread/turn, structured output parsing or optional final normalization, cancellation/deadline handling, adapter-specific cleanup of current-run resources, and capture of a host-local Session Archive. It returns a typed `SessionObservation`; the Delivery Run decides what durable Task fact follows. Provider thread IDs, raw events, transcripts, tool arguments, and raw error text do not cross the domain port or become Task authority.

Task role requests carry the admitted Task Contract. Initial decomposition remains with the guardian; Campaign assessment and replacement planning use dedicated read-only requests, not fabricated Task Contracts. They carry current requirements and exact evidence, with gaps, prior ownership and eligible source IDs for replacement planning. Delivery Run and Quality Gate own Task context; Coding Session prepends its role-quality contract for every adapter and returns provider-neutral observations without lifecycle authority.

Role callers place useful stable instructions and requirements before changing evidence. Coding Session owns deterministic JSON object serialization for this context, preserving JSON omission and array order; Campaign callers additionally order evidence sets and allowlists without sorting criterion indices, dependencies or proposal history. Profile identity hashing is a separate contract. Host-only assessment timing/usage and Goal warning thresholds remain durable but do not enter planner prompts. Exact fact timestamps, assessment identity and evidence hashes remain model-visible.

| Role context owner | Stable context before changing facts | Changing suffix |
|---|---|---|
| Delivery Run implementer | Role instructions and frozen Task Contract | Parent SHA, failed checks or review findings |
| Quality Gate reviewer | Independent-review instructions and frozen Task Contract | Exact candidate SHA and project-check evidence |
| Campaign assessor | Assessment instructions and current Outcome criteria | Canonical exact evidence facts |
| Campaign replacement planner | Planning instructions, Goal/Outcome requirements, authority, prior proposal ownership and Repository facts | Current assessment, exact evidence and Repository heads |

Coding Session sends the composed prompt string and output schema through the adapter port. Dedicated assessment/replacement request objects are archive context, not additional model messages. The SDK adapter starts a fresh thread and passes the string and schema to `runStreamed`; App Server starts a fresh thread and sends one text input plus schema to `turn/start`; OpenCode2 creates a fresh session and sends the string as `prompt.text`. Usine does not share implementer/reviewer conversations or reuse verdicts. Static profile/tool settings and CLI-added system/workspace context also affect the provider-visible prefix.

The installed SDK's turn options expose schema and cancellation, not cache breakpoints; the current App Server and OpenCode2 paths likewise expose no qualified cache control in the Usine port. These CLI-owned limitations do not prevent improving caller text. A common text prefix is not a guarantee of an eligible persisted cache boundary or a hit: [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching) includes schema/tools and supported content boundaries, while [DeepSeek caching](https://api-docs.deepseek.com/guides/kv_cache) reuses persisted prefix units on a best-effort basis. No universal cache key, TTL, padding or cache-hit lifecycle gate is added.

To measure savings, compare cold and repeated requests, changed candidate SHA, and changed requirements within the same actual provider/model/role/settings group. Keep schema, tools and other CLI-added context comparable and record unavoidable changes such as checkout paths. Use existing observations to compare all-attempt input, cache-read/write, uncached and output tokens, usage coverage, latency and accepted outcome quality; include failures and mark missing usage as unavailable. Structural regression tests establish request properties, not live savings. Fix affected accounting before making numerical cost claims; a lower hit percentage can still accompany lower total input cost.

Each implementer or reviewer run creates one versioned archive in the configured Session Archive storage, separate from SQLite. The archive records the strict caller-owned Task Contract and the effective provider-visible prompt (caller Task context plus the Usine-owned role-quality contract), a whitelist-only effective profile snapshot, adapter/session identity, completed provider items, raw response, normalized output, usage, phase, failure, and outcome. Resolved Repository path/owner/name, project-check policy, and `delivery.baseBranch` are not part of the role Contract or archive. Provider maps and model catalog content are never retained in the archive. It is atomically replaced in the same directory, bounded per archive, and subject to finite retention; truncation, write failure, and pruning are explicit status/warning observations. A failed archive never changes the role result, Candidate, review, delivery, or terminal Task state. The typed Coding Session observation remains the provider-neutral result for one run; its evidence projection exposes only a sanitized requested profile and effective `{profileName, configSha256, adapter, configuredModel, configuredProvider, actualModel, actualProvider, model, modelProvider, actualModelProvider, reasoningEffort, serviceTier, developerInstructionsSha256}` fields, optional usage, and an opaque archive reference/status/completeness. `configuredModel` and `configuredProvider` identify the configured profile; `actualModel` and `actualProvider` identify provider-attested identity and remain unavailable when no attestation exists. The legacy `model`, `modelProvider`, and `actualModelProvider` fields remain as compatibility aliases. This effective-profile evidence contract is distinct from the archive whitelist snapshot. `configSha256` is a digest-only identity of the full supported resolved profile and is separate from the archive profile snapshot's `sha256`, which validates only the persisted whitelist bytes. Provider thread/session identity remains archive-private. Task resources and history carry only bounded archive metadata/reference, never archive content.
For official `@openai/codex-sdk` 0.154.0, interim usage comes only from the matching invocation's own session artifact under the configured `CODEX_HOME`. Unsupported artifact shape or location makes interim usage unavailable; Usine makes no claim that the CLI artifact format is stable. Missing artifacts and unreported tails remain unknown; reported cumulative subtotals are never estimates or complete totals. This is bounded observation at meaningful SDK boundaries, with no polling lifecycle or historical backfill. The private artifact reader is removed when the supported SDK supplies equivalent intermediate observations.

The archive payload is intentionally sensitive. `archive list` and `archive manifest` expose metadata only; `archive export` is an explicit host-local CLI read of one validated archive ID and writes only that archive to stdout. Raw archive content is not served by the unauthenticated loopback HTTP API. Archive IDs and Task IDs are resolved internally and cannot select arbitrary filesystem paths. Archive directories and snapshots are forced private, and reads use a no-follow descriptor plus identity, profile-checksum, declared-byte-length, and hard-bound validation. Corrupt entries are skipped by list/Task cleanup while exact corrupt-ID reads remain typed failures. The profile snapshot is whitelist-only and includes selected identity/model/reasoning/developer-instruction fields plus a stable SHA-256 checksum. Meaningful completed provider evidence is retained explicitly, so its command, file-change, tool-argument, output, prompt, and response bytes may contain sensitive paths or other content. Process environment, credentials, forge capabilities, workspace identity, MCP URLs, headers, argv, hidden config, and private keys are not intentionally captured. A pruned archive remains available as a bounded metadata tombstone with `captureStatus: "pruned"`; `complete` and `partial` describe whether provider completion data was observed.

The server therefore owns Task fibers, durable re-entry, server lifecycle resources, and lifecycle authority; Coding Session owns provider execution semantics and current-run resources behind its adapter port. Neither a provider process nor an Effect fiber is a durable Task state machine.

## 7. Static adapter profile selection

A registered Repository supplies opaque implementer and reviewer profile names. Before activation, the Coding Session validates the safe name and resolves `<profile>.config.toml` from `CODEX_HOME` or the Codex default directory. A profile needs a nonblank model; supported configuration includes the current Codex model, reasoning, provider/catalog, verbosity/personality, service tier, and optional developer instructions. Invalid, unreadable, or unsupported configuration fails closed as `codex_profile_unusable`.

`USINE_CODEX_APP_SERVER_PROFILES` and `USINE_OPENCODE2_PROFILES` are comma-separated static profile selections. A name listed in the first selects exactly the bounded local Codex App Server adapter; a name listed in the second selects exactly the qualified OpenCode2 adapter; every other name selects the official `@openai/codex-sdk` adapter. A name in both lists is a configuration error. This choice is static per named profile and per activation. The selection values are consumed only by host-side Coding Session composition and are excluded from every provider worker environment. There is no fallback, registry, capability negotiation, automatic routing, or general runtime-compatibility claim. All three adapters implement the same task-oriented `run(request) -> typed observation` port. The App Server is not a second task authority, and OpenCode2 is not a general provider-support claim.

The coordinator still supplies the frozen Task Contract, role prompt, sandbox (`workspace-write` for implementer and `read-only` for reviewer), output schema, deadline, and cancellation. Profile model/provider/reasoning/service-tier values, credentials, and developer instructions are host-private composition inputs; they do not alter the Task Contract or durable Task model. Coding Session's sanitized effective profile names the configured identity as `configuredModel`/`configuredProvider` and the optional provider-attested identity as `actualModel`/`actualProvider`; missing attestation remains unavailable and is never inferred from the configured identity. Legacy `model`, `modelProvider`, and `actualModelProvider` aliases remain for compatibility. `ai` + `@ai-sdk/openai`, when configured, is only a final role-output normalizer and is bounded by the same output schema and deadline.

`USINE_CODEX_PATH_OVERRIDE` is a host-private qualification/test input mapped directly to the SDK's public executable override, excluded from provider worker environments; normal operation uses the SDK's pinned runtime.

For Campaign assessment and replacement planning, Coding Session retains the selected profile's model, provider, authentication and static adapter selection but replaces inherited developer instructions with that role's evidence-only contract. The actual adapter request, effective configuration checksum and archive profile use the same resolved selection. Implementer and reviewer profile instructions are unchanged; host profile files are not modified.

OpenCode2 is a source-internal, qualified adapter and is not part of the canonical supported-provider claim. Its Coding Session boundary owns both explicit OpenCode permission rules and the host sandbox. Implementer profiles allow reads and workspace edits; reviewer profiles allow reads but deny workspace edits. Both roles deny external-directory, task, question, web, LSP, loop, and skill permissions, with a deny-all catch rule. An unexpected V2 permission request is rejected through OpenCode's permission-reply endpoint and becomes a bounded typed authority interruption. OpenCode2 has no built-in equivalent to Codex “Approve for me”; the V2 permission reply may support a future Usine-owned reviewer, but this Issue does not build or imply that reviewer.

Before starting the owned OpenCode2 process, `@usine/coding-session` runs a real boundary probe. The probe verifies workspace read access, role-specific workspace write behavior, private adapter-state writes, denied external reads and writes, and denied writes from an inherited subprocess. Only a macOS host where `/usr/bin/sandbox-exec` successfully applies the generated deny-default Seatbelt profile may launch OpenCode2. The profile imports only macOS system allowances, names the canonical workspace, private adapter state, Node runtime, and resolved OpenCode executable, permits network egress only for provider/MCP transport, and includes the host-validated local network bind/inbound clauses required by the child. The adapter serves only its loopback endpoint by always passing `--hostname=127.0.0.1`. The current Seatbelt network clauses permit wildcard listeners and do not establish a general firewall against non-loopback inbound traffic; the qualification claim concerns the owned server, not arbitrary listeners. Runtime startup uses the caller's signal and original deadline to wait for the installed child health endpoint before session creation or a model request. Individual local health requests are abortable and bounded so a stalled request cannot hide a healthy child; this does not shorten the overall startup deadline. Host qualification additionally requires an installed no-model startup to become healthy through loopback and verifies that an HTTP health request through the host's reachable non-loopback interface receives no response from that server. A failed or timed-out probe fails closed before provider startup. A host that rejects the strict profile or fails any probe is not evidence of OpenCode2 support. A prompt success, model refusal, OpenCode permission label, controlled fixture, wildcard bind result, or process exit alone is never qualification evidence.

## 8. Candidate, checks, review, delivery, and GitHub capabilities

The implementer receives a detached worktree at the contract base or the current Candidate parent. The host, not the agent, freezes the Candidate: it checks that the worktree advances, is clean, is descended from both the prior parent and original base, and produces a full exact SHA. Git runs with `GIT_CONFIG_NOSYSTEM=1`, a null global config, and terminal prompting disabled; Forge credentials are absent.

Quality Gate runs the registered project command in a disposable exact-SHA checkout with an explicit reduced environment and bounded stdout/stderr. A passed check is required before review. The reviewer receives a fresh checkout, the Task Contract, the exact Candidate SHA, and check evidence. It does not inherit the implementer's workspace or conversation and must return an explicit schema-valid verdict. A typed interruption before a verdict is interruption evidence, never a `Review Verdict` or approval; a completed stale output remains fail-closed as `inconclusive`.

Acceptance criteria may retain legacy strings or declare an immutable structured `id`, criterion text, mandatory status and optional `checkId`. Mandatory defaults to true; optional preferences do not independently block. Repeating an identical requirement deduplicates by meaning. Conflicting reuse of a structured ID is rejected; adding an obligation uses a new ID and relaxing/replacing existing authority requires an authorized Goal revision. Proposal evidence retains its original criterion metadata rather than acquiring the current Goal's meaning retroactively.

Repository registration owns selected host acceptance commands and their intended-public observation contract. Task admission freezes that configuration; Quality Gate runs selected mandatory checks after project preparation, against `USINE_CANDIDATE_PATH` in a disposable exact-SHA checkout. The caller owns a pinned verifier outside candidate write scope and its actual artifact/entry assertions. Usine does not freeze arbitrary host files or prove arbitrary semantics. Candidate self-checks cannot replace these selected host observations. The [operating route](AGENT_QUICKSTART.md#mandatory-acceptance-checks) defines registration and the caller's source/privacy responsibilities.

Each selected check records SHA, status, exit code, output digest and validated intended-public artifact/entry observation. Raw host output and verifier configuration are not forwarded to roles. A launched failed command remains ordinary repair evidence. Missing verifier, spawn failure or successful exit without a valid opted-in observation remains unavailable, not success or semantic rejection. Delivery Run records the Check Result and uses the existing candidate-fenced capability wait; explicit retry clears only the current check projection and rechecks the same candidate. Append-only check events preserve earlier acceptance observations across retry/restart.

Campaign coordination resolves structured mandatory satisfaction only from an owning current candidate/review/delivery bundle and, when selected, a passed substantive host-check observation. The bundle retains proposal, Task, Repository and exact SHA identity; a later candidate in the owning Repository invalidates earlier artifact satisfaction even if it omitted that criterion. Candidate ordering uses the existing durable `candidate_frozen` observation time, not proposal order, because dependencies can reorder execution. Missing observations or tied times across Tasks do not prove a unique current candidate and remain gaps. Original criterion identity is not derived from truncated display text. Missing current evidence reduces apparent satisfaction to gaps and ordinary correction/reassessment, not acceptance. Legacy string criteria preserve their existing delivery-reference compatibility.

Forge Delivery requires a passing exact-SHA check and exact-SHA semantic approval. It probes for an existing branch/PR before writing, pushes with a credential-scoped GitHub capability, and creates or verifies one approval attestation tied to the Task, authorization source, SHA, check, and review. Multiple, mismatched, or wrong-identity attestations quarantine delivery. A lost write response is reconciled by probing the same identity. A Campaign PR uses the human Outcome title and includes the Outcome, proposal acceptance criteria, and canonical Goal Issue link; at creation, Forge appends the candidate SHA, passed check, and fresh independent approval evidence, plus `Closes #N` only when the proposal supplied a same-Repository Task Issue. Standalone PR title/body and Issue behavior remain caller-owned.

Delivery reconciliation retries transport failures and HTTP 408/409/429/5xx without an attempt ceiling, subject to cancellation and any admitted finite deadline. Authentication, quarantine, selected-check/external-review waits, and other explicit nonretryable HTTP failures propagate to their existing owners. A quota-free Campaign can retain its writer lease while a transient or ambiguous effect remains unresolved; the guardian may abandon it. The 100 ms retry delay spaces probes, while per-request/message bounds protect transport resources; none proves Outcome failure or acceptance.

An optional host pipeline allowlist is also enforced at this Forge boundary. Non-empty
`USINE_FORGE_PROFILE_<PROFILE>_PIPELINE_CHECK_RUNS` JSON string-array elements select exact
check-run names, and `..._PIPELINE_STATUS_CONTEXTS` JSON string-array elements select exact
commit-status contexts. JSON arrays keep names containing commas as one entry. The boundary reads only
the selected endpoints for the current live PR head, selects the latest result by numeric GitHub ID,
and requires every selected result to be successful. Missing, non-success, stale, unavailable,
truncated, or ambiguous same-name multi-App evidence is not success. Empty or omitted lists disable
this product gate; non-selected results and GitHub required-check configuration are irrelevant to
it. The selected private-repository Checks and Commit statuses read capabilities are independent
and readiness reports only those that are configured. This product gate does not replace GitHub's
platform merge policy.

For merge-authorized contracts, Forge Delivery re-reads the live PR and attestation immediately before calling the GitHub merge endpoint. A changed head, mismatched attestation, non-mergeable platform state, or refusal does not create a merge fact and remains blocked; an unresolved response becomes explicitly retryable without changing the approved bundle. A later probe may record `merged` only when the PR is observed merged with an exact merge commit SHA and the approved head/PR identity still matches. Before any successful merged effect returns, Forge Delivery fetches the registered base branch into a private non-HEAD ref derived only from that exact SHA, verifies the fetched tip contains the observed merge commit, and verifies the commit resolves in the registered local repository. GitHub platform policy is the final merge gate.

Forge Delivery may also receive an explicit host-configured external-review policy. When enabled, its live-PR read requires one trusted native `APPROVED` review for the exact current head and blocks a trusted current-head `CHANGES_REQUESTED` review. The latest decisive review for each trusted identity governs that identity; a truncated native-review observation blocks the merge. Mutable external-review facts raise a typed pending outcome so Delivery Run records retryable `waiting` with `resumeState: reviewed` and the current candidate fence; they do not quarantine the Task. Trust uses GitHub-issued IDs: non-Bot user IDs, explicit verified `performed_via_github_app` App IDs, or canonical Bot logins whose App slug and stable App ID are verified through bounded GitHub Apps metadata. Names, body markers, copied wording, ordinary comments, and inline comments never authorize a merge. Omitted or explicitly disabled policy preserves the existing merge behavior. The bounded `github_pull_request_reviews` read surface projects native review state and exact reviewed commit, stable actor identity, bounded inline threads, and ordinary Pull Request comments for observation; it marks native review overflow and does not create external-review lifecycle facts or replace Usine's fresh exact-SHA review. There is no external-review polling loop: the guardian explicitly retries after the independent process changes GitHub-native facts. The pipeline allowlist is separate from this unchanged external-review behavior.

GitHub read access is optional and separate from Forge delivery. The registered opaque `githubReadProfile` resolves its own GitHub App capability, must bind to the same owner/name, and exposes only an allowlisted `github_issue_*`, `github_pull_request_*`, `github_file_get`, or `github_commit_get` tool set to the selected role through a local Streamable HTTP MCP server. Pull-request reads additionally require an authorized delivered-PR fact. Read credentials never become Forge credentials and never enter workers, prompts, MCP configuration, public resources, durable events, or logs.

## 9. Durable history and transient observation

Task Authority persists one ordered, Task-local `task_events` stream. Authority transactions create admission, activation, Candidate, check, review, repair, waiting/retry, delivery, recovery, blocker, and terminal facts/events with stable event identities. External Coding Session and recovery observations are accepted only through the sanitized observation schema. Event data is bounded and excludes secrets, paths, prompts, transcripts, argv, raw provider payloads, credentials, and private diagnostics; the evidence payload of `coding_session_completed` may carry only sanitized requested/effective profile identities and checksums, adapter, optional usage, normalizer usage, and an opaque archive reference, capture status, and completeness. Its canonical identity fields are `configuredModel`, `configuredProvider`, `actualModel`, and `actualProvider`; `actual*` fields are provider attestations and remain unavailable when no attestation exists. Incremental `coding_usage_observed` events preserve provider and optional role-output-normalizer usage before a session completes or is interrupted. Its local correlation ID is not a provider thread/session identity. Duplicate event identities are idempotent; sequence order is assigned durably.

Task Authority normalizes interrupted Coding Session observations into one stable bounded failure vocabulary. Task history, Task evidence, Campaign evidence, and PostHog reuse that typed fact instead of parsing provider diagnostics. Cancellation remains nonterminal run evidence and cannot become a terminal blocker classification.

`task list` drains the complete set from the Task Authority's bounded ordered `GET /v1/tasks` pages. A raw response is one page; pass its `nextCursor` as `cursor` to continue. `task history` reads this durable stream after a sequence cursor. `task watch` replays history and then reads the authoritative Task resource, so it can recover an operator view without treating event text as state. `task evidence` drains history, rereads the current Task resource, and reports bounded Role Run observations joined to current Candidate, check, review, repair, and delivery facts; its JSON and human-readable views use the same configured/actual identity vocabulary. `usage` reads persisted `task_events` directly with optional Task, Repository, and epoch-millisecond bounds (`fromEpochMs` inclusive, `toEpochMs` exclusive); `occurredAtEpochMs` is session completion or interruption time, falling back to session start when no closing observation exists. It emits per-invocation rows and deterministic aggregates as JSON through its own stable bounded Task-ID cursor, with explicit `configuredModel`, `configuredProvider`, `actualModel`, and `actualProvider` fields. It does not use the Task list. The CLI aliases `status` and `follow` remain compatibility surfaces; canonical resource commands are `server health|snapshot`, `repository list|get`, `task list|get|history|watch|evidence|retry`, and `usage`, with `register` and `submit` as mutation entry points.

Campaign evidence must reuse these Task and Role Run facts rather than copy their payloads. Each admitted Task and implementer/reviewer run carries a durable Campaign/Outcome association. Existing Goal publication and proposal records capture the plan handoff; additional guardian decision-touch facts belong at Campaign scope. The Task Authority provides a typed Campaign-scoped source list and owns raw Task decode/quarantine, batched event reads, and its bounded cursor. Campaign evidence owns aggregation and public projection. Together the owning facts must allow deterministic totals for uncached input, cached input, output, explicit configured and provider-attested actual model/provider identity, elapsed time, review/repair rounds, accepted deliveries, blocked proposals, and guardian touches. Campaign JSON and human-readable rows use `configuredModel`/`configuredProvider` and `actualModel`/`actualProvider`; unavailable actual identity stays explicit. An episode review may propose a Project rule, skill, checker, evaluator, or routing change, but no lesson changes future authority or policy merely because a model generated it. Promotion requires versioned evidence and the applicable repository or user authority.

The optional role-output normalizer decodes reported usage from its SDK response body, not SDK defaults for absent dimensions. It supports [standard Chat cache read/write fields](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/retrieve) and [compatible cache hit/miss fields](https://api-docs.deepseek.com/guides/kv_cache). Reported misses include separately reported writes; subtract those writes once when projecting uncached input. Without a reported miss count, deriving uncached input requires known total, reads and writes. Missing dimensions stay unavailable, and contradictory cache counts cannot become reliable cache evidence. A completed response whose output fails schema validation retains its observed usage; a transport failure without usage cannot supply final counts. Only whitelisted counts and existing safe identity observations enter durable evidence, never the raw response body.

Campaign evidence totals and plan/decision touches are Campaign-global and appear on the first page. Continuation pages carry `totals: null` and no touches; they do not rebuild the global history. Runs, aggregates, accepted deliveries, and coverage are page-scoped; the CLI drains the bounded pages and retains first-page totals when a complete operator report is needed. Task Authority preselects Campaign-associated JSON safely, then uses the existing historical decoder for page members and cursor endpoints; quarantined records cannot establish cursor membership. A cursor bounds Task IDs, not a transactional snapshot across requests: continuation progress reflects its current observation, while retained totals belong to the first-page observation. Concurrent changes may require a fresh traversal for a new complete report.

Optional PostHog observation projects these durable Campaign facts into batches. `$ai_model` and `$ai_provider` use provider-attested `actualModel`/`actualProvider` independently when available, otherwise the corresponding configured dimension, with `model_identity_source` and `provider_identity_source` recording `provider`, `configured`, or `unavailable`. Configured and actual identity remain separate; neither the adapter name nor model output supplies inferred identity. Runtime persistence is limited to successful-capture acknowledgements keyed by deployment and event UUID. Existing event-family UUID formulas remain unchanged; acknowledgements do not migrate historical identities. A 2xx batch response is the acknowledgement boundary; failed or ambiguous batches write none and remain eligible. A same-process local capture composition serializes overlapping captures, while a crash after remote acceptance and before acknowledgement may resend and relies on PostHog UUID deduplication. These acknowledgements never affect Campaign lifecycle or authority.

The server also exposes process-local `wait` and `subscribe` observation through an Effect `PubSub` hub. A listener chooses exactly one scope: Task, Repository, or the whole server. `wait` returns one new sanitized envelope or `null` on bounded timeout; `subscribe` emits a ready marker and future matching envelopes. These are best-effort producer-only notifications with a bounded dropping buffer. They have no durable cursor, acknowledgement, replay, resume, backpressure, or restart-recovery protocol. If a listener disconnects, the server shuts down, or it cannot keep up, the listener closes; callers must read current state/history when correctness matters.

External observers and supervisors are separate glue processes, not part of the Usine server or Task Authority. They use only existing generic loopback resources and mutations, plus process-local `subscribe` invalidations; an invalidation is not state, so correctness requires rereading current Task resources and durable history. The external bridge owns best-effort wake delivery, agent-product configuration/lifecycle, coalescing/retry, and one bounded replaceable MCP session. There is no durable cursor, ledger, replay, acknowledgement, second scheduler, agent-session store, or Hermes-specific server API/fact/event/persistence. Disconnect or restart starts fresh, and terminal transitions while offline may not produce individual wakes. Webhooks, MCP responses, and process-local state are observation evidence, not completion authority.

## 10. Recovery, retry, capacity, and isolation

Recovery is deterministic reconciliation, not replay of process operations. On re-entry the server reads the durable Task Contract, phase, revision, activation, Candidate, and effect identities; it probes Git/worktree/GitHub before repeating uncertain effects. Confirmed effects are recorded once, provably absent effects may be retried with the same stable identity, and an unresolved Forge effect remains durably waiting for explicit reconciliation. Proven identity conflicts are quarantined. A new writer receives a new activation fence and workspace; stale work cannot publish a Candidate. The first deadline is never extended by restart. A recovered invocation's closure timestamp is the actual recovery-observation time, so elapsed time includes downtime. Undecodable history is fail-closed and is never silently skipped to fabricate a closure.

The default `USINE_ACTIVE_TASK_CAPACITY` is `1`; it must be a positive finite integer. Direct standalone Task admission retains its current bounded behavior: same-ID idempotency is checked before capacity rejection, and startup refuses readiness when durable active Tasks already exceed the configured limit. Campaign proposals are different: they remain durably planned or Ready until the coordinator admits an eligible proposal through the leaf, subject to active capacity and one writer lease per Repository. An accepted Task terminal fact releases satisfied dependencies, and a same-Repository successor records the exact accepted merge head as its base. This is a domain frontier for one local coordinator, not a generic queue service, fairness framework, dynamic resizing mechanism, or distributed scheduler.

Isolation is capability-based:

| Actor | Workspace | Network | GitHub delivery credential |
|---|---|---|---|
| Implementer | Writable activation worktree | Provider/task environment | None |
| Project check | Disposable exact-SHA checkout | Host filesystem/network permissions with reduced explicit environment | None |
| Reviewer | Fresh read-only exact-SHA checkout plus scratch | Provider/task environment and optional bounded read MCP | No Forge credential |
| Delivery | No candidate execution | GitHub and configured Git remote | Short-lived host-scoped Forge capability |

Coding Session network access is role-specific. The Codex SDK and App Server receive
`sandbox_workspace_write.network_access = true` only for implementer sessions; reviewers,
assessors, and replacement-planners receive `false`. The workspace-write sandbox and all
credential boundaries remain in force, so this permits task-required dependency installation
and local loopback operations without granting Forge credentials or publication authority.
OpenCode2 retains its separately qualified host policy. A provider or host refusal remains a
host/provider restriction; denied operations cannot count as passing evidence. A tool failure
may occur inside an otherwise completed turn and is not automatically a typed failed Coding
Session. Existing typed startup/session refusal behavior remains unchanged.

Codex sandbox and host permissions are the default isolation mechanism. Containers, VMs, remote sandboxes, queues, and distributed runners are not hidden prerequisites or domain concepts.

## 11. Current evidence and limits

The repository currently provides focused evidence for the Task delivery leaf rather than the complete product or a production-scale benchmark. The most direct evidence is:

| Claim | Repository evidence | Limit of the evidence |
|---|---|---|
| Campaign evidence from public publication, proposal, and decision-touch paths | [`tests/campaign-evidence.test.ts`](../tests/campaign-evidence.test.ts), [`tests/http-api-contract.test.ts`](../tests/http-api-contract.test.ts) | Totals and plan/decision touches are Campaign-global and appear on the first page; runs, aggregates, accepted deliveries, and coverage are page-scoped. The fixture does not claim live-forge coverage. |
| Task Authority list pages, HTTP/API cursor continuation, and CLI page draining | [`packages/task-authority/tests/task-authority-sqlite.test.ts`](../packages/task-authority/tests/task-authority-sqlite.test.ts), [`apps/cli/tests/server-client.test.ts`](../apps/cli/tests/server-client.test.ts), [`tests/server-boundary.test.ts`](../tests/server-boundary.test.ts) | Does not claim concurrent mutation snapshots beyond the bounded cursor contract. |
| Lifecycle reducer, exact-SHA facts, waiting, explicit retry, merge authorization | [`packages/task-authority/tests/task-authority.test.ts`](../packages/task-authority/tests/task-authority.test.ts), [`packages/task-authority/tests/task-authority-sqlite.test.ts`](../packages/task-authority/tests/task-authority-sqlite.test.ts) | Does not prove every hostile database or Git failure mode. |
| Durable sanitized history and event identity | [`packages/task-authority/tests/task-events.test.ts`](../packages/task-authority/tests/task-events.test.ts) | History is Task-local; process-local subscriptions are separately best effort. |
| Durable usage rows, detailed token dimensions, explicit coverage, configured/provider-attested identity, and persisted-event reporting beyond the Task list cap | [`packages/task-authority/tests/usage-report.test.ts`](../packages/task-authority/tests/usage-report.test.ts), [`tests/http-api-contract.test.ts`](../tests/http-api-contract.test.ts), [`apps/cli/tests/usage-command.test.ts`](../apps/cli/tests/usage-command.test.ts) | Each response page is bounded to 200 Tasks and carries a stable cursor; the CLI drains pages, and the page bound is not a pricing or capacity policy. |
| Persistent server, server-owned execution, restart re-entry, exact-head delivery and optional merge | [`tests/server-milestone.test.ts`](../tests/server-milestone.test.ts), [`tests/server-execution.test.ts`](../tests/server-execution.test.ts), [`tests/server-opencode2.test.ts`](../tests/server-opencode2.test.ts) | Hermetic fixtures and bounded scenarios do not prove broad GitHub ruleset or provider behavior. |
| Capacity admission, same-ID idempotency, slot release, and lowered-capacity startup refusal | [`tests/server-capacity.test.ts`](../tests/server-capacity.test.ts) | No performance claim for higher capacity, fairness, multiple runners, or dynamic resizing. |
| Automatic Campaign dependency release, exact same-Repository merge-head handoff, cross-Repository reviewed-only release, and restart convergence | [`tests/campaign-admission.test.ts`](../tests/campaign-admission.test.ts), [`packages/forge-delivery/tests/forge-delivery.test.ts`](../packages/forge-delivery/tests/forge-delivery.test.ts) | Fixtures prove the deterministic server and bare-remote boundary; they do not claim live GitHub installation, ruleset, or production-scale behavior. |
| Process-local wait/subscribe and CLI history/watch projection | [`tests/server-subscription.test.ts`](../tests/server-subscription.test.ts), [`tests/server-follow.test.ts`](../tests/server-follow.test.ts), [`apps/cli/tests/server-client.test.ts`](../apps/cli/tests/server-client.test.ts) | No replay, acknowledgement, backpressure, or restart guarantee for transient listeners. |
| Static profile selection, bounded SDK/App Server/OpenCode2 adapters, cancellation, and output normalization | [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts), [`packages/coding-session/tests/opencode2-adapter.test.ts`](../packages/coding-session/tests/opencode2-adapter.test.ts), [`packages/coding-session/src/codex-profile.ts`](../packages/coding-session/src/codex-profile.ts) | OpenCode2 remains source-internal and qualified only on its evidenced host boundary; no general provider compatibility or automatic routing is claimed. |
| Bounded SDK/App Server/OpenCode2 Session Archive capture and host-local metadata/content operations | [`packages/coding-session/tests/session-archive.test.ts`](../packages/coding-session/tests/session-archive.test.ts), [`packages/coding-session/tests/coding-session.test.ts`](../packages/coding-session/tests/coding-session.test.ts), [`packages/coding-session/tests/opencode2-adapter.test.ts`](../packages/coding-session/tests/opencode2-adapter.test.ts) | Archive content is sensitive and intentionally requires explicit local export; archive persistence is non-authoritative. |
| Disposable checks, fresh review, stale review rejection, and credential-free Git | [`packages/quality-gate/tests/quality-gate.test.ts`](../packages/quality-gate/tests/quality-gate.test.ts), [`packages/candidate-workspace/tests/candidate-workspace.test.ts`](../packages/candidate-workspace/tests/candidate-workspace.test.ts) | Check output is bounded and environment policy remains host-specific. |
| Forge probe/retry, allowlisted pipeline evidence, attestation identity, read MCP scoping, and merge effects | [`packages/forge-delivery/tests/forge-delivery.test.ts`](../packages/forge-delivery/tests/forge-delivery.test.ts), [`packages/forge-delivery/tests/github-read.test.ts`](../packages/forge-delivery/tests/github-read.test.ts), [`packages/forge-delivery/tests/forge-readiness.test.ts`](../packages/forge-delivery/tests/forge-readiness.test.ts), [`tests/runtime-policy.test.ts`](../tests/runtime-policy.test.ts), [`tests/server-execution.test.ts`](../tests/server-execution.test.ts) | Private live characterization is optional; no claim is made about every GitHub installation or ruleset. |
| One bounded external exact-head production run | [fund-manager Issue #52](https://github.com/ariga39/fund-manager/issues/52) and [PR #53](https://github.com/ariga39/fund-manager/pull/53) | It is one one-contract run; it does not establish retry recovery, scale, broader merge policy, or provider breadth. |
| First Repository-level factory trial | [Issue #363](https://github.com/ariga39/usine/issues/363) records the resulting direction correction. | Guardian decomposition was retained, but repeated per-Task start and continuation were not. The trial falsified the manual Task loop, not a single guardian-authored Campaign plan handoff. |

These limits define current implementation evidence, not permission to redefine the product around the implemented subset. A green check, PR, process exit, event stream, or agent statement is evidence for a narrower fact; none independently proves Task or Campaign completion. The Campaign slice does not claim live-forge coverage or production-scale behavior.
