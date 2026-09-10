# Host-grounded first-candidate qualification

This bounded case supports [Issue #475](https://github.com/ariga39/usine/issues/475).
It improves project-check selection before the existing independent review gate:
load the built package through a source-derived host boundary instead of relying
only on an implementation's own types and doubles. It does not change role
instructions, profiles, Task lifecycle, or review authority.

## Reproduce the case

Use Node 24, Corepack, Git with the operator's configured author, network access
for dependency installation, and a reachable non-loopback IPv4 interface for the
LAN check. Generate each case into a separate new empty directory outside any
existing package workspace:

```sh
node evaluations/475/generate-target.mjs --target-root "<EMPTY_IMPLEMENTATION_TARGET>"
node evaluations/475/generate-target.mjs --target-root "<EMPTY_VALID_CONTROL>" --control valid
node evaluations/475/generate-target.mjs --target-root "<EMPTY_ADVERSE_CONTROL>" --control invented
```

The generator installs pinned dependencies, formats and commits the target, then
prints its base SHA, strict Task Contract path, and registered project command:

```sh
corepack pnpm install --frozen-lockfile && corepack pnpm run check
```

The ordinary target starts with an empty module. It contains neither control
implementation nor their Git history. The controls are evaluator-owned; do not
supply them or earlier solutions to the implementer.

`check` invokes genuine Vite+ formatting, lint, type checking, packaging and tests.
The external templates are excluded only from Usine's root type-aware lint;
generated projects check them with their own declared React/host dependencies.
No target check is renamed to a Node substitute or bypassed.

## Host evidence and falsifier

[HOST-EVIDENCE](fixture/docs/HOST-EVIDENCE.md) pins public poi and reference-plugin
sources. The fixture projects the real package resolution, zero-argument
unawaited lifecycle hooks, `poiPlugin` metadata, React `settingsClass`, dotted
configuration events and `window.getStore` boundary. It is not a full Electron
host launch. Settings rendering is checked with React SSR; interactive UI
handlers are not exercised.

The same built-entry test exercises a real HTTP listener, read-only resource
projection, bearer authentication, rejected query credentials, Host/Origin
validation, no forwarded-host override, token rotation, port rebind, default
loopback, explicit LAN access, disable/re-enable and unload cleanup. The bounded
deployment policy deliberately excludes proxies; it must not promise untested
TLS-proxy compatibility. WebSocket/MCP and the historical target repair are not
part of this case.

Compare the two evidence selections on each unchanged control SHA:

```sh
corepack pnpm run format:check
corepack pnpm run lint
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm exec vp test run tests/unit.test.mjs
corepack pnpm exec vp test run tests/host.test.mjs
```

| Control | Toolchain and self-tests | Added built-entry host check |
| --- | --- | --- |
| Valid real-host plugin | Passed; one self-test | Passed; two host tests |
| Invented injected host | Passed; one self-test | Rejected; two failures identify missing real `pluginDidLoad` |

The positive control passes the complete registered command. The adverse control
shows a deterministic improvement in early evidence at the same SHA, not an
inferred model improvement. Its self-consistent tests alone cannot detect that
the real host will never call its injected interface. The historical independent
review correctly rejected this failure class and remains in place.

Harness preparation also found and corrected missing target Node types, Fetch's
unsuitable Host-header override probe, and a polling assertion used in a cleanup
hook. These are harness failures, not model baseline failures. The final Host
probe uses `node:http` and cleanup uses `vi.waitFor`; no assertion was relaxed.

## Ordinary implementation observation

Use the existing SDK Coding Session, Candidate Workspace, Task Authority, Quality
Gate and Delivery Run over the ordinary generated target. Observe the first
persisted exact-SHA project-check result, retain local usage/archive evidence,
and stop before repair, review or forge delivery. The contract's 45-minute
elapsed bound estimates this finite resource endpoint, settings and check task;
it is not a product default. Activation/review counts remain `null`. The observer
does not restart or reopen the terminal historical Campaign.

### First observation and corrected falsifier

The ordinary SDK path on source `2c796e7568ba3fbb3f4fd1fb0d3468f4fcea3508`
produced candidate `95d922770f34aa40b874b87f808fa17a742bc8fb` from fixture base
`41227a9327fe449d9312057af7897f3c8b389208` in one implementation activation. Its
exact-SHA frozen install and full Vite+ command passed, including both host tests.
The candidate changed only implementation and deployment documentation; host
tests, package scripts, dependencies, lockfile and tool configuration were
unchanged. The archive confirms successful reads of all six pinned public
host/reference sources, a stored complete capture and no truncation.

A subsequent real HTTP probe of that unchanged candidate found an oracle gap:
a URL containing `?token=...` returned 200 when a valid Bearer header was also
present. The original test checked query credentials only without that header.
The strengthened host test now requires rejection in both combinations. The
positive control still passes all three tests. This is a retained first-candidate
failure, not a waived requirement or a reason to expand role prompts.

The first observer's event callback ran too late to stop review reservation.
Its guarded review boundary threw before any reviewer model call, leaving a
cancelled synthetic reviewer observation and a checked candidate; its final
no-review-start assertion failed. No reviewer model, repair or forge ran. That
record is preserved, and the next observation stops directly after the owning
`recordCheck` operation persists. Do not interpret the aggregate's partial usage
coverage as missing implementer usage or invent reviewer tokens.

| First implementation measurement | Observed value |
| --- | ---: |
| Total input tokens, including cache reads | 911,484 |
| Cache-read input tokens | 849,408 |
| Uncached input tokens | 62,076 |
| Cache-write input tokens | 0 |
| Output tokens, including reasoning | 14,874 |
| Reasoning output tokens | 5,563 |
| Implementation elapsed time | 378,915 ms |
| Whole observation elapsed time | 389,298 ms |

The provider-reported implementation usage is complete; identity not attested
by the provider remains unavailable. Raw archives and machine/profile details
remain private. No pricing, historical backfill, remote PostHog delivery or
Campaign acceptance is claimed.

### Strengthened-case observation

A fresh ordinary observation on the same Usine source and model/profile produced
candidate `a6fce2532d13e11d9a574a726569e5f01a4f7c35` from fixture base
`afdc1198161a6594c918e0b5f334d96b5b0bce02`, again in one implementation activation.
Task behavior was unchanged; the only case change added the missing query-token
combination. The exact-SHA full registered command passed, including rejection
of query credentials with and without a valid Bearer header. Only implementation
and deployment documentation changed; the frozen tests, dependency/lockfile,
scripts and tool configuration were unchanged.

The observer stopped after the persisted check, before any review reservation,
repair or forge effect. One complete untruncated implementation archive and one
complete usage invocation were retained. All six pinned source reads succeeded.

| Strengthened-case measurement | Observed value |
| --- | ---: |
| Total input tokens, including cache reads | 883,384 |
| Cache-read input tokens | 816,640 |
| Uncached input tokens | 66,744 |
| Cache-write input tokens | 0 |
| Output tokens, including reasoning | 19,836 |
| Reasoning output tokens | 9,991 |
| Implementation elapsed time | 446,800 ms |
| Whole observation elapsed time | 455,267 ms |

The final positive control passes all three tests; the final invented-interface
control passes its build/self-test and fails both host tests. The measured gain
is an earlier, source-grounded falsifier and one observed compliant candidate
for this bounded case. The initial green-but-incomplete check and additional
validation cost remain visible. These two observations do not establish a
statistical model improvement, cost reduction or general prevention of mistakes.
