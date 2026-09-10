# Usine agent quickstart

This guide is for an agent operating Usine for an authorized project task. It is not the development guide for changing Usine; use [`DEVELOPMENT.md`](DEVELOPMENT.md) for that work.

Usine runs a local server. The server owns admission, execution, recovery, and public resource projections. The CLI is a client of that server. A submitting CLI process may exit after admission; the server continues the Task.

This guide operates the Task delivery leaf and guardian-authored Campaign entry path. The guardian prepares and submits one complete bounded plan; after handoff, the server admits eligible Ready proposals, advances successor Tasks, reduces accepted delivery into Outcome evidence, and projects the Campaign terminal state without per-Task direction. Do not use repeated standalone `submit` commands as a substitute for the Campaign behavior defined in [DESIGN](DESIGN.md).

## Continuous operating route

Use one continuous route for an authorized Campaign: configure the host, start the local server, register the Repository, publish the committed Goal Contract, submit its complete proposal set, inspect the durable Campaign, and hand it off exactly once. Leave the suitable default adapter selected unless the host has deliberately qualified one of the bounded alternatives; model/profile selection and adapter selection are separate host concerns. For a standalone Task, use the standalone contract and `submit` route in section 5; do not use repeated standalone submissions to advance a Campaign.

After handoff, keep the server running and observe `campaign get`, `task get`, `task history`, `task watch`, and `campaign evidence` as applicable. The server admits eligible proposals and advances dependent Tasks; routine progress, an empty frontier, a process exit, or a status message is not completion. Use only the explicit limits in the applicable committed Goal, Proposal, or Task Contract: a finite count limits that dimension, `null` leaves a count unbounded, and `maxElapsedMs` is the original deadline. A restart or retry does not create a new deadline or an invented per-step limit.

Use this state-to-action guide while observing:

- A running Campaign or Task: reread its current resource and durable history, then continue observing. Do not hand off again or create a replacement standalone Task.
- A typed transient reviewer interruption: Delivery Run automatically claims a fresh reviewer attempt while the Candidate, passing Check Result, review budget, and original deadline remain valid. The public Task may project `checked` while history shows the interrupted and fresh review attempts; do not invoke `task retry`.
- A `waiting` Task with `retryable: true`: inspect the current resource and history, then use the explicit same-Task retry only for the supported waiting reasons in section 6. It preserves the contract, authority, Candidate bundle where applicable, and original deadline.
- A user-authorized observation that is record-for-later: record its bounded decision touch, keep the work running, and do not waive a product gate.
- An explicit user stop, missing authority, or genuine terminal blocker: stop the scoped work and report the actual last observed state. Stopping the service is not a pause and does not freeze deadlines; do not abandon work without the contract's explicit abandonment authority.
- Merged deliveries with an inconclusive assessment: report the delivery and Campaign verdict separately. Merged artifacts alone do not make a Campaign accepted, and unavailable usage remains unavailable rather than zero.

When recovering in a fresh context, locate the current committed authority and reread the durable Campaign/Task resources and history; do not depend on an old transcript. The final report separates delivered Outcomes, actual Campaign status and assessments, exact final artifact checks, observability and usage coverage, unresolved problems, and checks not performed. If a service stopped before a reread, report the last observed durable state and label restart/reconciliation as unperformed rather than claiming a later state.

## 1. Prerequisites and build

You need:

- Node.js 24, as required by the repository [`package.json`](../package.json) and [`.node-version`](../.node-version);
- Corepack and the pinned pnpm package manager;
- Git and a clean, authorized target Repository;
- a Codex installation with named profile configuration for the implementer and reviewer;
- a GitHub App installation for the Forge profile when the Task can deliver to GitHub;
- an OpenAI-compatible API only if role-output normalization is needed.

From a fresh Usine checkout, run the locked install and build commands:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

The executable is `apps/cli/dist/cli.mjs`. The checks used to validate this documentation checkpoint are `corepack pnpm format:check`, `corepack pnpm check:links`, and `git diff --check`; repository development also defines the broader validation commands in [`DEVELOPMENT.md`](DEVELOPMENT.md).

## 2. Configure the host

Replace every `<PLACEHOLDER>` below before running a command. Keep these values in the server host environment or another host-private configuration mechanism. Do not put private keys, tokens, profile credentials, or local repository paths in a Task Contract, a public resource, a prompt, or a committed example.

### State and server connection

The server stores durable state in the operating system user state directory by default. Set `USINE_STATE_DIR` only when the host needs an explicit state directory. The server accepts loopback hosts only; its default port is `8787`.

```sh
export USINE_STATE_DIR="<STATE_DIRECTORY>"
export USINE_SERVER_HOST="127.0.0.1"
export USINE_SERVER_PORT="8787"
```

Session Archives use the same state root but a separate `session-archives` directory. Each archive is bounded to 5 MiB by default and retention keeps at most 100 archives. Hosts may lower either finite limit with:

```sh
export USINE_SESSION_ARCHIVE_MAX_BYTES="<POSITIVE_BYTE_LIMIT>"
export USINE_SESSION_ARCHIVE_MAX_COUNT="<POSITIVE_ARCHIVE_COUNT>"
```

Truncation, write failure, and pruning are reported as archive status/warnings and do not change the role or Task result. Workers do not receive the state root.

Clients derive their URL from `USINE_SERVER_HOST` and `USINE_SERVER_PORT`. Set `USINE_SERVER_URL` instead when the client must use a different loopback URL:

```sh
export USINE_SERVER_URL="<LOOPBACK_SERVER_URL>"
```

Do not expose the server beyond the host boundary. The HTTP API is a local coordination boundary, not an internet-facing service.

### Codex named profiles

The Repository registration names one opaque `implementerProfile` and one opaque `reviewerProfile`. Coding Session validates each selected name and resolves `<profile>.config.toml` in `CODEX_HOME`; when `CODEX_HOME` is unset, the Codex default configuration directory is used. The registration does not encode an adapter choice in either name.

Each selected profile must contain a nonblank `model`. The currently supported optional profile fields include `model_reasoning_effort` with one of `minimal`, `low`, `medium`, `high`, or `xhigh`, and a nonblank `developer_instructions`. The adapter also forwards the supported Codex configuration fields `model_catalog_json`, `model_provider`, `model_providers`, `model_reasoning_summary`, `model_verbosity`, `personality`, and `service_tier` when present. Usine still owns the Task Contract, role prompt, output schema, sandbox, approval policy, deadline, and credential boundary.

For example, a host-private profile file has this shape:

```toml
model = "<MODEL_NAME>"
model_reasoning_effort = "<minimal|low|medium|high|xhigh>"
developer_instructions = "<OPTIONAL_DEVELOPER_INSTRUCTIONS>"
```

The `developer_instructions` line is optional; remove it when it is not needed. An unreadable, malformed, unsupported, or missing profile is reported as `codex_profile_unusable` before provider execution.

The official Codex SDK adapter is used unless the profile name is listed in the comma-separated `USINE_CODEX_APP_SERVER_PROFILES` variable or the qualified OpenCode2 adapter is selected by `USINE_OPENCODE2_PROFILES`. A name in the first list uses the bounded local Codex App Server adapter; a name in the second uses OpenCode2; an unlisted name uses the SDK adapter. Names in both lists are rejected at configuration time. Selection is static per named profile and has no fallback, automatic routing, registry, capability negotiation, or general compatibility claim.

```sh
export USINE_CODEX_APP_SERVER_PROFILES="<APP_SERVER_PROFILE_NAME>"
export USINE_OPENCODE2_PROFILES="<OPENCODE2_PROFILE_NAME>"
```

Leave both variables unset when all registered profiles should use the SDK adapter. These selection variables are host-private and are not passed to provider worker processes. Only list profiles deliberately configured for the selected bounded adapter. OpenCode2 additionally requires the qualified macOS Seatbelt host boundary; it has no built-in equivalent to Codex “Approve for me”.

### Forge GitHub App profile

Create the Forge App in the GitHub account that owns the registered repository. In GitHub's
Developer settings, choose **GitHub Apps**, **New GitHub App**, and configure only the delivery
capability below:

- choose a stable App name/slug and leave webhooks inactive;
- set repository permissions to Contents: **Read and write**, Pull requests: **Read and write**,
  and Issues: **Read and write**;
- subscribe to no events; Usine uses authenticated API reads and explicit delivery effects;
- create a private key and download the PEM to a host-private path. Never commit or paste it into
  a registration file.

Install the App on the exact registered owner/name. The App's **About** section shows the App ID;
after installation, the browser URL ends with the installation ID (for example,
`/settings/installations/<INSTALLATION_ID>` or
`/organizations/<OWNER>/settings/installations/<INSTALLATION_ID>`). Record that positive integer
in the host environment. The installation must be granted access to the registered repository.

The registration's `forgeProfile` is an opaque lowercase kebab-case name. For a registration using `"release"`, the production GitHub App environment uses this exact key family:

```sh
export USINE_FORGE_PROFILE_RELEASE_APP_SLUG="<GITHUB_APP_SLUG>"
export USINE_FORGE_PROFILE_RELEASE_APP_ID="<GITHUB_APP_ID>"
export USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID="<GITHUB_INSTALLATION_ID>"
export USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH="<GITHUB_APP_PRIVATE_KEY_PATH>"
export USINE_FORGE_PROFILE_RELEASE_REPOSITORY="<GITHUB_OWNER>/<GITHUB_REPOSITORY>"
```

`USINE_FORGE_PROFILE_RELEASE_GIT_URL` is optional. When it is absent, the server derives the GitHub repository URL from the registered owner and name:

```sh
export USINE_FORGE_PROFILE_RELEASE_GIT_URL="<GIT_REMOTE_URL>"
```

The configured repository must match the registration's `owner` and `name`, case-insensitively. The App ID must be nonblank, and the installation ID must be a positive integer. Forge credentials are resolved only at the host execution boundary.

An external GitHub review gate is optional and host-configured alongside the Forge profile. Omit the following variables to preserve the current merge behavior. To enable the gate, set the decision explicitly and allowlist stable GitHub user or App IDs; login names and App slugs are not authorization values:

```sh
export USINE_FORGE_PROFILE_RELEASE_EXTERNAL_REVIEW_REQUIRE_APPROVAL="true"
export USINE_FORGE_PROFILE_RELEASE_EXTERNAL_REVIEW_TRUSTED_USERS="<GITHUB_USER_ID>,<GITHUB_USER_ID>"
export USINE_FORGE_PROFILE_RELEASE_EXTERNAL_REVIEW_TRUSTED_APPS="<GITHUB_APP_ID>"
```

Set `USINE_FORGE_PROFILE_RELEASE_EXTERNAL_REVIEW_REQUIRE_APPROVAL="false"` to configure an explicit disabled policy. A required gate with no matching trusted current-head approval, trusted current-head changes requested, or incomplete bounded native-review evidence records a retryable `external_review` wait after the PR is observed. After the independent reviewer changes GitHub-native facts, explicitly retry the Task; Usine does not poll, launch, host, credential, or supervise the external reviewer.

Install the Forge App on the registered repository with these repository permissions:

| Permission | Access | Used for |
|---|---|---|
| Contents | Read and write | Read the base and push the isolated candidate branch. |
| Pull requests | Read and write | Create, inspect, attest, and, when authorized, merge the exact candidate PR. |
| Issues | Read and write | Publish the exact-SHA attestation as an Issue/PR comment. |

Before the first Task, run the same read-only readiness check used by the operator entry path after
writing the host-private registration file in the registration section below:

```sh
node apps/cli/dist/cli.mjs forge readiness "<REGISTRATION_FILE>" --json
```

Success is reported as `"ready":true`. A nonzero result reports one bounded failure with
`expected`, `observed`, and `action`; it never prints credentials or provider error details. The
check authenticates the configured installation, reads its named permissions, and reads the exact
registered repository with the installation token. It does not enumerate repositories or create a
branch, Pull Request, comment, review, merge, or other repository effect.

### Optional GitHub read profile

Set `githubReadProfile` in the registration only when the roles need bounded GitHub context. The read profile is separate from the Forge profile and must bind to the same registered owner/name. For a read profile named `read-only`, the host configuration can use a separate GitHub App capability:

```sh
export USINE_GITHUB_READ_PROFILE_READ_ONLY_APP_SLUG="<READ_APP_SLUG>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_APP_ID="<READ_APP_ID>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_INSTALLATION_ID="<READ_INSTALLATION_ID>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_PRIVATE_KEY_PATH="<READ_APP_PRIVATE_KEY_PATH>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_REPOSITORY="<GITHUB_OWNER>/<GITHUB_REPOSITORY>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_IMPLEMENTER_TOOLS="github_issue_get,github_issue_comments"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_REVIEWER_TOOLS="github_issue_get,github_issue_comments,github_file_get,github_commit_get"
```

Grant the read App only the repository permissions needed by its enabled tools:

| Tools | Required repository permission |
|---|---|
| `github_issue_get`, `github_issue_comments` | Issues: read |
| `github_pull_request_get`, `github_pull_request_reviews` | Pull requests: read |
| `github_pull_request_checks` | Pull requests: read; Checks: read |
| `github_file_get`, `github_commit_get` | Contents: read |

The allowed tool names are `github_issue_get`, `github_issue_comments`, `github_pull_request_get`, `github_pull_request_reviews`, `github_pull_request_checks`, `github_file_get`, and `github_commit_get`. If a role-specific tool list is omitted, the current implementation enables the complete list for that role. The read capability is bound to the frozen Repository and Issue. Pull-request reads require an authorized delivered-PR fact; current pre-delivery role sessions have no delivered-PR binding, so the example enables only Issue, file, and commit tools. Read credentials do not become Forge credentials and do not enter worker environment variables or durable public resources.

### Optional role-output normalizer

The coordinator can normalize a provider response that is not direct JSON into the role's schema through an OpenAI-compatible API. This is optional and only applies to final role-output normalization. Configure all three variables together or leave all three unset:

```sh
export USINE_ROLE_OUTPUT_API_KEY="<ROLE_OUTPUT_API_KEY>"
export USINE_ROLE_OUTPUT_API_URL="<OPENAI_COMPATIBLE_BASE_URL>"
export USINE_ROLE_OUTPUT_MODEL="<ROLE_OUTPUT_MODEL>"
```

The API key remains in the coordinator host process. It is not passed to the worker or stored in Task facts.

### Optional PostHog evidence recording

Set the key to opt in. The URL is optional and must be a PostHog `/batch/` endpoint:

```sh
export USINE_POSTHOG_API_KEY="<POSTHOG_PROJECT_KEY>"
export USINE_POSTHOG_API_URL="https://us.i.posthog.com/batch/"
export USINE_POSTHOG_DEPLOYMENT="<DEPLOYMENT_LABEL>"
```

`USINE_POSTHOG_DEPLOYMENT` is required when PostHog is enabled. Use one stable non-empty label per Usine deployment; distinct labels let multiple deployments share one PostHog project without deduplicating equal Campaign or invocation evidence. The label is included on every event and scopes its stable event and AI trace identities. Missing or blank configuration disables capture. Usine projects sanitized Campaign evidence from durable facts and persists the minimum successful-capture acknowledgement for each deployment-scoped event UUID. A repeated capture or restart suppresses acknowledged events; a failed or ambiguous batch writes no acknowledgement and remains eligible for a later attempt. A 2xx `/batch/` response is the acknowledgement boundary. Capture failure is logged and does not block the factory; a crash after remote acceptance and before local acknowledgement may resend and relies on PostHog UUID deduplication. No prompts, completions, transcripts, paths, credentials, archives, URLs, or raw diagnostics are sent.

## 3. Publish a guardian-authored Campaign plan

Assessments and replacement planning use the original Goal deadline, including time elapsed before a restart; there is no separate one-minute limit. They retain the selected profile's model/authentication settings but use their own role instructions, so a reviewer-specific profile instruction does not require a local workaround. A late satisfied result cannot make the Campaign accepted, and existing terminal Campaigns are not reopened. See [the Campaign policy](DESIGN.md#41-campaign-facts).

Before handoff, the guardian uses the complete user and Repository context to prepare one bounded Goal Contract, Outcome Tree, and complete initial set of Task Proposals. The Campaign entry path reads the committed Goal Contract from the Git repository, rejects working-tree changes, and persists one immutable Campaign for each Goal ID and version. That publication can authorize Ready work only when its `authority.publish` field is explicitly `true` and the local server's host-owned `USINE_GOAL_PUBLICATION_SOURCE` matches the contract's authority source. A mismatched host anchor leaves the publication observable but blocks its proposals. Re-publishing the same bytes cannot repair that immutable fact; after correcting the anchor, publish a new Goal version. The source string, guardian prose, and `publish` flag are contract claims; none can authorize Ready work without the host anchor.

The current contract shape is shown below. Set `delivery` or `merge` to `true` only when the authority source explicitly grants that effect.

```json
{
  "schemaVersion": 1,
  "id": "<GOAL_ID>",
  "version": 1,
  "objective": "<AUTHORIZED_OBJECTIVE>",
  "outcomes": [
    {
      "id": "<OUTCOME_ID>",
      "title": "<USER_OBSERVABLE_OUTCOME>",
      "acceptance": ["<ACCEPTANCE_EVIDENCE>"],
      "dependsOn": [],
      "parentId": null
    }
  ],
  "authority": {
    "source": "<AUTHORITY_SOURCE>",
    "publish": true,
    "delivery": true,
    "merge": true,
    "repositories": ["<REPOSITORY_ID>"],
    "effects": ["<EFFECT_ID>"]
  },
  "budget": {
    "maxElapsedMs": 3600000,
    "maxTasks": 10,
    "maxImplementerActivations": null,
    "maxReviewCycles": null
  }
}
```

Commit the file, then publish and read its durable Campaign through the server:

```sh
node apps/cli/dist/cli.mjs campaign publish "<GOAL_CONTRACT_FILE>" --json
node apps/cli/dist/cli.mjs campaign get "<GOAL_ID>:v1" --json
```

Repeating publication of the same tracked bytes returns the same Campaign. Reusing the Goal ID and version with different committed bytes is rejected and does not rewrite the stored facts.

To authorize a local publication, start the server with the host-owned anchor and use the registered Repository and effect IDs in the Goal envelope:

```sh
export USINE_GOAL_PUBLICATION_SOURCE="<AUTHORITY_SOURCE>"
```

Each guardian-authored Task Proposal is bounded and Outcome-traced. Its current strict shape is:

```json
{
  "proposalId": "<PROPOSAL_ID>",
  "outcomeId": "<OUTCOME_ID>",
  "dependsOn": [],
  "repositoryId": "<REPOSITORY_ID>",
  "instructions": "<BOUNDED_IMPLEMENTATION_OUTCOME>",
  "acceptance": ["<TASK_ACCEPTANCE_EVIDENCE>"],
  "nonGoals": [],
  "effects": ["<EFFECT_ID>"],
  "budget": {
    "maxImplementerActivations": null,
    "maxReviewCycles": null,
    "maxElapsedMs": 3600000
  },
  "delivery": {
    "issue": 123
  },
  "merge": true
}
```

The optional `delivery.issue` is a positive GitHub Task Issue number in the proposal's Repository. It is delivery metadata, does not authorize the Campaign or Task, is not inferred from `instructions`, and may be omitted for issue-less Campaign Tasks. The proposal cannot include `baseSha` or extra fields. Its Outcome must be live, its Repository and effects must be included in the Goal authority envelope, each proposal budget must fit the corresponding Goal budget, and `merge: true` requires Goal merge authority. Goal delivery authority must be `true` for any proposal to execute, and the complete set must not exceed the Goal's `maxTasks`; later admission sequence entries are durably blocked when that limit is exhausted. Keep the complete proposal set in version control as guardian-owned recovery evidence; Git tracking is not proposal authority. Submit each proposal once as the initial handoff, then inspect the durable projection:

```sh
node apps/cli/dist/cli.mjs campaign propose "<GOAL_ID>:v1" "<PROPOSAL_FILE>" --json
node apps/cli/dist/cli.mjs campaign get "<GOAL_ID>:v1" --json
```

Each proposal is durably ordered by admission. A dependency-free eligible proposal is `ready` and carries the registered Repository's exact head captured at that transition. Dependencies remain unsatisfied until accepted delivery evidence exists; an unsatisfied dependency or authority mismatch remains `planned` or `blocked`. Repeated submission and server restart preserve identity, order, and the recorded Ready base, even when later reconciliation makes that proposal non-executable.

After every initial proposal has been submitted and checked, hand the fixed plan to the factory exactly once:

```sh
node apps/cli/dist/cli.mjs campaign handoff "<GOAL_ID>:v1" --json
```

Handoff freezes proposal supply and is the durable gate for Campaign Task admission. Before handoff, `planning` is an active, incomplete Campaign and an empty or partial frontier remains open for guardian proposals. After handoff, the server alone admits and advances eligible Tasks. It continues independent useful branches, and only accepted exact-SHA Task delivery associated with this Campaign, Goal version, and Outcome supplies Outcome evidence. Same-Repository dependencies additionally require an accepted merged effect; cross-Repository reviewed delivery keeps the existing rule. Passing checks, creating a PR, model assertions, and an empty frontier do not satisfy an Outcome.

The public projection remains `planning` while executable work can proceed, `accepted` only when every required live Outcome has owning accepted exact-SHA evidence and a current satisfied assessment bound to those facts, and `blocked` when no eligible useful branch remains. An exhausted or blocked fixed plan with live Outcomes carries one stable `decisionRequest`; it does not accept proposals after handoff or authorize ad hoc standalone Tasks. A host with the contract's explicit abandonment authority may terminate an unresolved Campaign:

```sh
export USINE_CAMPAIGN_ABANDONMENT_SOURCE="<AUTHORITY_SOURCE>"
```

`USINE_CAMPAIGN_ABANDONMENT_SOURCE` must exist in the server process environment. Start or restart the server after setting it, then run the CLI abandon command:

```sh
node apps/cli/dist/cli.mjs campaign abandon "<GOAL_ID>:v1" --json
```

The abandon command sends an empty request body; the separate host anchor is the authority. `abandoned` is terminal and cannot be replaced by handoff, new proposals, or later reconciliation. Campaign GET and restart preserve these durable statuses and decision-request identities.

Read one Campaign evidence report after the plan handoff:

```sh
node apps/cli/dist/cli.mjs campaign evidence "<GOAL_ID>:v1" --json
```

The report groups provider-neutral implementer and reviewer runs by Goal version, Outcome, Task, role, observed model/provider, and adapter. It keeps uncached input, cached input, and output token dimensions separate; an unavailable dimension remains `null`. It also reports review and repair cycles, blocked proposals, guardian plan and decision touches, and accepted exact-SHA deliveries. Plan touches are projected from the durable Campaign publication and admitted proposal facts, while decision touches are recorded through the Campaign touch path.

Evidence pages use a bounded Campaign Task cursor. Totals and plan/decision touch facts are Campaign-global and are returned on the first page; runs, aggregates, accepted deliveries, and coverage are page-scoped. The CLI drains all pages and recomputes the complete report. Record a bounded guardian decision through the public touch path:

```sh
node apps/cli/dist/cli.mjs campaign touch "<GOAL_ID>:v1" "<TOUCH_ID>" --json
```

Repeating the same touch ID is idempotent. Neither command exposes provider configuration, credentials, prompts, transcripts, archive content, or local profile data.

## 4. Register a Repository

Create a host-private JSON file and replace its placeholders. The registration schema is strict; the fields below are the current CLI shape. `githubReadProfile` may be `null` when the optional read capability is not configured.

```json
{
  "id": "<REPOSITORY_ID>",
  "path": "<AUTHORIZED_REPOSITORY_PATH>",
  "owner": "<GITHUB_OWNER>",
  "name": "<GITHUB_REPOSITORY>",
  "baseBranch": "<BASE_BRANCH>",
  "implementerProfile": "<CODEX_IMPLEMENTER_PROFILE>",
  "reviewerProfile": "<CODEX_REVIEWER_PROFILE>",
  "forgeProfile": "release",
  "githubReadProfile": null,
  "projectCheck": {
    "command": "<PROJECT_CHECK_COMMAND>",
    "timeoutMs": 120000
  },
  "gitAuthor": {
    "name": "<GIT_AUTHOR_NAME>",
    "email": "<GIT_AUTHOR_EMAIL>"
  }
}
```

`id`, profile names, owner/name, branch, and Git author values must be nonblank. `forgeProfile` and `githubReadProfile` use lowercase kebab-case. `projectCheck.timeoutMs` is a positive integer. The server keeps repository paths and profile names host-private; `repository list`, `repository get`, and Task resources expose only the safe Repository projection.

Start the server in the configured host environment and leave it running:

```sh
node apps/cli/dist/cli.mjs server
```

The process writes a JSON `server_ready` event with its URL. In another shell using the same client URL, register the Repository:

```sh
node apps/cli/dist/cli.mjs register "<REGISTRATION_FILE>"
```

Registration output is JSON. Confirm the public projection without expecting paths, profiles, or credentials:

```sh
node apps/cli/dist/cli.mjs repository get "<REPOSITORY_ID>" --json
```

## 5. Write and submit a Task Contract

The Task Contract is the immutable authorization input. Create it in the registered Repository, use a full lowercase 40-character `baseSha` that is an ancestor of the current checkout, and commit the file before submitting it. For a standalone Task, the authorization URL must be the canonical HTTPS GitHub Issue URL for the registered owner/name and must use the same positive issue number as `delivery.issue`. Campaign-derived Task Contracts are admitted only by Campaign coordination: they retain the Goal source and may carry the proposal's optional same-Repository Task Issue without requiring it to match that source.

Current contract shape:

```json
{
  "id": "<TASK_ID>",
  "repositoryId": "<REPOSITORY_ID>",
  "baseSha": "0000000000000000000000000000000000000000",
  "instructions": "<AUTHORIZED_TASK_INSTRUCTIONS>",
  "acceptance": [
    "<OBSERVABLE_ACCEPTANCE_CONDITION>"
  ],
  "nonGoals": [
    "<EXPLICIT_NON_GOAL>"
  ],
  "budget": {
    "maxImplementerActivations": null,
    "maxReviewCycles": null,
    "maxElapsedMs": 3600000
  },
  "authorization": {
    "source": "https://github.com/<GITHUB_OWNER>/<GITHUB_REPOSITORY>/issues/<ISSUE_NUMBER>",
    "delivery": true
  },
  "delivery": {
    "branch": "agent/<TASK_ID>",
    "issue": 1,
    "title": "<DELIVERY_TITLE>",
    "body": "<DELIVERY_DESCRIPTION>"
  }
}
```

Replace the all-zero example SHA, owner, repository, Task ID, and Issue number. `maxImplementerActivations` and `maxReviewCycles` accept positive integers or explicit `null` for no count limit. Use a finite count only when that limit is intended; do not infer it from the task's expected difficulty. Goal count fields also accept zero to authorize no attempts, and omitted Goal count fields retain that meaning. A finite Goal cannot authorize an unbounded proposal. Deadlines and all acceptance and authority gates still apply. Set `authorization.merge` to `true` only when the authorization explicitly grants merge authority:

```json
"authorization": {
  "source": "https://github.com/<GITHUB_OWNER>/<GITHUB_REPOSITORY>/issues/<ISSUE_NUMBER>",
  "delivery": true,
  "merge": true
}
```

Without that exact field, an approved delivery ends at `reviewed_pr`; it does not merge. The contract has no repository path, project-check policy, profile, or credential field because those facts belong to the registered host-side Repository.

Commit the contract file and verify that the checkout is clean before submission. Then submit it from the server client environment:

```sh
node apps/cli/dist/cli.mjs submit "<TASK_CONTRACT_FILE>"
```

The submitted Task Contract must be a regular file no larger than 1,048,576 bytes (1 MiB). The server rejects larger or non-regular inputs before JSON validation and admission.

`submit` returns the admitted Task resource as JSON. The server verifies that the contract is a committed file in the authorized Repository, is unchanged, and has an ancestor `baseSha`. Re-submitting the same Task ID returns its existing durable facts rather than creating a second Task.

## 6. Check health and observe the Task

The canonical read commands are:

```sh
node apps/cli/dist/cli.mjs server health --json
node apps/cli/dist/cli.mjs server snapshot --json
node apps/cli/dist/cli.mjs repository list --json
node apps/cli/dist/cli.mjs repository get "<REPOSITORY_ID>" --json
node apps/cli/dist/cli.mjs task list --json
node apps/cli/dist/cli.mjs task get "<TASK_ID>" --json
node apps/cli/dist/cli.mjs task history --after 0 --limit 200 "<TASK_ID>" --json
node apps/cli/dist/cli.mjs task watch --after 0 --timeout 60000 "<TASK_ID>" --json
node apps/cli/dist/cli.mjs task evidence "<TASK_ID>" --json
```

Human-readable output is the default for resource reads; add `--json` for the stable machine-readable projection. `server health` returns `status` and `revision`. `server snapshot` includes the server, registered Repository resources, Task list items, and coding-session resources. `task get` returns the Task state, exact-SHA evidence projections, delivery, blocker classification, waiting/retry flags, writer identity, and evidence counters without private policy facts.

`task list` drains the complete set of bounded Task pages before completing. A raw `GET /v1/tasks` returns one page; pass its `nextCursor` as `cursor` to continue until it is `null`.

`task history` reads persisted Task-local events after a non-negative sequence cursor; its limit is from 1 through 200. `task watch` repeatedly reads the current Task and durable event history, writes each observed event as one JSON line to stderr, and writes the final Task resource to stdout when the Task reaches a terminal state or `waiting`. `task evidence` drains paginated history, rereads the current Task, and reports separate implementer/reviewer Role Runs joined to the current bounded Candidate, check, review, repair, and delivery facts. It has no live-event cursor to resume: start with `task history`, `task watch --after <LAST_SEQUENCE>`, or `task evidence` when recovering an operator view. The compatibility aliases `status` and `follow` remain available, but `task get`, `task watch`, and `task evidence` are the canonical Task reads.

### Usage export

Export all persisted usage as JSON, or narrow it by Task, Repository, and an inclusive/exclusive epoch-millisecond range:

```sh
node apps/cli/dist/cli.mjs usage --json
node apps/cli/dist/cli.mjs usage --task-id "<TASK_ID>" --json
node apps/cli/dist/cli.mjs usage --repository-id "<REPOSITORY_ID>" --json
node apps/cli/dist/cli.mjs usage --from-epoch-ms 1710000000000 --to-epoch-ms 1710086400000 --json
```

The CLI drains all bounded `/v1/usage` pages and recomputes complete selected-scope aggregates. `occurredAtEpochMs` is completion/interruption time, falling back to session start; unavailable dimensions remain `null` and the report remains incomplete rather than presenting zero.

### Controlled implementer-profile evaluation

The operator can run one committed, bounded paired evaluation through the CLI:

```sh
node apps/cli/dist/cli.mjs profile evaluate "<EVALUATION_PLAN>" --subject-role implementer --json
```

The committed plan uses exactly this schemaVersion 1 shape:

```json
{
  "schemaVersion": 1,
  "id": "evaluation-plan",
  "repositoryId": "evaluation",
  "baseSha": "<40-CHARACTER_BASE_SHA>",
  "subjectRole": "implementer",
  "changedFactor": "model_stack",
  "baselineProfile": "baseline-profile",
  "candidateProfile": "candidate-profile",
  "reviewerProfile": "fixed-reviewer",
  "maxTasks": 2,
  "usineBuild": "<40-CHARACTER_USINE_COMMIT_SHA>",
  "reportPath": "reports/evaluation-report.json",
  "registrationPath": "repository.json",
  "pairs": [
    {
      "id": "case-one",
      "repetition": 1,
      "baselineContractPath": "baseline.json",
      "candidateContractPath": "candidate.json"
    }
  ]
}
```

`changedFactor` is exactly one of `model_stack`, `reasoning`, or `developer_instructions`. `model_stack` covers the model, provider, provider-map, and catalog configuration used to serve it; the adapter remains fixed. Every pair must keep its base SHA, Task semantics, budgets, project-check registration, and non-merge authority fixed. `usineBuild` must equal the exact commit observed in the Usine source checkout by the invoking CLI. It identifies the source revision used for this check; it does not attest to a separately bundled artifact or server build. `reportPath` is a Repository-relative output path and is written as deterministic JSON after a successful run. `registrationPath` identifies the complete prior host-side registration to restore; keep that file out of committed or GitHub-facing content when it contains host paths.

The command validates the complete plan, committed unchanged inputs, profile configurations, and existing Task identities before its first registration mutation or submission. It switches only the implementer profile, runs baseline then candidate serially, reuses completed Task IDs, waits for admitted Tasks, and restores the prior registration after success, failure, cancellation, or interruption to the extent the existing registration boundary permits. A Task with an active writer prevents profile switching.

The report uses only public `task evidence` facts. A passing exact-SHA project check and fresh approved review are required before effort can affect the result; drift, missing evidence, failed checks, interruptions, and unavailable usage remain explicit and produce an `inconclusive` recommendation. Session Archive content is never scoring input.

### Controlled reviewer-profile evaluation

The operator can compare two named reviewer profiles over frozen externally labelled Candidate cases:

```sh
node apps/cli/dist/cli.mjs profile evaluate "<EVALUATION_PLAN>" --subject-role reviewer --json
```

The committed plan uses this schemaVersion 1 shape:

```json
{
  "schemaVersion": 1,
  "id": "reviewer-evaluation-plan",
  "repositoryId": "evaluation",
  "baseSha": "<40-CHARACTER_BASE_SHA>",
  "subjectRole": "reviewer",
  "changedFactor": "model_stack",
  "baselineProfile": "baseline-reviewer",
  "candidateProfile": "candidate-reviewer",
  "maxRuns": 2,
  "usineBuild": "<40-CHARACTER_USINE_COMMIT_SHA>",
  "reportPath": "reports/reviewer-evaluation-report.json",
  "registrationPath": "repository.json",
  "cases": [
    {
      "id": "case-one",
      "repetition": 1,
      "contractPath": "case-contract.json",
      "candidateSha": "<40-CHARACTER_CANDIDATE_SHA>",
      "checkPath": "case-check.json",
      "labelPath": "case-label.json"
    }
  ]
}
```

Each case names committed unchanged Task Contract, exact-SHA check evidence for the registered project-check command, and an external expected verdict with rationale and reference. Both profiles run serially through the existing Quality Gate over the same Candidate cases; correctness, including protected-case false approvals, is evaluated before elapsed time, tokens, and bounded tool failures. No Task, Repository, delivery, or merge authority is created. The local report retains bounded experimental effective profile/model identity and Session Archive metadata for attribution, never archive content. Credentials, endpoints, host paths, and transcript content remain private. `registrationPath` is resolved relative to the plan file and must remain inside the evaluation Repository. It identifies a host-local registration file that need not be committed because it may contain the host path; its contents must stay out of committed or GitHub-facing material.

### Session Archive operations

Session Archive content is sensitive: it can contain the strict authorized Task Contract and effective provider-visible prompt, whitelist-only profile evidence, provider tool arguments/output, raw response, and normalized output. Resolved Repository facts and project-check policy are not copied into the role Contract or archive. Normal Task resources, snapshots, logs, history, and `task evidence` expose only bounded archive metadata/reference: an opaque archive ID, capture status, and completeness. Archive content is never returned by the loopback HTTP API; a pruned archive has no retrievable content and is unavailable to `task evidence`.

Use the host-local CLI against the configured state root. Listing and manifest inspection are metadata-only:

```sh
node apps/cli/dist/cli.mjs archive list "<TASK_ID>" --json
node apps/cli/dist/cli.mjs archive manifest "<ARCHIVE_ID>" --json
```

Export requires an explicit, validated archive ID and writes only the selected archive to stdout. Treat the output as sensitive and redirect it to a host-private destination:

```sh
node apps/cli/dist/cli.mjs archive export "<ARCHIVE_ID>" > "<PRIVATE_ARCHIVE_EXPORT>"
```

Remove one exact archive or all archives for one Task:

```sh
node apps/cli/dist/cli.mjs archive cleanup --archive-id "<ARCHIVE_ID>"
node apps/cli/dist/cli.mjs archive cleanup --task-id "<TASK_ID>"
```

Malformed, traversal, absolute, missing, corrupt, and symlink IDs fail rather than selecting another path. A valid pruned ID returns its bounded metadata tombstone with `captureStatus: "pruned"` from manifest or export. Cleanup reports the exact archive IDs removed.

### Transient wait and subscribe

For one new event, use the loopback API with exactly one scope: `taskId`, `repositoryId`, or neither for the whole server:

```sh
curl "<SERVER_URL>/v1/events/wait?taskId=<TASK_ID>&timeoutMs=30000"
```

The response is one sanitized `{ "taskId", "repositoryId", "event" }` envelope, or JSON `null` after the bounded timeout. A subscription is Server-Sent Events and starts with a ready marker before future matching events:

```sh
curl -N "<SERVER_URL>/v1/events/subscribe?taskId=<TASK_ID>"
```

These listeners are transient. They have no replay cursor, acknowledgement, resume, or restart-recovery contract; `after` and `limit` are not accepted. Read the current Task resource or durable history before opening a listener when current state matters. Disconnecting, a server shutdown, cancellation, or a listener that cannot keep up releases the listener.

## 6. Bounded retry

A typed transient reviewer interruption is recovered automatically by Delivery Run. The fresh reviewer attempt uses the current Candidate and passing Check Result under the original review budget and deadline. It is distinct from the explicit implementer, delivery, and external-review retry routes below; do not create replacement work or invoke `task retry` for it.

The explicit `waiting`/`task retry` route covers an implementer turn-phase interruption with failure class `network` or `transient_transport`, an unresolved Forge delivery effect, or mutable evidence from an explicitly enabled external-review gate. The public Task projection then has a retryable waiting reason:

```json
{
  "state": "waiting",
  "waiting": { "reason": "network_interruption" },
  "retryable": true
}
```

An unresolved delivery effect uses `"reason": "delivery_reconciliation"` and retains the approved Candidate, check, and review. Its explicit retry probes that same approved bundle; it does not start an implementer or reviewer or consume an implementer activation.

An external-review wait uses `"reason": "external_review"` and also reuses the approved Candidate, check, and review bundle after the independent process changes the GitHub-native facts. It does not poll or launch that independent reviewer. The implementer `network` and `transient_transport` cases resume the recorded phase only when the applicable activation budget and original deadline remain available.

Retry it explicitly:

```sh
node apps/cli/dist/cli.mjs task retry "<TASK_ID>" --json
```

The retry resumes the recorded Task phase with the original contract, deadline, and Repository authority. Delivery reconciliation and external-review recovery reuse the approved bundle and require the original deadline; implementer recovery reserves the next implementer activation and also requires its applicable count budget. Reviewer interruption recovery is automatic and is not this mutation. Restart alone, re-submission, project-check failures, provider configuration failures, deterministic reviewer failures, and other non-retryable classes do not enter this explicit path. A retry against a non-waiting Task returns a retry conflict.

## 7. Recovery and final report

After a restart or recovery in a fresh context, reread the current Campaign and Task resources, durable Task history, and Campaign evidence before taking an action. Reconcile the current exact Candidate, Check Result, Review Verdict, Delivery Effect, deadlines, budgets, waiting reason, blocker, and assessment; process state, transcripts, hooks, and old instructions are not authority. A service shutdown proves only that the process stopped, not that a deadline was paused or a later durable state was reached.

Report these facts separately:

- Delivered Outcomes: each accepted exact-SHA delivery, Pull Request, merge observation, and final artifact check.
- Campaign verdict: the actual Campaign status and each Outcome assessment. Call it accepted only when every required live Outcome has a satisfied assessment mechanically bound to current exact-SHA evidence.
- Observability: the resources, history, evidence pages, and usage actually read. Keep unavailable usage or coverage as `null`/`unavailable`; never turn missing dimensions into zero.
- Unresolved problems: blockers, missing authority, drift, inconclusive assessments, and failed gates. Do not waive or silently rerun a product gate.
- Unperformed checks: anything not reread, reconciled, or verified after a stop or restart. State the last observed durable resource rather than claiming a later state.

The server's default active-Task capacity is 1. A full capacity returns a retryable API error; wait for an active Task to become terminal before submitting another Task or adjust `USINE_ACTIVE_TASK_CAPACITY` to a positive finite value appropriate for the host. Capacity is a bounded admission setting, not a queue.

## 8. Stable exit codes

The CLI writes structured diagnostics to stderr. These exit codes are stable:

| Code | Meaning |
|---:|---|
| `0` | Command succeeded. |
| `2` | Usage or command parsing failure. |
| `3` | Requested Repository or Task was not found. |
| `4` | A watch or request timed out. |
| `5` | The client could not connect to the server. |
| `6` | The server rejected or failed the operation, including capacity and retry conflicts. |
| `7` | Input or server validation failed. |

## 9. Troubleshooting

- `command not found`, an install error, or a missing `dist/cli.mjs`: use Node 24, run `corepack enable`, then run `corepack pnpm install --frozen-lockfile` and `corepack pnpm build` from the Usine checkout.
- Connection exit code `5`: keep `server` running, and make `USINE_SERVER_URL` agree with the server host/port settings. The server accepts loopback hosts only.
- `invalid_repository_registration` or validation exit code `7`: check the strict registration shape, nonblank fields, lowercase kebab-case Forge/read profile names, positive `projectCheck.timeoutMs`, and a resolvable `<AUTHORIZED_REPOSITORY_PATH>`.
- `invalid_task_contract`: check for extra or missing keys, a lowercase 40-character `baseSha`, an Issue URL whose owner/name and number exactly match `delivery`, non-empty acceptance, valid budgets, and `authorization.delivery: true`. Commit the contract file, leave it unchanged, and ensure `baseSha` is an ancestor of the checkout passed to `submit`.
- `codex_profile_unusable`: check `CODEX_HOME`, the exact named profile filename, its required `model`, supported optional fields, and whether the profile name was intentionally listed in exactly one of `USINE_CODEX_APP_SERVER_PROFILES` or `USINE_OPENCODE2_PROFILES`.
- A Forge `unauthorized`, `malformed`, or `repository_mismatch` error: derive the environment prefix from the registration's lowercase kebab-case `forgeProfile` by uppercasing it and replacing hyphens with underscores. Check the App slug, nonblank App ID, positive installation ID, readable private-key path, and exact owner/name binding.
- `forge_not_ready`: rerun `forge readiness "<REGISTRATION_FILE>" --json` and apply its `expected`, `observed`, and `action` fields before submitting the first Task. The check has no repository write effect.
- A configured read profile is unavailable: check its separate App credentials, exact `USINE_GITHUB_READ_PROFILE_<PROFILE>_REPOSITORY` binding, and comma-separated role tool names. Read access is optional; it cannot replace the Task Contract's authority.
- The normalizer is rejected as incomplete: set `USINE_ROLE_OUTPUT_API_KEY`, `USINE_ROLE_OUTPUT_API_URL`, and `USINE_ROLE_OUTPUT_MODEL` together, or unset all three.
- `task get` shows `waiting` and `retryable: true`: use the explicit `task retry` command. If it shows `blocked`, or retry returns a conflict, inspect `blocker.classification`, `task history`, project-check output in the host's private diagnostics, and the deadline before changing the Task Contract.
- A Task remains active after the submitting shell exits: this is expected. Read `task get`, `task history`, or `task watch`; the server owns the admitted Task.
- A listener misses an event: transient subscriptions do not replay. Read `task get` and `task history`, then open a new listener if future observation is still needed.

Keep credentials, private diagnostics, transcripts, and local paths on the host. Public Task and Repository resources are intentionally sanitized, and no process exit or agent message is a completion authority.
