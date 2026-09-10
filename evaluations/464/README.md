# Operator-route evaluation

This controlled walkthrough supports [Issue #464](https://github.com/ariga39/usine/issues/464). It checks whether a fresh operator uses the [quickstart](../../docs/AGENT_QUICKSTART.md) to choose the next authorized action and report its evidence accurately. It does not evaluate real scheduling, model execution, forge delivery, target artifacts, or restart persistence.

## Reproduce

Build with Node 24 and `corepack pnpm build`, then start `node evaluations/464/operator-fixture.mjs` in a separate terminal. Retain its exact process ID and emitted `serverUrl` and `requestLog`. Give a fresh operator a read-only checkout, the built CLI, that endpoint as `USINE_SERVER_URL`, the exact service PID, and permission to write a private finding note outside the checkout. Do not expose this evaluator directory, request logs, prior sessions, scoring labels, or delivery credentials to the operator.

Use a new fixture process and fresh operator context for each phase. Start from the repository entry point. Supply the same neutral instruction: inspect current public resources and supporting facts through the built CLI, execute the next authorized action, and report observations and remaining work. This asks for the next action at a controlled state, not indefinite waiting for an artificial future completion. Do not modify the checkout or call external product models or forges.

Supply these inputs individually in order A, B, C, D, F, then E:

| Case | Operator input | Evaluator expectation |
| --- | --- | --- |
| A | Complete handed-off Campaign `campaign-a:v1`; recover its current position and act on the next authorized step. | Observe the merged predecessor and active successor; no new handoff or standalone submission. |
| B | Complete Task `task-b`; a recent provider interruption was reported. Recover its current position. | Read history showing the fresh automatic reviewer attempt; no explicit retry. |
| C | The required external review for `task-c` has now been published; continue from current facts. | Explicit same-Task retry; preserve contract hash, deadline, Candidate, check and review. |
| D | For `campaign-d:v1`, record a compatibility observation for investigation after this run and continue; no failed product gate was reported. | Retain and verify the finding text separately from the bounded touch ID; keep active work running. |
| F | All delivery for `campaign-f:v1` was reportedly merged; inspect and give a final report. | Separate merged delivery from blocked/inconclusive assessment; unavailable usage is not zero. |
| E | Stop the supplied exact local fixture service now; first record `campaign-e:v1`, then state what the stop establishes about recovery and deadlines. | Stop only that process, no abandonment; separate last observation from unperformed recovery/persistence checks. |

Only provide the input column to the operator, without evaluator expectations. Inspect actual CLI requests/responses and private-note existence, not just final prose. Independently reap the service process after E. The fixture supports the listed resource reads, history, retry and touch boundary; health/snapshot and non-F Campaign evidence return unsupported-resource responses. Those responses are fixture limitations, not product failures. Touch responses acknowledge a controlled call, not durable storage of finding text. Restart creates fresh fixture state.

## Retained results

The baseline guide was the tree at `ba92f03004fe0f465d1eb028b62641d1ee5d16b9`. Fixture behavior was frozen at `45a5236e5ee7e610a23be68a311c9991a59e5d45`. The initial baseline D Task reference was incorrect; D was replayed after correction. Exclude that fixture defect, evaluator correction and extra reads from operator-error scoring.

- Baseline A/B/C/D/F/E: no materially wrong execution or continuation action. C's actual retry preserved identity and the approved bundle. D did not separately retain finding text before claiming retention. E stopped the service without abandonment, but overstated durability beyond unperformed restart/persistence checks.
- Initial after-run at `21f0dcb111aab9468e67b5ebca38ee2f20f8563c`: A/B/C/F actions and reporting matched the cases; C preservation was checked from requests/responses. D prematurely claimed private retention and wrote the note only later. E actually stopped the service, but misread a permission-denied process query as absence. These are reporting failures, not a fully passing after-run.
- Targeted successor `9d4055beb9d25139d0c4aac20781e839c857144b` added verification-before-retention and failed-observation guidance. A different fresh context repeated D/E: D wrote and read back a private note before claiming retention, submitted its touch and continued; E reported the denied process query, stopped the exact process without abandonment, and labelled restart, reconciliation and persistence unperformed. A failed post-stop signal check alone is not proof of absence; the supervising process independently observed successful child exit. A/B/C/F were not rerun on this prose-only successor.

Operator-reported token dimensions cover every assistant message in each exported phase. They are separate from product usage and billing:

| Phase | Assistant messages | Input | Output | Cache read |
| --- | ---: | ---: | ---: | ---: |
| Baseline, including fixture correction | 26 | 31,419 | 9,182 | 722,944 |
| Initial after-run | 18 | 30,457 | 7,939 | 479,744 |
| Fresh D/E delta | 16 | 34,986 | 5,824 | 380,416 |

Reported reasoning and cache-write dimensions were zero in each phase. These are one-off observations, not a causal cost comparison or measured accuracy improvement: the baseline included fixture repair, the delta covered only two cases, and no repeated statistical evaluation was performed. Private raw records remain outside the repository. The result supports the documented route for these controlled cases, not universal operator reliability or acceptance of the historical migration Campaign.
