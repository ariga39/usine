# Usine agent quickstart

This guide is for an agent operating Usine for an authorized project task. It is not the development guide for changing Usine; use [`DEVELOPMENT.md`](DEVELOPMENT.md) for that work.

Usine runs a local server. The server owns admission, execution, recovery, and public resource projections. The CLI is a client of that server. A submitting CLI process may exit after admission; the server continues the Task.

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

Clients derive their URL from `USINE_SERVER_HOST` and `USINE_SERVER_PORT`. Set `USINE_SERVER_URL` instead when the client must use a different loopback URL:

```sh
export USINE_SERVER_URL="<LOOPBACK_SERVER_URL>"
```

Do not expose the server beyond the host boundary. The HTTP API is a local coordination boundary, not an internet-facing service.

### Codex named profiles

The Repository registration names one `implementerProfile` and one `reviewerProfile`. Each name must be a safe profile name and resolves to `<profile>.config.toml` in `CODEX_HOME`; when `CODEX_HOME` is unset, the Codex default configuration directory is used.

Each selected profile must contain a nonblank `model`. The currently supported optional profile fields include `model_reasoning_effort` with one of `minimal`, `low`, `medium`, `high`, or `xhigh`, and a nonblank `developer_instructions`. The adapter also forwards the supported Codex configuration fields `model_catalog_json`, `model_provider`, `model_providers`, `model_reasoning_summary`, `model_verbosity`, `personality`, and `service_tier` when present. Usine still owns the Task Contract, role prompt, output schema, sandbox, approval policy, deadline, and credential boundary.

For example, a host-private profile file has this shape:

```toml
model = "<MODEL_NAME>"
model_reasoning_effort = "<minimal|low|medium|high|xhigh>"
developer_instructions = "<OPTIONAL_DEVELOPER_INSTRUCTIONS>"
```

The `developer_instructions` line is optional; remove it when it is not needed. An unreadable, malformed, unsupported, or missing profile is reported as `codex_profile_unusable` before provider execution.

The official Codex SDK adapter is used unless the profile name is listed in the comma-separated `USINE_CODEX_APP_SERVER_PROFILES` variable. Listed profiles use the bounded local Codex App Server adapter; unlisted profiles use the SDK adapter. This is static per named profile and has no fallback, automatic routing, or third provider.

```sh
export USINE_CODEX_APP_SERVER_PROFILES="<APP_SERVER_PROFILE_NAME>"
```

Leave the variable unset when all registered profiles should use the SDK adapter. Only list profiles that have been deliberately configured for the app-server path.

### Forge GitHub App profile

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

The configured repository must match the registration's `owner` and `name`, case-insensitively. App ID and installation ID must be positive integers. Forge credentials are resolved only at the host execution boundary.

### Optional GitHub read profile

Set `githubReadProfile` in the registration only when the roles need bounded GitHub context. The read profile is separate from the Forge profile and must bind to the same registered owner/name. For a read profile named `read-only`, the host configuration can use a separate GitHub App capability:

```sh
export USINE_GITHUB_READ_PROFILE_READ_ONLY_APP_SLUG="<READ_APP_SLUG>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_APP_ID="<READ_APP_ID>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_INSTALLATION_ID="<READ_INSTALLATION_ID>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_PRIVATE_KEY_PATH="<READ_APP_PRIVATE_KEY_PATH>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_REPOSITORY="<GITHUB_OWNER>/<GITHUB_REPOSITORY>"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_IMPLEMENTER_TOOLS="github_issue_get,github_issue_comments"
export USINE_GITHUB_READ_PROFILE_READ_ONLY_REVIEWER_TOOLS="github_pull_request_get,github_pull_request_reviews,github_pull_request_checks"
```

The allowed tool names are `github_issue_get`, `github_issue_comments`, `github_pull_request_get`, `github_pull_request_reviews`, `github_pull_request_checks`, `github_file_get`, and `github_commit_get`. If a role-specific tool list is omitted, the current implementation enables the complete list for that role. The read capability is bound to the frozen Repository and Issue. Pull-request reads require an authorized delivered-PR fact. Read credentials do not become Forge credentials and do not enter worker environment variables or durable public resources.

### Optional role-output normalizer

The coordinator can normalize a provider response that is not direct JSON into the role's schema through an OpenAI-compatible API. This is optional and only applies to final role-output normalization. Configure all three variables together or leave all three unset:

```sh
export USINE_ROLE_OUTPUT_API_KEY="<ROLE_OUTPUT_API_KEY>"
export USINE_ROLE_OUTPUT_API_URL="<OPENAI_COMPATIBLE_BASE_URL>"
export USINE_ROLE_OUTPUT_MODEL="<ROLE_OUTPUT_MODEL>"
```

The API key remains in the coordinator host process. It is not passed to the worker or stored in Task facts.

## 3. Register a Repository

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

## 4. Write and submit a Task Contract

The Task Contract is the immutable authorization input. Create it in the registered Repository, use a full lowercase 40-character `baseSha` that is an ancestor of the current checkout, and commit the file before submitting it. The authorization URL must be the canonical HTTPS GitHub Issue URL for the registered owner/name and must use the same positive issue number as `delivery.issue`.

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
    "maxImplementerActivations": 2,
    "maxReviewCycles": 1,
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

Replace the all-zero example SHA, owner, repository, Task ID, and Issue number. `maxImplementerActivations` and `maxReviewCycles` are each bounded from 1 through 2. Setting `maxImplementerActivations` to `2` permits the one explicit retry described below. Set `authorization.merge` to `true` only when the authorization explicitly grants merge authority:

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

`submit` returns the admitted Task resource as JSON. The server verifies that the contract is a committed file in the authorized Repository, is unchanged, and has an ancestor `baseSha`. Re-submitting the same Task ID returns its existing durable facts rather than creating a second Task.

## 5. Check health and observe the Task

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
```

Human-readable output is the default for resource reads; add `--json` for the stable machine-readable projection. `server health` returns `status` and `revision`. `server snapshot` includes the server, registered Repository resources, Task list items, and coding-session resources. `task get` returns the Task state, exact-SHA evidence projections, delivery, blocker classification, waiting/retry flags, writer identity, and evidence counters without private policy facts.

`task history` reads persisted Task-local events after a non-negative sequence cursor; its limit is from 1 through 200. `task watch` repeatedly reads the current Task and durable event history, writes each observed event as one JSON line to stderr, and writes the final Task resource to stdout when the Task reaches a terminal state or `waiting`. It has no live-event cursor to resume: start with `task history` or `task watch --after <LAST_SEQUENCE>` when recovering an operator view. The compatibility aliases `status` and `follow` remain available, but `task get` and `task watch` are the canonical commands.

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

Only an implementer interruption during the turn phase with failure class `network` is currently retryable. The public Task projection then has:

```json
{
  "state": "waiting",
  "waiting": { "reason": "network_interruption" },
  "retryable": true
}
```

Retry it explicitly:

```sh
node apps/cli/dist/cli.mjs task retry "<TASK_ID>" --json
```

The retry resumes the recorded Task phase with the original contract, deadline, and Repository authority. It consumes the next implementer activation and can be accepted only while the activation budget and deadline remain available. It is not an automatic retry; with the maximum activation budget of 2, there is at most one retry. Restart, re-submission, reviewer failures, project-check failures, provider configuration failures, and other failure classes do not enter this explicit `waiting`/`task retry` path. A retry against a non-waiting Task returns a retry conflict.

The server's default active-Task capacity is 1. A full capacity returns a retryable API error; wait for an active Task to become terminal before submitting another Task or adjust `USINE_ACTIVE_TASK_CAPACITY` to a positive finite value appropriate for the host. Capacity is a bounded admission setting, not a queue.

## 7. Stable exit codes

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

## 8. Troubleshooting

- `command not found`, an install error, or a missing `dist/cli.mjs`: use Node 24, run `corepack enable`, then run `corepack pnpm install --frozen-lockfile` and `corepack pnpm build` from the Usine checkout.
- Connection exit code `5`: keep `server` running, and make `USINE_SERVER_URL` agree with the server host/port settings. The server accepts loopback hosts only.
- `invalid_repository_registration` or validation exit code `7`: check the strict registration shape, nonblank fields, lowercase kebab-case Forge/read profile names, positive `projectCheck.timeoutMs`, and a resolvable `<AUTHORIZED_REPOSITORY_PATH>`.
- `invalid_task_contract`: check for extra or missing keys, a lowercase 40-character `baseSha`, an Issue URL whose owner/name and number exactly match `delivery`, non-empty acceptance, valid budgets, and `authorization.delivery: true`. Commit the contract file, leave it unchanged, and ensure `baseSha` is an ancestor of the checkout passed to `submit`.
- `codex_profile_unusable`: check `CODEX_HOME`, the exact named profile filename, its required `model`, supported optional fields, and whether the profile name was intentionally listed in `USINE_CODEX_APP_SERVER_PROFILES`.
- A Forge `unauthorized`, `malformed`, or `repository_mismatch` error: derive the environment prefix from the registration's lowercase kebab-case `forgeProfile` by uppercasing it and replacing hyphens with underscores. Check the App slug, positive App and installation IDs, readable private-key path, and exact owner/name binding.
- A configured read profile is unavailable: check its separate App credentials, exact `USINE_GITHUB_READ_PROFILE_<PROFILE>_REPOSITORY` binding, and comma-separated role tool names. Read access is optional; it cannot replace the Task Contract's authority.
- The normalizer is rejected as incomplete: set `USINE_ROLE_OUTPUT_API_KEY`, `USINE_ROLE_OUTPUT_API_URL`, and `USINE_ROLE_OUTPUT_MODEL` together, or unset all three.
- `task get` shows `waiting` and `retryable: true`: use the explicit `task retry` command. If it shows `blocked`, or retry returns a conflict, inspect `blocker.classification`, `task history`, project-check output in the host's private diagnostics, and the deadline before changing the Task Contract.
- A Task remains active after the submitting shell exits: this is expected. Read `task get`, `task history`, or `task watch`; the server owns the admitted Task.
- A listener misses an event: transient subscriptions do not replay. Read `task get` and `task history`, then open a new listener if future observation is still needed.

Keep credentials, private diagnostics, transcripts, and local paths on the host. Public Task and Repository resources are intentionally sanitized, and no process exit or agent message is a completion authority.
