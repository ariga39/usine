# Issue 312 reviewer-profile pilot rerun

## Purpose

Issue #312 reruns the reviewer-profile pilot after Issue #310 stopped before any reviewer Role Run. Issue #294 remains the Task behavior authority. The committed [Task Contract](contract.json) grants delivery and no merge authority.

The hypothesis is that `usine-reviewer-medium` preserves a correct, non-inconclusive exact-SHA verdict on a real module-seam Candidate while reducing reviewer elapsed time, token use, or tool failures relative to the bounded [`evaluations/308/report.json`](../../evaluations/308/report.json) baseline.

## Preflight and recovery

The complete prior registration was checksum-bound and retained host-locally. The pilot changed only the fresh worktree binding, project-check ordering, and reviewer profile. The selected reviewer resolved to `gpt-5.6-sol` through `sdk` with `medium` reasoning; the #308 baseline used the same model and adapter with `high` reasoning.

Quality Gate's disposable exact-SHA check entry passed at base `a87c05b2ea839e0d3e580935ba8dbe28e4d158e0`. It completed the offline install, built the CLI and required package artifacts, then passed Coding Session, Quality Gate, and Delivery Run tests. This corrected the build-order defect recorded by Issue #310.

After the Task reached terminal state, the complete prior registration was restored. No registration contents, host paths, credentials, Session Archive contents, or transcripts are published.

## Task result

Task `issue-294-reviewer-pilot-rerun-312` used exactly two implementer activations, two candidate-reviewer cycles, and one repair batch. Both Candidates passed the corrected project check with exit 0.

| Activation | Effective identity | Elapsed | Tools | Tool failures | Input tokens | Output tokens | Archive | Candidate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `usine-implementer`, `gpt-5.6-luna`, `high`, `sdk` | 566927 ms | 40 | 3 | 3794056 | 19157 | stored/complete | `f76fb3469d5cfef98c02b906ba813d238a736ac5` |
| 2 | same effective identity | 746634 ms | 57 | 2 | 4133048 | 31983 | stored/complete | `be69b82870b5af5ec80722f9d0afad8251b09d3f` |

| Review cycle | Effective identity | Verdict | Findings | Elapsed | Tools | Tool failures | Input tokens | Output tokens | Archive | Candidate |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `usine-reviewer-medium`, `gpt-5.6-sol`, `medium`, `sdk` | changes requested | 2 | 207665 ms | 14 | 0 | 575926 | 4370 | stored/complete | `f76fb3469d5cfef98c02b906ba813d238a736ac5` |
| 2 | same effective identity | changes requested | 1 | 249531 ms | 28 | 0 | 947566 | 5380 | stored/complete | `be69b82870b5af5ec80722f9d0afad8251b09d3f` |

The final Candidate passed its exact-SHA project check but remained unaccepted. The Task reached terminal `blocked` after the authorized activation and review bounds were exhausted; its public blocker classification was `elapsed_budget`. There was no delivery and no retry authority.

## Independent adjudication

Fresh read-only exact-SHA correctness and design/ownership reviews initially approved final Candidate `be69b82870b5af5ec80722f9d0afad8251b09d3f` with no blocking findings. Both broad reviews noticed that completed provider items still crossed the adapter seam through an `unknown` callback but treated the archive path as an allowed exception.

Targeted local inspection of only the final reviewer's normalized output exposed the disputed finding without publishing archive or transcript content. A third fresh read-only exact-SHA adjudication then examined only that contract point and classified it as blocking:

- `packages/coding-session/src/coding-session-adapter.ts` carries completed items across the adapter boundary as `unknown`.
- The SDK and App Server adapters pass their provider-native completed-item shapes through that callback.
- `packages/coding-session/src/session-archive.ts` still owns conversion of both provider naming conventions.

Behavior is preserved, but Issue #294 requires typed provider-neutral completed evidence at the adapter boundary and requires each adapter to own its provider-native conversion. The smallest coherent repair is to define a typed provider-neutral completed-item value, convert to it inside each adapter, and let Session Archive persist that value without interpreting provider naming conventions.

The focused adjudication directly tests the contested Issue requirement and therefore confirms the production reviewer's final `changes_requested`. The two earlier broad approvals remain recorded as disagreement; they are not silently treated as ground truth.

## Classification

The result **qualifies** the hypothesis.

- Correctness evidence supports the candidate reviewer: it returned a conclusive, exact-SHA `changes_requested` verdict, and focused independent adjudication confirmed the blocking contract defect.
- Evidence attribution is complete: both reviewer runs used the expected profile, model, adapter, and reasoning; usage, elapsed time, tool outcomes, archive completeness, Candidate SHAs, checks, and terminal state are present.
- The two production reviewer runs total 457196 ms, 1523492 input tokens, 9750 output tokens, and zero tool failures. Their per-run averages are 228598 ms, 761746 input tokens, 4875 output tokens, and zero tool failures.
- The four-run #308 high-reasoning baseline averages 223948 ms, 453054 input tokens, 4836 output tokens, and 1.75 tool failures per run. Tool failures improved directionally, but elapsed time was about 2.1% higher, input tokens about 68.1% higher, and output tokens about 0.8% higher.

The one-Task sample, mixed efficiency measures, and repair burden cannot establish the efficiency claim. They do not falsify reviewer correctness, and they do not justify automatic promotion or a persistent production-default change.

The contract and recovery rules follow the repository's [design authority](../../docs/DESIGN.md), [development protocol](../../docs/DEVELOPMENT.md), and [agent quickstart](../../docs/AGENT_QUICKSTART.md).
