import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { reviewerOutputSchema } from "@usine/coding-session";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  taskResourceFromResult,
  type ResolvedTaskContract,
} from "@usine/task-authority";
import { executeDeliveryRun, type DeliveryRunServices } from "../src/delivery-run.js";
import { DeliveryQuarantineError, ForgeDeliveryReconciliationError } from "@usine/forge-delivery";
import {
  applyTaskFact,
  type CandidateFact,
  type TaskObservationEventInput,
  type TaskResult,
} from "@usine/task-authority";

type ObservationCapabilityIsRequired = DeliveryRunServices["authority"] extends {
  appendObservation: (taskId: string, input: TaskObservationEventInput) => Promise<unknown>;
}
  ? true
  : false;
const observationCapabilityIsRequired: ObservationCapabilityIsRequired = true;
void observationCapabilityIsRequired;

const sha = "b".repeat(40);
const implementer = {
  role: "implementer" as const,
  profile: "implementer-profile",
  sandbox: "workspace-write" as const,
};
function contract(id: string, merge = false): ResolvedTaskContract {
  return {
    id,
    repositoryId: "recovery-repository",
    repository: { path: ".", owner: "recovery", name: "recovery" },
    baseSha: "a".repeat(40),
    instructions: "recover",
    acceptance: ["recover"],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 2, maxReviewCycles: 2, maxElapsedMs: 60_000 },
    authorization: { source: "recovery test", delivery: true, ...(merge ? { merge: true } : {}) },
    delivery: {
      baseBranch: "main",
      branch: "agent/recovery",
      issue: 80,
      title: "recovery",
      body: "recovery",
    },
  };
}

function persistedResult(
  state: TaskResult["state"],
  id: string,
  mergeAuthorized = false,
): TaskResult {
  return {
    schemaVersion: 4,
    taskId: id,
    contractHash: "hash",
    revision: 4,
    deadlineEpochMs: Date.now() + 30_000,
    state,
    mergeAuthorized,
    candidateSha: state === "admitted" ? null : sha,
    candidateFence: state === "admitted" ? null : 1,
    check:
      state === "checked" || state === "reviewed"
        ? { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" }
        : null,
    review:
      state === "reviewed" ? { sha, verdict: "approved", summary: "approved", findings: [] } : null,
    repairBatchRecorded: false,
    delivery: null,
    blocker: null,
    blockerClassification: null,
    waiting: null,
    activeActivation: null,
    writer: { repositoryIdentity: `recovery/${id}` },
    evidence: {
      implementerActivations: state === "admitted" ? 0 : 1,
      reviewCycles: state === "reviewed" ? 1 : 0,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function fakeAuthority(initial: TaskResult) {
  let stored = initial;
  let implementerActivations = 0;
  const observations: TaskObservationEventInput[] = [];
  const transition = async (
    observation: { taskId: string; revision: number },
    fact: Parameters<typeof applyTaskFact>[1],
  ) => {
    if (observation.taskId !== stored.taskId || observation.revision !== stored.revision)
      throw new Error("stale task revision");
    const next = applyTaskFact(stored, fact);
    if (next === stored) return stored;
    stored = { ...next, revision: stored.revision + 1 };
    return stored;
  };
  const authority = {
    admit: async () => stored,
    recordCandidate: (
      observation: { taskId: string; revision: number },
      candidate: CandidateFact,
    ) => transition(observation, { type: "candidate", candidate }),
    recordCheck: (observation: { taskId: string; revision: number }, check: TaskResult["check"]) =>
      transition(observation, { type: "check", check: check! }),
    recordReview: (
      observation: { taskId: string; revision: number },
      review: TaskResult["review"],
      ownerId: string,
    ) => transition(observation, { type: "review", review: review!, ownerId }),
    recordReviewInterruption: (
      observation: { taskId: string; revision: number },
      candidateSha: string,
      failureClass: NonNullable<TaskResult["waiting"]>["failureClass"],
      ownerId: string,
    ) =>
      transition(observation, {
        type: "review_interrupted",
        sha: candidateSha,
        failureClass: failureClass!,
        ownerId,
      }),
    releaseReviewAttempt: (observation: { taskId: string; revision: number }, ownerId: string) =>
      transition(observation, { type: "review_released", ownerId }),
    reserveReviewAttempt: async (taskId: string, budget: number, ownerId: string) => {
      if (stored.state === "reviewing") return { result: stored, claimed: false, cycle: null };
      const cycle = stored.evidence.reviewCycles + 1;
      if (cycle > budget) throw new Error("review budget exhausted");
      if (
        stored.state !== "checked" &&
        !(stored.state === "waiting" && stored.waiting?.reason === "review_interruption")
      )
        throw new Error("task is not ready for a review attempt");
      if (taskId !== stored.taskId) throw new Error("wrong task");
      stored = {
        ...applyTaskFact(stored, { type: "review_started", ownerId }),
        revision: stored.revision + 1,
      };
      return { result: stored, claimed: true, cycle };
    },
    takeOverReviewAttempt: async (taskId: string, budget: number, ownerId: string) => {
      if (taskId !== stored.taskId) throw new Error("wrong task");
      if (stored.state !== "reviewing") throw new Error("task is not reviewing");
      const cycle = stored.evidence.reviewCycles + 1;
      if (cycle > budget)
        return { result: stored, claimed: false, cycle: null, status: "budget_exhausted" as const };
      stored = {
        ...applyTaskFact(stored, { type: "review_started", ownerId, takeover: true }),
        revision: stored.revision + 1,
      };
      return { result: stored, claimed: true, cycle, status: "claimed" as const };
    },
    recordRepairBatch: (observation: { taskId: string; revision: number }) =>
      transition(observation, { type: "repair_batch" }),
    recordWaiting: (
      observation: { taskId: string; revision: number },
      waiting: NonNullable<TaskResult["waiting"]>,
    ) => transition(observation, { type: "waiting", waiting }),
    recordDelivery: (
      observation: { taskId: string; revision: number },
      delivery: TaskResult["delivery"],
    ) => transition(observation, { type: "delivery", delivery: delivery! }),
    block: (
      observation: { taskId: string; revision: number },
      blocker: string,
      classification?: TaskResult["blockerClassification"],
    ) =>
      transition(observation, {
        type: "blocked",
        blocker,
        classification: classification ?? undefined,
      }),
    appendObservation: async (_taskId: string, observation: TaskObservationEventInput) => {
      observations.push(observation);
    },
    reserveActivation: async () => {
      implementerActivations += 1;
      stored = {
        ...stored,
        revision: stored.revision + 1,
        activeActivation: stored.evidence.implementerActivations + 1,
        evidence: {
          ...stored.evidence,
          implementerActivations: stored.evidence.implementerActivations + 1,
        },
      };
      return { result: stored, activation: stored.evidence.implementerActivations };
    },
  };
  return {
    authority,
    retry: async () =>
      transition({ taskId: stored.taskId, revision: stored.revision }, { type: "retry" }),
    getStored: () => stored,
    getImplementerActivations: () => implementerActivations,
    getObservations: () => observations,
  };
}

function servicesFor(
  authority: DeliveryRunServices["authority"],
  quality: DeliveryRunServices["quality"],
  forge: DeliveryRunServices["forge"],
): DeliveryRunServices {
  return {
    authority,
    workspace: {
      quarantinePriorWriters: async () => undefined,
      prepareWriter: async () => ({
        taskId: "recovery",
        activation: 1,
        path: ".",
        baseSha: "a".repeat(40),
      }),
      freeze: async () => ({
        sha,
        baseSha: "a".repeat(40),
        workspace: {
          taskId: "recovery",
          activation: 1,
          path: ".",
          baseSha: "a".repeat(40),
        },
      }),
      quarantine: async () => undefined,
    },
    session: {
      run: async () => {
        throw new Error("unexpected implementer activation");
      },
    },
    quality,
    forge,
  };
}

describe("Delivery Run durable phase recovery", () => {
  test("automatically makes one fresh transient reviewer attempt for the same candidate and check", async () => {
    const id = "transient-review-recovery";
    const fake = fakeAuthority(persistedResult("checked", id));
    const cycles: number[] = [];
    let reviews = 0;
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "transient-review-recovery-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
        reviewer: { ...implementer, role: "reviewer", sandbox: "read-only" },
      },
      {
        ...servicesFor(
          fake.authority,
          {
            check: async () => {
              throw new Error("check must not rerun during reviewer recovery");
            },
            reviewWithObservation: async (_contract, candidateSha, check, cycle, onObservation) => {
              expect(check).toMatchObject({ sha: candidateSha, status: "passed" });
              cycles.push(cycle);
              await onObservation?.({ type: "thread_started" });
              reviews += 1;
              if (reviews === 1)
                return {
                  review: {
                    sha: candidateSha,
                    verdict: "inconclusive" as const,
                    summary: "provider interruption",
                    findings: [],
                    failureClass: "transient_transport" as const,
                  },
                  usage: null,
                  interruption: {
                    phase: "turn" as const,
                    failureClass: "transient_transport" as const,
                  },
                };
              return {
                review: {
                  sha: candidateSha,
                  verdict: "approved" as const,
                  summary: "approved",
                  findings: [],
                },
                usage: null,
              };
            },
          },
          {
            deliver: async (_contract, candidateSha, check, review) => {
              expect(check.sha).toBe(candidateSha);
              expect(review).toMatchObject({ sha: candidateSha, verdict: "approved" });
              return {
                sha: candidateSha,
                effect: "github" as const,
                prNumber: 80,
                url: "https://example.invalid/pr/80",
                attestationId: "transient-review",
              };
            },
          },
        ),
      },
    );

    expect(result).toMatchObject({
      state: "reviewed_pr",
      candidateSha: sha,
      check: { sha, status: "passed" },
      review: { sha, verdict: "approved" },
      evidence: { reviewCycles: 2 },
    });
    expect(cycles).toEqual([1, 2]);
    expect(reviews).toBe(2);
    expect(
      fake.getObservations().filter(({ data }) => data.type === "coding_session_started"),
    ).toHaveLength(2);
    expect(
      fake.getObservations().filter(({ data }) => data.type === "coding_thread_started"),
    ).toHaveLength(2);
  });

  test("does not replace an interrupted reviewer when the review budget is exhausted", async () => {
    const id = "transient-review-budget";
    const limited = { ...contract(id), budget: { ...contract(id).budget, maxReviewCycles: 1 } };
    const fake = fakeAuthority(persistedResult("checked", id));
    let reviews = 0;
    const result = await executeDeliveryRun(
      {
        contract: limited,
        contractHash: "transient-review-budget-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("check must not rerun");
          },
          reviewWithObservation: async (_contract, candidateSha) => {
            reviews += 1;
            return {
              review: {
                sha: candidateSha,
                verdict: "inconclusive" as const,
                summary: "provider interruption",
                findings: [],
                failureClass: "transient_transport" as const,
              },
              usage: null,
              interruption: {
                phase: "turn" as const,
                failureClass: "transient_transport" as const,
              },
            };
          },
        },
        {
          deliver: async () => {
            throw new Error("delivery must not run");
          },
        },
      ),
    );

    expect(result).toMatchObject({ state: "blocked", blockerClassification: "elapsed_budget" });
    expect(reviews).toBe(1);
  });

  test("consumes repeated transient reviewer interruptions through the configured budget", async () => {
    const id = "transient-review-repeated-budget";
    const bounded = { ...contract(id), budget: { ...contract(id).budget, maxReviewCycles: 3 } };
    const fake = fakeAuthority(persistedResult("checked", id));
    let reviews = 0;
    const result = await executeDeliveryRun(
      {
        contract: bounded,
        contractHash: "transient-review-repeated-budget-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("check must not rerun");
          },
          reviewWithObservation: async () => {
            reviews += 1;
            return {
              review: null,
              usage: null,
              interruption: {
                phase: "turn" as const,
                failureClass: "timeout" as const,
              },
            };
          },
        },
        {
          deliver: async () => {
            throw new Error("delivery must not run");
          },
        },
      ),
    );

    expect(result).toMatchObject({
      state: "blocked",
      blockerClassification: "elapsed_budget",
      candidateSha: sha,
      check: { sha, status: "passed" },
      review: null,
      evidence: { reviewCycles: 3 },
    });
    expect(reviews).toBe(3);
  });

  test("does not replace an interrupted reviewer after the frozen deadline", async () => {
    const id = "transient-review-deadline";
    const fake = fakeAuthority(persistedResult("checked", id));
    const originalInterruption = fake.authority.recordReviewInterruption;
    let reviews = 0;
    fake.authority.recordReviewInterruption = async (
      observation,
      candidateSha,
      failureClass,
      ownerId,
    ) => {
      const interrupted = await originalInterruption(
        observation,
        candidateSha,
        failureClass,
        ownerId,
      );
      interrupted.deadlineEpochMs = Date.now() - 1;
      return interrupted;
    };
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "transient-review-deadline-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("check must not rerun");
          },
          reviewWithObservation: async (_contract, candidateSha) => {
            reviews += 1;
            return {
              review: {
                sha: candidateSha,
                verdict: "inconclusive" as const,
                summary: "provider interruption",
                findings: [],
                failureClass: "timeout" as const,
              },
              usage: null,
              interruption: { phase: "turn" as const, failureClass: "timeout" as const },
            };
          },
        },
        {
          deliver: async () => {
            throw new Error("delivery must not run");
          },
        },
      ),
    );

    expect(result).toMatchObject({ state: "blocked", blockerClassification: "elapsed_budget" });
    expect(reviews).toBe(1);
  });

  test("re-enters a durable reviewer interruption after restart without changing the candidate", async () => {
    const id = "transient-review-restart";
    const fake = fakeAuthority(persistedResult("checked", id));
    const originalReserve = fake.authority.reserveReviewAttempt;
    let pauseRecovery = true;
    let reviews = 0;
    fake.authority.reserveReviewAttempt = async (taskId, budget, ownerId) => {
      if (fake.getStored().state === "waiting" && pauseRecovery) {
        pauseRecovery = false;
        return { result: fake.getStored(), claimed: false, cycle: null };
      }
      return originalReserve(taskId, budget, ownerId);
    };
    const input = {
      contract: contract(id),
      contractHash: "transient-review-restart-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
      reviewer: { ...implementer, role: "reviewer" as const, sandbox: "read-only" as const },
    };
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not rerun after restart");
        },
        reviewWithObservation: async (_contract, candidateSha, _check, cycle) => {
          reviews += 1;
          if (reviews === 1)
            return {
              review: {
                sha: candidateSha,
                verdict: "inconclusive" as const,
                summary: "transient interruption",
                findings: [],
                failureClass: "network" as const,
              },
              usage: null,
              interruption: { phase: "turn" as const, failureClass: "network" as const },
            };
          expect(cycle).toBe(2);
          return {
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
            usage: null,
          };
        },
      },
      {
        deliver: async (_contract, candidateSha) => ({
          sha: candidateSha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "transient-review-restart",
        }),
      },
    );

    const waiting = await executeDeliveryRun(input, services);
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "review_interruption", failureClass: "network" },
      candidateSha: sha,
      check: { sha, status: "passed" },
    });
    const delivered = await executeDeliveryRun(input, services);
    expect(delivered).toMatchObject({
      state: "reviewed_pr",
      candidateSha: sha,
      check: { sha, status: "passed" },
      review: { sha, verdict: "approved" },
    });
    expect(reviews).toBe(2);
  });

  test("does not replace a reviewer interrupted by a non-transient provider class", async () => {
    const id = "non-transient-review";
    const fake = fakeAuthority(persistedResult("checked", id));
    let reviews = 0;
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "non-transient-review-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("check must not rerun");
          },
          reviewWithObservation: async (_contract, candidateSha) => {
            reviews += 1;
            return {
              review: {
                sha: candidateSha,
                verdict: "inconclusive" as const,
                summary: "configuration failure",
                findings: [],
                failureClass: "configuration" as const,
              },
              usage: null,
              interruption: { phase: "startup" as const, failureClass: "configuration" as const },
            };
          },
        },
        {
          deliver: async () => {
            throw new Error("delivery must not run");
          },
        },
      ),
    );

    expect(result).toMatchObject({ state: "blocked", blockerClassification: "configuration" });
    expect(reviews).toBe(1);
  });

  test("waits for explicit delivery reconciliation and retries the approved bundle", async () => {
    const id = `delivery-reconciliation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("reviewed", id));
    let deliveries = 0;
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not run during delivery reconciliation");
        },
        reviewWithObservation: async () => {
          throw new Error("review must not run during delivery reconciliation");
        },
      },
      {
        deliver: async (_contract, candidateSha, check, review) => {
          deliveries += 1;
          expect(check.sha).toBe(candidateSha);
          expect(review).toMatchObject({ sha: candidateSha, verdict: "approved" });
          if (deliveries === 1) throw new ForgeDeliveryReconciliationError();
          return {
            sha: candidateSha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "reconciled",
          };
        },
      },
    );
    const input = {
      contract: contract(id),
      contractHash: "delivery-reconciliation-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
      reviewer: { ...implementer, role: "reviewer" as const, sandbox: "read-only" as const },
    };

    const waiting = await executeDeliveryRun(input, services);
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed", activation: 1 },
      candidateSha: sha,
      review: { sha, verdict: "approved" },
    });
    await fake.retry();
    const delivered = await executeDeliveryRun(input, services);

    expect(delivered).toMatchObject({
      state: "reviewed_pr",
      candidateSha: sha,
      delivery: { sha, prNumber: 80, attestationId: "reconciled" },
    });
    expect(deliveries).toBe(2);
  });

  test("blocks an untyped definite delivery refusal instead of making it retryable", async () => {
    const id = "definite-delivery-refusal";
    const fake = fakeAuthority(persistedResult("reviewed", id));
    const refusal = Object.assign(new Error("definite delivery refusal"), { status: 400 });
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "definite-delivery-refusal-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("check must not run for a delivery refusal");
          },
          reviewWithObservation: async () => {
            throw new Error("review must not run for a delivery refusal");
          },
        },
        {
          deliver: async () => {
            throw refusal;
          },
        },
      ),
    );

    expect(result).toMatchObject({
      state: "blocked",
      blocker: "definite delivery refusal",
      blockerClassification: "delivery_failure",
    });
    expect(result.waiting).toBeNull();
  });

  test("requires a typed fresh-review observation from Quality Gate", () => {
    const legacyQuality = {
      check: async () => ({
        sha,
        status: "passed" as const,
        command: "true",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      review: async () => ({
        sha,
        verdict: "approved" as const,
        summary: "approved",
        findings: [],
      }),
    };

    // @ts-expect-error Delivery Run must not accept the legacy verdict-only callback.
    const quality: DeliveryRunServices["quality"] = legacyQuality;
    expect(quality).toBe(legacyQuality);
  });

  test("records provider-neutral coding observations without raw session data", async () => {
    const id = `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("admitted", id));
    let implementerContract: unknown;
    let implementerPrompt: string | undefined;
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "history-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
        reviewer: { ...implementer, role: "reviewer", sandbox: "read-only" },
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId, activation, baseSha) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({ sha, baseSha: writer.baseSha, workspace: writer }),
          quarantine: async () => undefined,
        },
        session: {
          run: async (request) => {
            implementerContract = request.contract;
            implementerPrompt = request.prompt;
            await request.onObservation?.({
              type: "mcp_unavailable",
              server: "github_read_implementer",
              reason: "unavailable",
            });
            return {
              status: "completed" as const,
              output: { status: "proposed" as const, summary: "candidate" },
              summary: "completed",
              failure: null,
              usage: { inputTokens: 12, outputTokens: 7 },
              requestedProfile: "implementer-profile",
              effectiveProfile: {
                profileName: "implementer-profile",
                configSha256: "1".repeat(64),
                adapter: "sdk" as const,
                model: "gpt-5.4",
                modelProvider: "openai",
                reasoningEffort: "low" as const,
                developerInstructionsSha256: "2".repeat(64),
              },
              archiveId: "archive_00000000-0000-0000-0000-000000000001",
              archiveStatus: "stored" as const,
              archiveCompleteness: "complete" as const,
            };
          },
        },
        quality: {
          check: async (_contract, candidateSha) => ({
            sha: candidateSha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
          reviewWithObservation: async (_contract, candidateSha, _check, _cycle, onObservation) => {
            await onObservation?.({
              type: "mcp_tool_completed",
              server: "github_read_reviewer",
              tool: "github_pull_request_reviews",
              outcome: "succeeded",
            });
            return {
              review: {
                sha: candidateSha,
                verdict: "approved" as const,
                summary: "approved",
                findings: [],
              },
              usage: { inputTokens: 5, outputTokens: 3 },
              requestedProfile: "reviewer-profile",
              effectiveProfile: {
                profileName: "reviewer-profile",
                configSha256: "3".repeat(64),
                adapter: "app-server" as const,
                model: "gpt-5.4",
                modelProvider: "openai",
                reasoningEffort: "high" as const,
                developerInstructionsSha256: "4".repeat(64),
              },
              archive: {
                archiveId: "archive_00000000-0000-0000-0000-000000000002",
                status: "stored" as const,
                completeness: "partial" as const,
              },
            };
          },
        },
        forge: {
          deliver: async (_contract, candidateSha) => ({
            sha: candidateSha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "history",
          }),
        },
      },
    );

    expect(result.state).toBe("reviewed_pr");
    expect(implementerContract).toMatchObject({
      authorization: { delivery: true },
      delivery: { branch: "agent/recovery", issue: 80 },
    });
    expect(implementerContract).not.toHaveProperty("repository");
    expect(implementerContract).not.toHaveProperty("projectCheck");
    expect(implementerContract).not.toHaveProperty("delivery.baseBranch");
    expect(implementerPrompt).toContain(`Task Contract: ${JSON.stringify(implementerContract)}`);
    expect(fake.getObservations().map(({ data }) => data.type)).toEqual([
      "coding_session_started",
      "coding_mcp_unavailable",
      "coding_session_completed",
      "coding_session_started",
      "coding_mcp_tool_completed",
      "coding_session_completed",
    ]);
    expect(
      fake
        .getObservations()
        .filter(({ data }) => data.type === "coding_session_completed")
        .map(({ data }) => data),
    ).toEqual([
      {
        type: "coding_session_completed",
        role: "implementer",
        activation: 1,
        outcome: "succeeded",
        sessionId: "coding-session:1:implementer",
        requestedProfile: "implementer-profile",
        effectiveProfile: {
          profileName: "implementer-profile",
          configSha256: "1".repeat(64),
          adapter: "sdk",
          model: "gpt-5.4",
          modelProvider: "openai",
          reasoningEffort: "low",
          developerInstructionsSha256: "2".repeat(64),
        },
        usage: { inputTokens: 12, outputTokens: 7 },
        archive: {
          archiveId: "archive_00000000-0000-0000-0000-000000000001",
          status: "stored",
          completeness: "complete",
        },
      },
      {
        type: "coding_session_completed",
        role: "reviewer",
        activation: 0,
        reviewCycle: 1,
        outcome: "succeeded",
        sessionId: expect.stringMatching(/^review-session:1:[0-9a-f-]{36}$/),
        requestedProfile: "reviewer-profile",
        effectiveProfile: {
          profileName: "reviewer-profile",
          configSha256: "3".repeat(64),
          adapter: "app-server",
          model: "gpt-5.4",
          modelProvider: "openai",
          reasoningEffort: "high",
          developerInstructionsSha256: "4".repeat(64),
        },
        usage: { inputTokens: 5, outputTokens: 3 },
        archive: {
          archiveId: "archive_00000000-0000-0000-0000-000000000002",
          status: "stored",
          completeness: "partial",
        },
      },
    ]);
    expect(
      fake
        .getObservations()
        .map(({ data }) => (data.type === "coding_session_started" ? data.sessionId : null)),
    ).toEqual([
      "coding-session:1:implementer",
      null,
      null,
      expect.stringMatching(/^review-session:1:[0-9a-f-]{36}$/),
      null,
      null,
    ]);
    expect(JSON.stringify(fake.getObservations())).not.toMatch(
      /provider-thread|provider-session|sensitive prompt|runtime-evidence|private instruction|https?:\/\/|raw-payload/i,
    );
  });

  test("keeps reviewer invocations separate across checked-state restart", async () => {
    const id = `review-restart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("checked", id));
    const firstController = new AbortController();
    let reviews = 0;
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not restart");
        },
        reviewWithObservation: async (_contract, candidateSha, _check, _cycle, onObservation) => {
          reviews += 1;
          await onObservation?.({ type: "turn_started", turn: 1 });
          if (reviews === 1) {
            firstController.abort();
            throw new Error("server restart interrupted reviewer");
          }
          return {
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved after restart",
              findings: [],
            },
            usage: null,
          };
        },
      },
      {
        deliver: async (_contract, candidateSha) => ({
          sha: candidateSha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "review-restart",
        }),
      },
    );

    await expect(
      executeDeliveryRun(
        {
          contract: contract(id),
          contractHash: "review-restart-hash",
          repositoryIdentity: `recovery/${id}`,
          deadlineEpochMs: Date.now() + 60_000,
          implementer,
          reviewer: { ...implementer, role: "reviewer", sandbox: "read-only" },
          signal: firstController.signal,
        },
        services,
      ),
    ).rejects.toThrow("server restart interrupted reviewer");

    const recovered = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "review-restart-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
        reviewer: { ...implementer, role: "reviewer", sandbox: "read-only" },
      },
      services,
    );

    const reviewerStarts = fake
      .getObservations()
      .filter(({ data }) => data.type === "coding_session_started");
    const reviewerCompletions = fake
      .getObservations()
      .filter(({ data }) => data.type === "coding_session_completed");
    expect(recovered.state).toBe("reviewed_pr");
    expect(reviewerStarts).toHaveLength(2);
    expect(reviewerCompletions).toHaveLength(2);
    expect(new Set(reviewerStarts.map(({ eventId }) => eventId)).size).toBe(2);
    expect(new Set(reviewerCompletions.map(({ eventId }) => eventId)).size).toBe(2);
    expect(
      new Set(
        reviewerStarts.map(({ data }) =>
          data.type === "coding_session_started" ? data.sessionId : null,
        ),
      ).size,
    ).toBe(2);
    expect(
      new Set(
        reviewerCompletions.map(({ data }) =>
          data.type === "coding_session_completed" ? data.sessionId : null,
        ),
      ).size,
    ).toBe(2);
    expect(
      [...reviewerStarts, ...reviewerCompletions].every(
        ({ data }) => "activation" in data && data.activation === 0,
      ),
    ).toBe(true);
    expect(
      reviewerStarts.map(({ data }) =>
        data.type === "coding_session_started" ? data.reviewCycle : null,
      ),
    ).toEqual([1, 1]);
    expect(
      reviewerCompletions.map(({ data }) =>
        data.type === "coding_session_completed" ? data.outcome : null,
      ),
    ).toEqual(["cancelled", "succeeded"]);
    expect(
      reviewerCompletions.every(
        ({ data }) => data.type !== "coding_session_completed" || data.reviewCycle === 1,
      ),
    ).toBe(true);
  });

  test("waits on only an implementer turn network interruption", async () => {
    const id = `waiting-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("admitted", id));
    let sessions = 0;
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not start");
        },
        reviewWithObservation: async () => {
          throw new Error("review must not start");
        },
      },
      {
        deliver: async () => {
          throw new Error("delivery must not start");
        },
      },
    );
    services.session = {
      run: async () => {
        sessions += 1;
        return {
          status: "failed" as const,
          output: null,
          summary: "network interruption",
          failure: "network interruption",
          phase: "turn" as const,
          failureClass: "network" as const,
        };
      },
    };
    const input = {
      contract: contract(id),
      contractHash: "waiting-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    const waiting = await executeDeliveryRun(input, services);
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "network_interruption", resumeState: "admitted", activation: 1 },
      evidence: { implementerActivations: 1 },
    });
    const reentered = await executeDeliveryRun(input, services);
    expect(reentered).toEqual(waiting);
    expect(sessions).toBe(1);
  });

  test.each([
    ["waits on a transient turn transport interruption", "transient_transport", "waiting"],
    ["blocks a deterministic turn transport interruption", "transport", "blocked"],
  ] as const)("%s", async (_label, failureClass, expectedState) => {
    const id = `transport-class-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("admitted", id));
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not start");
        },
        reviewWithObservation: async () => {
          throw new Error("review must not start");
        },
      },
      {
        deliver: async () => {
          throw new Error("delivery must not start");
        },
      },
    );
    services.session = {
      run: async () => ({
        status: "failed" as const,
        output: null,
        summary: "typed transport interruption",
        failure: "typed transport interruption",
        phase: "turn" as const,
        failureClass,
      }),
    };
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: `transport-class-hash-${expectedState}`,
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      services,
    );
    expect(result.state).toBe(expectedState);
    if (expectedState === "waiting")
      expect(result.waiting).toMatchObject({ reason: "network_interruption" });
    else expect(result.blockerClassification).toBe("protocol");
  });

  test("blocks an implementer startup transport interruption", async () => {
    const id = `blocked-startup-transport-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fake = fakeAuthority(persistedResult("admitted", id));
    const services = servicesFor(
      fake.authority,
      {
        check: async () => {
          throw new Error("check must not start");
        },
        reviewWithObservation: async () => {
          throw new Error("review must not start");
        },
      },
      {
        deliver: async () => {
          throw new Error("delivery must not start");
        },
      },
    );
    services.session = {
      run: async () => ({
        status: "failed" as const,
        output: null,
        summary: "transport interruption",
        failure: "transport interruption",
        phase: "startup" as const,
        failureClass: "transport" as const,
      }),
    };
    const blocked = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "blocked-startup-transport-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      services,
    );
    expect(blocked).toMatchObject({
      state: "blocked",
      blockerClassification: "protocol",
      evidence: { implementerActivations: 1 },
    });
  });

  test("persists an authorized exact-head merge effect as the merged terminal state", async () => {
    const id = "authorized-merge-boundary";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const mergeCommitSha = "c".repeat(40);
    const result = await executeDeliveryRun(
      {
        contract: contract(id, true),
        contractHash: "authorized-merge-boundary-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => ({
            sha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "authorized",
            merge: {
              prNumber: 80,
              approvedHeadSha: sha,
              mergeCommitSha,
              observedState: "merged" as const,
            },
          }),
        },
      ),
    );

    expect(result).toMatchObject({
      state: "merged",
      mergeAuthorized: true,
      delivery: {
        sha,
        attestationId: "authorized",
        merge: { prNumber: 80, approvedHeadSha: sha, mergeCommitSha, observedState: "merged" },
      },
    });
  });

  test("turns a proved platform merge refusal into a blocker without a delivery fact", async () => {
    const id = "platform-refusal-boundary";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const result = await executeDeliveryRun(
      {
        contract: contract(id, true),
        contractHash: "platform-refusal-boundary-hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => {
            throw new DeliveryQuarantineError(
              "platform merge refused after authoritative probe: required check is pending",
            );
          },
        },
      ),
    );

    expect(result).toMatchObject({
      state: "blocked",
      blocker: "platform merge refused after authoritative probe: required check is pending",
      blockerClassification: "delivery_failure",
      delivery: null,
    });
    expect(fake.getStored().delivery).toBeNull();
  });

  test("re-enters an authorized pre-merge result and records one recovered merge effect", async () => {
    const id = "authorized-merge-reentry";
    const fake = fakeAuthority(persistedResult("reviewed", id, true));
    const mergeCommitSha = "d".repeat(40);
    let calls = 0;
    const forge = {
      deliver: async () => {
        calls += 1;
        if (calls === 1) throw new ForgeDeliveryReconciliationError();
        return {
          sha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "recovered-merge",
          merge: {
            prNumber: 80,
            approvedHeadSha: sha,
            mergeCommitSha,
            observedState: "merged" as const,
          },
        };
      },
    };
    const input = {
      contract: contract(id, true),
      contractHash: "authorized-merge-reentry-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    const noOpQuality = {
      check: async () => {
        throw new Error("unexpected check");
      },
      reviewWithObservation: async () => {
        throw new Error("unexpected review");
      },
    };

    const waiting = await executeDeliveryRun(
      input,
      servicesFor(fake.authority, noOpQuality, forge),
    );
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed" },
      delivery: null,
    });
    await fake.retry();

    const recovered = await executeDeliveryRun(
      input,
      servicesFor(fake.authority, noOpQuality, forge),
    );
    expect(recovered).toMatchObject({
      state: "merged",
      delivery: { attestationId: "recovered-merge", merge: { mergeCommitSha } },
    });
    expect(calls).toBe(2);
  });

  test("stops before recording candidate evidence when cancelled", async () => {
    const id = `cancelled-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const controller = new AbortController();
    const state = fakeAuthority(persistedResult("admitted", id));
    const input = {
      contract: contract(id),
      contractHash: "cancelled-run-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 30_000,
      implementer,
      signal: controller.signal,
    };

    await expect(
      executeDeliveryRun(input, {
        ...servicesFor(
          state.authority,
          {
            check: async () => {
              throw new Error("check should not start");
            },
            reviewWithObservation: async () => {
              throw new Error("review should not start");
            },
          },
          {
            deliver: async () => {
              throw new Error("delivery should not start");
            },
          },
        ),
        session: {
          run: async () => {
            controller.abort();
            return {
              status: "completed" as const,
              output: { status: "proposed" as const, summary: "candidate" },
              summary: "completed",
              failure: null,
            };
          },
        },
      }),
    ).rejects.toThrow("task execution cancelled");
    expect(state.getStored()).toMatchObject({ state: "admitted", candidateSha: null });
  });

  test("returns the first durable blocker after a failed check exhausts activations", async () => {
    const id = `sqlite-terminal-block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const taskContract = {
      ...contract(id),
      budget: { ...contract(id).budget, maxImplementerActivations: 1 },
    };
    const repositoryIdentity = `recovery/${id}`;
    const directory = await mkdtemp(join(tmpdir(), "usine-delivery-run-"));
    const databasePath = join(directory, "state.sqlite");
    await applyMigrations(databasePath);
    const database = openSqliteDatabase(databasePath);
    const realAuthority = new TaskAuthority(database.database);
    let blockCalls = 0;
    const authority = new Proxy(realAuthority, {
      get(target, property, receiver) {
        if (property === "block") {
          return (...args: Parameters<TaskAuthority["block"]>) => {
            blockCalls += 1;
            return target.block(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = {
      contract: taskContract,
      contractHash: "a".repeat(64),
      repositoryIdentity,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };

    try {
      const result = await executeDeliveryRun(input, {
        authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async () => ({
            status: "completed" as const,
            output: { status: "proposed" as const, summary: "candidate" },
            summary: "completed",
            failure: null,
          }),
        },
        quality: {
          check: async () => ({
            sha,
            status: "failed" as const,
            command: "pnpm test",
            exitCode: 1,
            stdout: "",
            stderr: "budget exhausted while checking candidate",
          }),
          reviewWithObservation: async () => {
            throw new Error("failed candidate must not be reviewed");
          },
        },
        forge: {
          deliver: async () => {
            throw new Error("failed candidate must not be delivered");
          },
        },
      });

      expect(result.state).toBe("blocked");
      expect(result.blocker).toBe("implementer activation budget exhausted");
      expect(result.blockerClassification).toBe("implementation_budget");
      expect(taskResourceFromResult(result).blocker).toEqual({
        classification: "implementation_budget",
      });
      const blockedEvent = (await authority.listEvents(result.taskId)).find(
        (event) => event.data.type === "task_blocked",
      );
      expect(blockedEvent).toMatchObject({
        data: { type: "task_blocked", reason: "implementation_budget" },
      });
      expect(result.evidence.implementerActivations).toBe(1);
      expect(blockCalls).toBe(1);

      const rerun = await executeDeliveryRun(
        input,
        servicesFor(
          authority,
          {
            check: async () => {
              throw new Error("terminal task must not be checked");
            },
            reviewWithObservation: async () => {
              throw new Error("terminal task must not be reviewed");
            },
          },
          {
            deliver: async () => {
              throw new Error("terminal task must not be delivered");
            },
          },
        ),
      );
      expect(rerun).toEqual(result);
      expect(blockCalls).toBe(1);

      const nextTask = await authority.admit({
        contract: contract(`${id}-next`),
        contractHash: "sqlite-terminal-block-next-hash",
        repositoryIdentity,
        deadlineEpochMs: Date.now() + 60_000,
      });
      expect(nextTask.state).toBe("admitted");
    } finally {
      database.close();
    }
  }, 30_000);

  test("passes lossless failed-check evidence to repair without reviewing or delivering it", async () => {
    const id = "stdout-only-check-failure";
    const fake = fakeAuthority(persistedResult("admitted", id));
    const prompts: string[] = [];
    const checked: string[] = [];
    const sessions = [
      {
        status: "completed" as const,
        output: { status: "proposed" as const, summary: "candidate" },
        summary: "completed",
        failure: null,
      },
      {
        status: "completed" as const,
        output: { status: "blocked" as const, summary: "repair evidence received" },
        summary: "blocked",
        failure: null,
      },
    ];
    const quality = {
      check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
        checked.push(candidateSha);
        return {
          sha: candidateSha,
          status: "failed" as const,
          command: "vp test run tests/repair.test.ts",
          exitCode: 7,
          stdout: "repair this stdout-only diagnostic",
          stderr: "",
        };
      },
      reviewWithObservation: async () => {
        throw new Error("failed candidate must not be reviewed");
      },
    };
    const forge = {
      deliver: async () => {
        throw new Error("failed candidate must not be delivered");
      },
    };
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }) => {
            prompts.push(prompt);
            return sessions.shift()!;
          },
        },
        quality,
        forge,
      },
    );

    expect(result.state).toBe("blocked");
    expect(checked).toEqual([sha]);
    expect(fake.getImplementerActivations()).toBe(2);
    expect(prompts[1]).toContain(
      `Failed project check evidence: ${JSON.stringify({
        sha,
        status: "failed",
        command: "vp test run tests/repair.test.ts",
        exitCode: 7,
        stdout: "repair this stdout-only diagnostic",
        stderr: "",
      })}`,
    );
    expect(result.review).toBeNull();
  });

  test("aggregates one changes-requested batch before the repair delivery", async () => {
    const id = "review-repair";
    const acceptedReview = reviewerOutputSchema.parse({
      sha,
      verdict: "changes_requested",
      summary: "fix the candidate",
      findings: ["fix the regression", "add a regression test"],
    });
    const initial = {
      ...persistedResult("reviewed", id),
      review: acceptedReview,
    };
    const fake = fakeAuthority(initial);
    const prompts: string[] = [];
    const checked: string[] = [];
    const reviewed: string[] = [];
    const delivered: string[] = [];
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      {
        authority: fake.authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, baseSha: string) => ({
            taskId: id,
            activation,
            path: ".",
            baseSha,
          }),
          freeze: async (writer) => ({
            sha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async ({ prompt }) => {
            prompts.push(prompt);
            return {
              status: "completed" as const,
              output: { status: "proposed" as const, summary: "repaired" },
              summary: "completed",
              failure: null,
            };
          },
        },
        quality: {
          check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            checked.push(candidateSha);
            return {
              sha: candidateSha,
              status: "passed" as const,
              command: "true",
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
          reviewWithObservation: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            reviewed.push(candidateSha);
            return {
              review: {
                sha: candidateSha,
                verdict: "approved" as const,
                summary: "approved",
                findings: [],
              },
              usage: null,
            };
          },
        },
        forge: {
          deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
            delivered.push(candidateSha);
            return {
              sha: candidateSha,
              effect: "github" as const,
              prNumber: 80,
              url: "https://example.invalid/pr/80",
              attestationId: "repair",
            };
          },
        },
      },
    );

    expect(result.state).toBe("reviewed_pr");
    expect(prompts[0]).toContain(
      `Aggregated findings to repair: ${acceptedReview.findings.join("; ")}`,
    );
    expect(checked).toEqual([sha]);
    expect(reviewed).toEqual([sha]);
    expect(delivered).toEqual([sha]);
    expect(fake.getStored().evidence.changesRequestedBatches).toBe(1);
  });

  test("records one repair batch when a recovered changes-requested verdict is retried", async () => {
    const id = "review-repair-after-transient-recovery";
    const taskContract = {
      ...contract(id),
      budget: { ...contract(id).budget, maxImplementerActivations: 3, maxReviewCycles: 3 },
    };
    const fake = fakeAuthority(persistedResult("checked", id));
    let repairBatchCalls = 0;
    const recordRepairBatch = fake.authority.recordRepairBatch;
    fake.authority.recordRepairBatch = async (observation) => {
      repairBatchCalls += 1;
      return recordRepairBatch(observation);
    };
    let reviews = 0;
    let repairSessions = 0;
    const services = servicesFor(
      fake.authority,
      {
        check: async (_contract, candidateSha) => ({
          sha: candidateSha,
          status: "passed" as const,
          command: "true",
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
        reviewWithObservation: async (_contract, candidateSha, _check, cycle) => {
          reviews += 1;
          if (reviews === 1)
            return {
              review: null,
              usage: null,
              interruption: { phase: "turn" as const, failureClass: "network" as const },
            };
          if (reviews === 2)
            return {
              review: {
                sha: candidateSha,
                verdict: "changes_requested" as const,
                summary: "repair the candidate",
                findings: ["repair the candidate"],
              },
              usage: null,
            };
          expect(cycle).toBe(3);
          return {
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved after repair retry",
              findings: [],
            },
            usage: null,
          };
        },
      },
      {
        deliver: async (_contract, candidateSha) => ({
          sha: candidateSha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "repair-after-recovery",
        }),
      },
    );
    services.session = {
      run: async () => {
        repairSessions += 1;
        if (repairSessions === 1)
          return {
            status: "failed" as const,
            output: null,
            summary: "repair network interruption",
            failure: "repair network interruption",
            phase: "turn" as const,
            failureClass: "network" as const,
          };
        return {
          status: "completed" as const,
          output: { status: "proposed" as const, summary: "repaired" },
          summary: "repair completed",
          failure: null,
        };
      },
    };
    services.workspace.freeze = async (workspace, previousSha) => ({
      sha,
      baseSha: previousSha,
      workspace,
    });

    const input = {
      contract: taskContract,
      contractHash: "review-repair-after-transient-recovery-hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    const waiting = await executeDeliveryRun(input, services);
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "network_interruption", resumeState: "reviewed" },
      review: { verdict: "changes_requested" },
      evidence: { reviewCycles: 2, changesRequestedBatches: 1 },
      repairBatchRecorded: true,
    });

    await fake.retry();
    const delivered = await executeDeliveryRun(input, services);
    expect(delivered).toMatchObject({
      state: "reviewed_pr",
      review: { verdict: "approved" },
      evidence: { reviewCycles: 3, changesRequestedBatches: 1 },
    });
    expect(delivered.repairBatchRecorded).toBe(false);
    expect(repairBatchCalls).toBe(2);
    expect(repairSessions).toBe(2);
    expect(reviews).toBe(3);
  });

  test.each(["candidate", "checked", "reviewed"] as const)(
    "resumes %s without another implementer activation",
    async (state) => {
      const id = `phase-${state}`;
      const initial = persistedResult(state, id);
      const fake = fakeAuthority(initial);
      const evaluated: string[] = [];
      const reviewed: string[] = [];
      const delivered: string[] = [];
      const quality = {
        check: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          evaluated.push(candidateSha);
          return {
            sha: candidateSha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
        reviewWithObservation: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          reviewed.push(candidateSha);
          return {
            review: {
              sha: candidateSha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
            usage: null,
          };
        },
      };
      const forge = {
        deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
          delivered.push(candidateSha);
          return {
            sha: candidateSha,
            effect: "github" as const,
            prNumber: 80,
            url: "https://example.invalid/pr/80",
            attestationId: "recovery",
          };
        },
      };
      const result = await executeDeliveryRun(
        {
          contract: contract(id),
          contractHash: "hash",
          repositoryIdentity: `recovery/${id}`,
          deadlineEpochMs: Date.now() + 60_000,
          implementer,
        },
        servicesFor(fake.authority, quality, forge),
      );
      expect(result.state).toBe("reviewed_pr");
      expect(fake.getImplementerActivations()).toBe(0);
      expect(evaluated).toEqual(state === "candidate" ? [sha] : []);
      expect(reviewed).toEqual(state === "reviewed" ? [] : [sha]);
      expect(delivered).toEqual([sha]);
    },
  );

  test("durably blocks an expired persisted deadline without activating a writer", async () => {
    const id = "expired-phase";
    const initial = persistedResult("admitted", id);
    const expired = { ...initial, deadlineEpochMs: Date.now() - 1 };
    const fake = fakeAuthority(expired);
    const result = await executeDeliveryRun(
      {
        contract: contract(id),
        contractHash: "hash",
        repositoryIdentity: `recovery/${id}`,
        // A restarted caller may supply a fresh wall-clock budget; the reducer
        // must ignore it in favor of the persisted deadline.
        deadlineEpochMs: Date.now() + 60_000,
        implementer,
      },
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        {
          deliver: async () => {
            throw new Error("unexpected delivery");
          },
        },
      ),
    );
    expect(result.state).toBe("blocked");
    expect(result.blocker).toBe("elapsed budget exhausted");
    expect(result.blockerClassification).toBe("elapsed_budget");
    expect(fake.getImplementerActivations()).toBe(0);
  });

  test("reconciles an uncertain forge effect from the persisted approved review", async () => {
    const id = "uncertain-forge";
    const fake = fakeAuthority(persistedResult("reviewed", id));
    let calls = 0;
    let effectObserved = false;
    const forge = {
      deliver: async (_contract: ResolvedTaskContract, candidateSha: string) => {
        calls += 1;
        if (!effectObserved) {
          // The external PR/comment write happened, but the coordinator lost
          // the response before it could persist reviewed_pr.
          effectObserved = true;
          throw new ForgeDeliveryReconciliationError();
        }
        return {
          sha: candidateSha,
          effect: "github" as const,
          prNumber: 80,
          url: "https://example.invalid/pr/80",
          attestationId: "reconciled",
        };
      },
    };
    const input = {
      contract: contract(id),
      contractHash: "hash",
      repositoryIdentity: `recovery/${id}`,
      deadlineEpochMs: Date.now() + 60_000,
      implementer,
    };
    const waiting = await executeDeliveryRun(
      input,
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        forge,
      ),
    );
    expect(waiting).toMatchObject({
      state: "waiting",
      waiting: { reason: "delivery_reconciliation", resumeState: "reviewed" },
    });
    await fake.retry();
    const result = await executeDeliveryRun(
      input,
      servicesFor(
        fake.authority,
        {
          check: async () => {
            throw new Error("unexpected check");
          },
          reviewWithObservation: async () => {
            throw new Error("unexpected review");
          },
        },
        forge,
      ),
    );
    expect(result.state).toBe("reviewed_pr");
    expect(result.candidateSha).toBe(sha);
    expect(fake.getImplementerActivations()).toBe(0);
    expect(calls).toBe(2);
    expect(effectObserved).toBe(true);
  });
});
