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

The ordinary-path result is pending. No successful model implementation or
measured prompt/profile improvement is claimed by the control matrix alone.
