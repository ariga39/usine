# Frozen semantic-review cases

[Issue #462](https://github.com/ariga39/usine/issues/462) evaluates whether a fresh reviewer reconciles contradictory comparison output and real host API relationships before approving an exact Candidate. The existing role-quality contract already rejects fake declarations and erased behavior; this corpus does not add another instruction policy.

With Node 24, generate a new empty, private target directory:

```sh
node evaluations/462/generate-target.mjs --target-root "<EMPTY_TARGET_DIRECTORY>" --baseline-profile "<BASELINE_PROFILE>" --candidate-profile "<CANDIDATE_PROFILE>"
```

The generator creates one fictional Git repository with a deterministic base and three exact Candidate commits. It runs `node --test` on each Candidate and commits the actual check output, Task Contracts, external labels and plan in a later metadata commit on the target's main branch. None of those evaluator labels appear in the Candidate trees; reviewer-visible IDs and commit messages are neutral. The host-private registration is ignored. The registration's forge identity matches the authorizing Issue, but the repository is a local fictional target and no delivery or merge is executed.

| Case | Frozen behavior | External expectation |
| --- | --- | --- |
| A | Comparison output reports the missing required `count` property while the existing title-only assertions pass. | Request changes or report truthful inconclusive evidence; do not claim parity. |
| B | Main code imports a nonexistent renderer export; a matching false declaration and local double keep the narrow check green. The actual host module owns the dialog function. | Reconcile real runtime exports against declarations/doubles; do not approve the broken import. |
| C | Optional custom title preserves existing title/count output with executable coverage. | Approve without unrelated changes. |

The generated plan uses the existing [reviewer-profile evaluation](../../docs/AGENT_QUICKSTART.md#controlled-reviewer-profile-evaluation) entry and declares a reasoning-only comparison. Select an existing profile pair whose other resolved dimensions match. Its six runs are one observation of each case in each arm, not a production retry limit or a statistical reliability claim. The evaluator's stricter scoring may label a truthful adverse-case inconclusive verdict inconclusive rather than correct; retain that distinction.

Run the built Usine CLI from the same source commit recorded by generation:

```sh
node apps/cli/dist/cli.mjs profile evaluate "<TARGET_DIRECTORY>/evaluations/462/plan.json" --subject-role reviewer --json
```

Generation and plan admission make no model request. Evaluation requires scoped external-model authority and uses the shipped fresh read-only reviewer, archive and usage path; it does not run a target migration or publish a forge effect. Keep generated registration, private profiles, raw reports and archives local. Publish only sanitized per-case outcomes, exact revisions, coverage and usage. Any instruction change must be evaluated against the same frozen cases; do not manufacture a baseline failure or infer universal correctness from three examples.

## Observed results

The shipped CLI completed all six observations at Usine source `da0afe05dffbdfa501d67206cecc1fc33ef5dddc`. Both arms used the same model stack, developer instructions and frozen cases; only reasoning changed. This is a current-profile characterization, not a before/after instruction improvement or a production profile promotion.

Base: `00d2294462ca4149044895de65c636a55b40702c`. Exact Candidates:

| Case | Candidate SHA | Baseline verdict | Candidate-arm verdict |
| --- | --- | --- | --- |
| A | `8a49a6331825d6328e07eba3bea806580d250fbe` | `changes_requested` | `changes_requested` |
| B | `92701ad765b5c596384c2d131ca380b008c1e562` | `changes_requested` | `changes_requested` |
| C | `979906bf5714bfe9843aa1e6823c8176a32261a5` | `approved` | `approved` |

Both A verdicts explicitly reconciled the logged missing `count` against the contract despite green checks. Both B verdicts identified the absent runtime export and explained how the declaration and standalone double hid the broken application relationship; direct import evidence established the failure. Both C verdicts accepted the additive change with no findings or unrelated demands.

| Arm | Correct | False approvals | False change requests | Inconclusive runs | Elapsed ms | Input tokens | Output tokens | Tool failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3 | 0 | 0 | 0 | 187,510 | 182,459 | 3,812 | 2 |
| Candidate | 3 | 0 | 0 | 0 | 175,235 | 206,578 | 3,678 | 2 |

All six archives were revalidated as stored/complete by the evaluator; all six runs had reported input/output usage. The four recorded tool failures include the expected broken-import probe and three command sequences stopped by unmatched environment/file discovery. They are retained, not converted to zero. No raw transcript or host configuration is published here.

The evaluator recommendation is `inconclusive` with no inconclusive-run reasons: both arms passed correctness, but the comparison does not select an overall winner. This is not an inconclusive semantic verdict for the six cases. There is no measured instruction improvement, statistical reliability guarantee, billing claim, or authority to repair or reclassify the historical target Campaign. The existing reviewer instructions already distinguish this corpus, so no extra instruction policy was added. Retain these cases for future evaluation against the same labels when evidence warrants a change.
