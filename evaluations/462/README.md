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

Current checkpoint: actual checks and shipped plan admission pass. Live semantic results and independent final review remain pending.
