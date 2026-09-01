import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  compareProfileEvaluation,
  executeProfileEvaluation,
  readProfileEvaluationPlan,
  runProfileEvaluateCommand,
  profileCommand,
  type ProfileEvaluationServices,
  ProfileEvaluationRestorationError,
} from "../src/profile-evaluation.js";
import type { RoleRunEvidence, TaskEvidence } from "../src/task-evidence.js";
import type { RepositoryResource, TaskResource } from "@usine/task-authority";
import {
  inspectRepository as inspectServerRepository,
  registerRepository as registerServerRepository,
  submitTask as submitServerTask,
  taskEvidence as readServerTaskEvidence,
  taskStatus as readServerTaskStatus,
  followTask as followServerTask,
  retryTask as retryServerTask,
  type FollowOptions,
} from "../src/server-client.js";
import {
  inspectRepository as inspectRuntimeRepository,
  registerRepository as registerRuntimeRepository,
  startUsineServer,
} from "@usine/runtime";

const cliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function fixture(pairDrift = false, maxElapsedMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "usine-profile-evaluation-"));
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "evaluation\n");
  await execa("git", ["add", "README.md"], { cwd: root });
  await execa("git", ["commit", "-m", "base"], { cwd: root });
  const baseSha = await git(root, "rev-parse", "HEAD");
  const contract = (id: string, issue: number, branch: string, instructions: string) => ({
    id,
    repositoryId: "evaluation",
    baseSha,
    instructions,
    acceptance: ["The bounded evaluation outcome is observable."],
    nonGoals: ["No merge is authorized."],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs },
    authorization: {
      source: `https://github.com/example/evaluation/issues/${issue}`,
      delivery: true,
    },
    delivery: { branch, issue, title: "Evaluation", body: "Evaluation" },
  });
  await writeFile(
    join(root, "baseline.json"),
    JSON.stringify(contract("baseline-task", 278, "agent/baseline", "same outcome")),
  );
  await writeFile(
    join(root, "candidate.json"),
    JSON.stringify(
      contract(
        "candidate-task",
        279,
        "agent/candidate",
        pairDrift ? "different outcome" : "same outcome",
      ),
    ),
  );
  await writeFile(
    join(root, "repository.json"),
    JSON.stringify({
      id: "evaluation",
      path: root,
      owner: "example",
      name: "evaluation",
      baseBranch: "main",
      implementerProfile: "prior-profile",
      reviewerProfile: "fixed-reviewer",
      forgeProfile: "evaluation",
      githubReadProfile: null,
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    }),
  );
  const planPath = join(root, "evaluation-plan.json");
  const usineBuild = await git(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    "rev-parse",
    "HEAD",
  );
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "evaluation-plan",
      repositoryId: "evaluation",
      baseSha,
      subjectRole: "implementer",
      changedFactor: "model_stack",
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild,
      reportPath: "reports/evaluation-report.json",
      registrationPath: "repository.json",
      pairs: [
        {
          id: "case-one",
          repetition: 1,
          baselineContractPath: "baseline.json",
          candidateContractPath: "candidate.json",
        },
      ],
    }),
  );
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["commit", "-m", "authorize evaluation plan"], { cwd: root });
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  for (const profile of ["baseline-profile", "candidate-profile", "fixed-reviewer"]) {
    await writeFile(
      join(codexHome, `${profile}.config.toml`),
      `model = "${profile === "baseline-profile" ? "baseline-model" : profile === "candidate-profile" ? "candidate-model" : "reviewer-model"}"\n`,
    );
  }
  return { root, planPath, environment: { CODEX_HOME: codexHome } };
}

function evaluationRun(profile: string, elapsedMs: number, activation: number): RoleRunEvidence {
  return {
    role: "implementer",
    activation,
    reviewCycle: null,
    requestedProfile: profile,
    effectiveProfile: {
      profileName: profile,
      configSha256: "1".repeat(64),
      adapter: "sdk",
      model: "test-model",
      modelProvider: null,
      reasoningEffort: null,
      developerInstructionsSha256: null,
    },
    effort: {
      elapsedMs,
      counts: { turns: 1, tools: 0, mcpTools: 0 },
      phase: "output",
      failureClass: null,
      observations: [],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    archive: { archiveId: null, status: "unavailable" },
    outcome: {
      status: "succeeded",
      candidateSha: "b".repeat(40),
      taskRelation: "accepted_exact_sha",
    },
  };
}

function evaluationReviewer(): RoleRunEvidence {
  return {
    ...evaluationRun("fixed-reviewer", 1, 1),
    role: "reviewer",
    activation: null,
    reviewCycle: 1,
  };
}

function evaluationEvidence(
  profile: string,
  taskId: string,
  activations: readonly number[],
): TaskEvidence {
  return {
    schemaVersion: 1,
    taskId,
    roleRuns: {
      implementer: activations.map((activation) =>
        evaluationRun(profile, activation * 10, activation),
      ),
      reviewer: [evaluationReviewer()],
    },
    task: {
      state: "reviewed_pr",
      candidateSha: "b".repeat(40),
      candidateFence: 1,
      check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
      review: {
        sha: "b".repeat(40),
        verdict: "approved",
        classification: "approved",
        findingCount: 0,
      },
      repairBatches: 0,
      delivery: null,
      relation: "accepted_exact_sha",
    },
  };
}

describe("profile evaluate plan boundary", () => {
  async function expectMalformedPlan(
    value: Awaited<ReturnType<typeof fixture>>,
    mutate: (plan: Record<string, unknown>) => unknown,
  ): Promise<void> {
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as Record<string, unknown>;
    const malformed = mutate(plan);
    await writeFile(
      value.planPath,
      typeof malformed === "string" ? malformed : JSON.stringify(malformed),
    );
    await execa("git", ["add", "evaluation-plan.json"], { cwd: value.root });
    await execa("git", ["commit", "-m", "invalid evaluation plan structure"], {
      cwd: value.root,
    });

    let serverCalls = 0;
    const unexpectedServerCall = async (): Promise<never> => {
      serverCalls += 1;
      throw new Error("unexpected server call");
    };
    const services: ProfileEvaluationServices = {
      inspectRepository: unexpectedServerCall,
      registerRepository: unexpectedServerCall,
      submitTask: unexpectedServerCall,
      taskStatus: unexpectedServerCall,
      followTask: unexpectedServerCall,
      retryTask: unexpectedServerCall,
      taskEvidence: unexpectedServerCall,
    };

    process.exitCode = 0;
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "implementer", json: true },
        "http://server.test",
        value.environment,
        services,
      );
      expect(serverCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      await expect(readFile(join(value.root, "reports/evaluation-report.json"))).rejects.toThrow();
    } finally {
      process.exitCode = 0;
    }
  }

  test("accepts a committed pair and resolves all named profiles before execution", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    expect(loaded.plan.subjectRole).toBe("implementer");
    expect(loaded.plan.pairs).toHaveLength(1);
    expect(loaded.contracts.map((contract) => contract.id)).toEqual([
      "baseline-task",
      "candidate-task",
    ]);
  });

  test("rejects a non-object plan before server effects or report writes", async () => {
    const value = await fixture();
    await expectMalformedPlan(value, () => "[]");
  });

  test("rejects a plan with a missing field before server effects or report writes", async () => {
    const value = await fixture();
    await expectMalformedPlan(value, (plan) => {
      delete plan.changedFactor;
      return plan;
    });
  });

  test("rejects a plan with a mistyped field before server effects or report writes", async () => {
    const value = await fixture();
    await expectMalformedPlan(value, (plan) => {
      plan.maxTasks = "2";
      return plan;
    });
  });

  test("rejects an invalid pair shape before server effects or report writes", async () => {
    const value = await fixture();
    await expectMalformedPlan(value, (plan) => {
      plan.pairs = [null];
      return plan;
    });
  });

  test("rejects an excess plan field before server effects or report writes", async () => {
    const value = await fixture();
    await expectMalformedPlan(value, (plan) => {
      plan.unexpected = true;
      return plan;
    });
  });

  test("rejects unshipped aliases before contacting the server", async () => {
    const value = await fixture();
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as Record<string, unknown>;
    delete plan.changedFactor;
    plan.profiles = { baseline: "baseline-profile", candidate: "candidate-profile" };
    await writeFile(value.planPath, JSON.stringify(plan));
    await execa("git", ["add", "evaluation-plan.json"], { cwd: value.root });
    await execa("git", ["commit", "-m", "invalid legacy evaluation shape"], { cwd: value.root });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("unexpected", { status: 500 });
    };
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "implementer", json: true },
        "http://server.test",
        value.environment,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("rejects a profile pair with more than its declared changed factor before server contact", async () => {
    const value = await fixture();
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as Record<string, unknown>;
    plan.changedFactor = "reasoning";
    await writeFile(value.planPath, JSON.stringify(plan));
    await execa("git", ["add", "evaluation-plan.json"], { cwd: value.root });
    await execa("git", ["commit", "-m", "invalid multi-factor evaluation shape"], {
      cwd: value.root,
    });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("unexpected", { status: 500 });
    };
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "implementer", json: true },
        "http://server.test",
        value.environment,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("holds the adapter fixed before the evaluation can contact the server", async () => {
    const value = await fixture();
    await expect(
      readProfileEvaluationPlan(value.planPath, {
        ...value.environment,
        USINE_CODEX_APP_SERVER_PROFILES: "candidate-profile",
      }),
    ).rejects.toThrow("profiles differ outside changedFactor model_stack: adapter");
  });

  test("fails semantic pair drift before the public command contacts the server", async () => {
    const value = await fixture(true);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response("unexpected", { status: 500 });
    };
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "implementer", json: true },
        "http://server.test",
        value.environment,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("keeps unknown evidence unknown and only recommends on correctness-first dominance", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "comparison-plan",
      repositoryId: "evaluation",
      baseSha: "a".repeat(40),
      subjectRole: "implementer" as const,
      changedFactor: "model_stack" as const,
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild: "a".repeat(40),
      reportPath: "report.json",
      registrationPath: "repository.json",
      pairs: [],
    };
    const run = (profile: string, elapsedMs: number) => ({
      role: "implementer" as const,
      activation: 1,
      reviewCycle: null,
      requestedProfile: profile,
      effectiveProfile: {
        profileName: profile,
        configSha256: "1".repeat(64),
        adapter: "sdk" as const,
        model: "test-model",
        modelProvider: null,
        reasoningEffort: null,
        developerInstructionsSha256: null,
      },
      effort: {
        elapsedMs,
        counts: { turns: 1, tools: 0, mcpTools: 0 },
        phase: "output" as const,
        failureClass: null,
        observations: [],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      archive: { archiveId: null, status: "unavailable" as const },
      outcome: {
        status: "succeeded" as const,
        candidateSha: "b".repeat(40),
        taskRelation: "accepted_exact_sha" as const,
      },
    });
    const reviewer = {
      ...run("fixed-reviewer", 1),
      role: "reviewer" as const,
      activation: null,
      reviewCycle: 1,
      outcome: {
        status: "succeeded" as const,
        candidateSha: "b".repeat(40),
        taskRelation: "accepted_exact_sha" as const,
      },
    };
    const accepted = (profile: string, elapsedMs: number): TaskEvidence => ({
      schemaVersion: 1,
      taskId: `${profile}-task`,
      roleRuns: { implementer: [run(profile, elapsedMs)], reviewer: [reviewer] },
      task: {
        state: "reviewed_pr",
        candidateSha: "b".repeat(40),
        candidateFence: 1,
        check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
        review: {
          sha: "b".repeat(40),
          verdict: "approved",
          classification: "approved",
          findingCount: 0,
        },
        repairBatches: 0,
        delivery: null,
        relation: "accepted_exact_sha",
      },
    });
    const unknown: TaskEvidence = {
      ...accepted("candidate-profile", 2),
      taskId: "unknown-task",
      roleRuns: { implementer: [], reviewer: [] },
      task: { ...accepted("candidate-profile", 2).task, relation: "not_yet_accepted" },
    };
    const report = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: accepted("baseline-profile", 10),
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "candidate-task",
          evidence: accepted("candidate-profile", 20),
        },
      ],
    });
    expect(report.recommendation).toBe("baseline");
    const inconclusive = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: accepted("baseline-profile", 10),
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "unknown-task",
          evidence: unknown,
        },
      ],
    });
    expect(inconclusive.recommendation).toBe("inconclusive");
    expect(inconclusive.candidate.metrics.elapsedMs).toBe(null);

    const missingComparisonEvidence = accepted("baseline-profile", 10);
    const missingComparisonReport = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: {
            ...missingComparisonEvidence,
            roleRuns: {
              ...missingComparisonEvidence.roleRuns,
              implementer: [
                {
                  ...missingComparisonEvidence.roleRuns.implementer[0]!,
                  effort: {
                    ...missingComparisonEvidence.roleRuns.implementer[0]!.effort,
                    elapsedMs: null,
                  },
                  usage: null,
                },
              ],
            },
            task: { ...missingComparisonEvidence.task, repairBatches: null },
          },
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "candidate-task",
          evidence: accepted("candidate-profile", 20),
        },
      ],
    });
    expect(missingComparisonReport.recommendation).toBe("inconclusive");
    expect(missingComparisonReport.inconclusiveReasons).toEqual(
      expect.arrayContaining([
        "comparison:elapsedMs:missing_evidence",
        "comparison:inputTokens:missing_evidence",
        "comparison:repairBatches:missing_evidence",
      ]),
    );

    const drifted = accepted("candidate-profile", 20);
    const driftReport = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: accepted("baseline-profile", 10),
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "candidate-task",
          evidence: {
            ...drifted,
            roleRuns: { ...drifted.roleRuns, implementer: [run("other-profile", 20)] },
          },
        },
      ],
    });
    expect(driftReport.recommendation).toBe("inconclusive");
    expect(driftReport.candidate.correctness).toBe("unknown");
    expect(driftReport.comparison.candidate.elapsedMs).toBe(null);

    const effectiveFactorDrift = accepted("candidate-profile", 20);
    const expectedProfile = {
      configSha256: "1".repeat(64),
      model: "candidate-model",
      modelProvider: null,
      reasoningEffort: null,
      developerInstructionsSha256: null,
      adapter: "sdk" as const,
    };
    const factorDriftReport = compareProfileEvaluation(
      plan,
      {
        baseline: [
          {
            id: "baseline",
            pairId: "case",
            repetition: 1,
            taskId: "baseline-task",
            evidence: accepted("baseline-profile", 10),
          },
        ],
        candidate: [
          {
            id: "candidate",
            pairId: "case",
            repetition: 1,
            taskId: "candidate-task",
            evidence: {
              ...effectiveFactorDrift,
              roleRuns: {
                ...effectiveFactorDrift.roleRuns,
                implementer: [
                  {
                    ...run("candidate-profile", 20),
                    effectiveProfile: {
                      ...run("candidate-profile", 20).effectiveProfile,
                      model: "wrong-model",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      {
        baseline: { ...expectedProfile, model: "baseline-model" },
        candidate: expectedProfile,
        reviewer: { ...expectedProfile, model: "test-model" },
      },
    );
    expect(factorDriftReport.recommendation).toBe("inconclusive");
    expect(factorDriftReport.inconclusiveReasons).toContain(
      "candidate-task:implementer_profile_drift",
    );

    const reviewerDrift = accepted("candidate-profile", 20);
    const reviewerDriftReport = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: accepted("baseline-profile", 10),
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "candidate-task",
          evidence: {
            ...reviewerDrift,
            roleRuns: {
              ...reviewerDrift.roleRuns,
              reviewer: [
                {
                  ...reviewerDrift.roleRuns.reviewer[0]!,
                  effectiveProfile: {
                    ...reviewerDrift.roleRuns.reviewer[0]!.effectiveProfile,
                    configSha256: "9".repeat(64),
                  },
                },
              ],
            },
          },
        },
      ],
    });
    expect(reviewerDriftReport.recommendation).toBe("inconclusive");
    expect(reviewerDriftReport.inconclusiveReasons).toContain(
      "candidate-task:reviewer_profile_drift",
    );
  });

  test("keeps unequal activation counts comparable and reports their delta", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "activation-plan",
      repositoryId: "evaluation",
      baseSha: "a".repeat(40),
      subjectRole: "implementer" as const,
      changedFactor: "model_stack" as const,
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild: "a".repeat(40),
      reportPath: "report.json",
      registrationPath: "repository.json",
      pairs: [],
    };
    const report = compareProfileEvaluation(plan, {
      baseline: [
        {
          id: "baseline",
          pairId: "case",
          repetition: 1,
          taskId: "baseline-task",
          evidence: evaluationEvidence("baseline-profile", "baseline-task", [1]),
        },
      ],
      candidate: [
        {
          id: "candidate",
          pairId: "case",
          repetition: 1,
          taskId: "candidate-task",
          evidence: evaluationEvidence("candidate-profile", "candidate-task", [1, 2]),
        },
      ],
    });
    expect(report.recommendation).toBe("baseline");
    expect(report.comparison.baseline.implementerActivations).toBe(1);
    expect(report.comparison.candidate.implementerActivations).toBe(2);
    expect(report.comparison.delta.implementerActivations).toBe(1);
  });

  test("lets correctness choose a winner before efficiency", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "correctness-plan",
      repositoryId: "evaluation",
      baseSha: "a".repeat(40),
      subjectRole: "implementer" as const,
      changedFactor: "model_stack" as const,
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild: "a".repeat(40),
      reportPath: "report.json",
      registrationPath: "repository.json",
      pairs: [],
    };
    const acceptedBaseline = evaluationEvidence("baseline-profile", "baseline-task", [1]);
    const acceptedCandidate = evaluationEvidence("candidate-profile", "candidate-task", [1]);
    const failedCandidate = {
      ...acceptedCandidate,
      task: { ...acceptedCandidate.task, state: "blocked" as const, relation: "blocked" as const },
    };
    const failedBaseline = {
      ...acceptedBaseline,
      task: { ...acceptedBaseline.task, state: "blocked" as const, relation: "blocked" as const },
    };
    const report = (baselineEvidence: TaskEvidence, candidateEvidence: TaskEvidence) =>
      compareProfileEvaluation(plan, {
        baseline: [
          {
            id: "baseline",
            pairId: "case",
            repetition: 1,
            taskId: baselineEvidence.taskId,
            evidence: baselineEvidence,
          },
        ],
        candidate: [
          {
            id: "candidate",
            pairId: "case",
            repetition: 1,
            taskId: candidateEvidence.taskId,
            evidence: candidateEvidence,
          },
        ],
      });
    expect(report(acceptedBaseline, failedCandidate).recommendation).toBe("baseline");
    expect(report(failedBaseline, acceptedCandidate).recommendation).toBe("candidate");
  });

  test("does not require a reviewer after a failed project check", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "failed-check-plan",
      repositoryId: "evaluation",
      baseSha: "a".repeat(40),
      subjectRole: "implementer" as const,
      changedFactor: "model_stack" as const,
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild: "a".repeat(40),
      reportPath: "report.json",
      registrationPath: "repository.json",
      pairs: [],
    };
    const acceptedBaseline = evaluationEvidence("baseline-profile", "baseline-task", [1]);
    const acceptedCandidate = evaluationEvidence("candidate-profile", "candidate-task", [1]);
    const failedCheck = {
      ...acceptedCandidate,
      roleRuns: { ...acceptedCandidate.roleRuns, reviewer: [] },
      task: {
        ...acceptedCandidate.task,
        state: "blocked" as const,
        relation: "blocked" as const,
        check: { sha: "b".repeat(40), status: "failed" as const, exitCode: 1 },
        review: null,
      },
    };
    const report = (baselineEvidence: TaskEvidence, candidateEvidence: TaskEvidence) =>
      compareProfileEvaluation(plan, {
        baseline: [
          {
            id: "baseline",
            pairId: "case",
            repetition: 1,
            taskId: baselineEvidence.taskId,
            evidence: baselineEvidence,
          },
        ],
        candidate: [
          {
            id: "candidate",
            pairId: "case",
            repetition: 1,
            taskId: candidateEvidence.taskId,
            evidence: candidateEvidence,
          },
        ],
      });

    expect(report(acceptedBaseline, failedCheck).recommendation).toBe("baseline");
    expect(
      report(
        {
          ...acceptedBaseline,
          roleRuns: { ...acceptedBaseline.roleRuns, reviewer: [] },
          task: {
            ...acceptedBaseline.task,
            state: "blocked" as const,
            relation: "blocked" as const,
            check: { sha: "b".repeat(40), status: "failed" as const, exitCode: 1 },
            review: null,
          },
        },
        acceptedCandidate,
      ).recommendation,
    ).toBe("candidate");
  });

  test("binds evidence to the expected full profile checksum", () => {
    const plan = {
      schemaVersion: 1 as const,
      id: "checksum-plan",
      repositoryId: "evaluation",
      baseSha: "a".repeat(40),
      subjectRole: "implementer" as const,
      changedFactor: "model_stack" as const,
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      usineBuild: "a".repeat(40),
      reportPath: "report.json",
      registrationPath: "repository.json",
      pairs: [],
    };
    const evidence = evaluationEvidence("baseline-profile", "baseline-task", [1]);
    const report = compareProfileEvaluation(
      plan,
      {
        baseline: [
          {
            id: "baseline",
            pairId: "case",
            repetition: 1,
            taskId: "baseline-task",
            evidence,
          },
        ],
        candidate: [
          {
            id: "candidate",
            pairId: "case",
            repetition: 1,
            taskId: "candidate-task",
            evidence: { ...evidence, taskId: "candidate-task" },
          },
        ],
      },
      {
        baseline: {
          configSha256: "2".repeat(64),
          model: "test-model",
          modelProvider: null,
          reasoningEffort: null,
          developerInstructionsSha256: null,
          adapter: "sdk",
        },
        candidate: {
          configSha256: "1".repeat(64),
          model: "test-model",
          modelProvider: null,
          reasoningEffort: null,
          developerInstructionsSha256: null,
          adapter: "sdk",
        },
        reviewer: {
          configSha256: "1".repeat(64),
          model: "test-model",
          modelProvider: null,
          reasoningEffort: null,
          developerInstructionsSha256: null,
          adapter: "sdk",
        },
      },
    );
    expect(report.recommendation).toBe("inconclusive");
    expect(report.inconclusiveReasons).toContain("baseline-task:implementer_profile_drift");
  });

  test("restores the complete registration when a serial run fails after switching", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    const baselineContractHash = await sha256(await readFile(join(value.root, "baseline.json")));
    const terminalTask = (taskId: string): TaskResource => ({
      schemaVersion: 3,
      taskId,
      contractHash: baselineContractHash,
      revision: 1,
      deadlineEpochMs: Date.now() + 60_000,
      state: "reviewed_pr",
      mergeAuthorized: false,
      candidateSha: "b".repeat(40),
      candidateFence: 1,
      check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
      review: {
        sha: "b".repeat(40),
        verdict: "approved",
        classification: "approved",
        findingCount: 0,
      },
      delivery: null,
      blocker: null,
      waiting: null,
      retryable: false,
      activeActivation: null,
      writer: { repositoryIdentity: "example/evaluation" },
      repository: { id: "evaluation", owner: "example", name: "evaluation", baseBranch: "main" },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 1,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    });
    const evidence = (taskId: string): TaskEvidence => ({
      schemaVersion: 1,
      taskId,
      roleRuns: { implementer: [], reviewer: [] },
      task: {
        state: "reviewed_pr",
        candidateSha: "b".repeat(40),
        candidateFence: 1,
        check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
        review: {
          sha: "b".repeat(40),
          verdict: "approved",
          classification: "approved",
          findingCount: 0,
        },
        repairBatches: 0,
        delivery: null,
        relation: "accepted_exact_sha",
      },
    });
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) =>
        taskId === "baseline-task" ? terminalTask(taskId) : null,
      submitTask: async () => {
        throw new Error("submit failed");
      },
      followTask: async () => terminalTask("baseline-task"),
      retryTask: async () => terminalTask("baseline-task"),
      taskEvidence: async (_url: string, taskId: string) => evidence(taskId),
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "implementer", json: true },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual(["candidate-profile", "prior-profile"]);
    process.exitCode = 0;
  });

  test("submits missing pairs baseline-first and restores after the ordered run", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    const submissions: string[] = [];
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async (_url: string, submission: { contractPath: string }) => {
        submissions.push(
          submission.contractPath.endsWith("baseline.json") ? "baseline" : "candidate",
        );
        return terminalTaskForEvaluation(
          submissions.at(-1) === "baseline" ? "baseline-task" : "candidate-task",
        );
      },
      followTask: async (_url: string, taskId: string) => terminalTaskForEvaluation(taskId),
      retryTask: async (_url: string, taskId: string) => terminalTaskForEvaluation(taskId),
      taskEvidence: async (_url: string, taskId: string) => minimalAcceptedEvidence(taskId),
    };
    const output: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "implementer", json: true },
        "http://server.test",
        value.environment,
        services,
      );
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(submissions).toEqual(["baseline", "candidate"]);
    expect(registrations).toEqual(["baseline-profile", "candidate-profile", "prior-profile"]);
    const report = output.join("");
    expect(JSON.parse(report).recommendation).toBe("inconclusive");
    expect(await readFile(join(value.root, "reports/evaluation-report.json"), "utf8")).toBe(report);
    process.exitCode = 0;
  });

  test("preflights every existing Task before the first registration mutation", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: 1,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) =>
        taskId === "candidate-task" ? terminalTaskForEvaluation(taskId) : null,
      submitTask: async () => terminalTaskForEvaluation("baseline-task"),
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("candidate-task"),
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "implementer", json: true },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual([]);
    process.exitCode = 0;
  });

  test("rejects a later existing waiting Task before any evaluation mutation", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    const candidateHash = await sha256(await readFile(join(value.root, "candidate.json")));
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: 1,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) =>
        taskId === "candidate-task" ? waitingTaskForEvaluation(taskId, candidateHash) : null,
      submitTask: async () => {
        throw new Error("submission must not begin");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async () => minimalAcceptedEvidence("unused-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("existing Task is waiting");
    expect(registrations).toEqual([]);
  });

  test("reuses completed Tasks and reasserts only the prior registration", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    const submissions: string[] = [];
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: 1,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) => {
        const contractPath = taskId === "baseline-task" ? "baseline.json" : "candidate.json";
        const contractHash = await sha256(await readFile(join(value.root, contractPath)));
        return terminalTaskForEvaluation(taskId, contractHash);
      },
      submitTask: async (_url: string, submission: { contractPath: string }) => {
        submissions.push(submission.contractPath);
        return terminalTaskForEvaluation("unused-task");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async (_url: string, taskId: string) => minimalAcceptedEvidence(taskId),
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "implementer", json: true },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual(["prior-profile"]);
    expect(submissions).toEqual([]);
    process.exitCode = 0;
  });

  test("restores after a reused Task evidence failure", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    const submissions: string[] = [];
    let evidenceCalls = 0;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) => {
        const contractPath = taskId === "baseline-task" ? "baseline.json" : "candidate.json";
        const contractHash = await sha256(await readFile(join(value.root, contractPath)));
        return terminalTaskForEvaluation(taskId, contractHash);
      },
      submitTask: async (_url: string, submission: { contractPath: string }) => {
        submissions.push(submission.contractPath);
        return terminalTaskForEvaluation("unused-task");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async (_url: string, taskId: string) => {
        evidenceCalls += 1;
        if (evidenceCalls === 2) throw new Error("reused evidence failed");
        return minimalAcceptedEvidence(taskId);
      },
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("reused evidence failed");
    expect(registrations).toEqual(["prior-profile"]);
    expect(submissions).toEqual([]);
  });

  test("restores after a reused Task follow failure and terminal cleanup", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const baselineHash = await sha256(await readFile(join(value.root, "baseline.json")));
    const candidateHash = await sha256(await readFile(join(value.root, "candidate.json")));
    const registrations: string[] = [];
    const submissions: string[] = [];
    const baselineActive = admittedTaskForEvaluation(
      "baseline-task",
      Date.now() + 60_000,
      baselineHash,
    );
    const baselineTerminal = terminalTaskForEvaluation("baseline-task", baselineHash);
    const candidateTerminal = terminalTaskForEvaluation("candidate-task", candidateHash);
    let baselineStatusCalls = 0;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) => {
        if (taskId === "baseline-task") {
          baselineStatusCalls += 1;
          return baselineStatusCalls === 1 ? baselineActive : baselineTerminal;
        }
        return candidateTerminal;
      },
      submitTask: async (_url: string, submission: { contractPath: string }) => {
        submissions.push(submission.contractPath);
        return terminalTaskForEvaluation("unused-task");
      },
      followTask: async () => {
        throw new Error("reused follow failed");
      },
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async (_url: string, taskId: string) => minimalAcceptedEvidence(taskId),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("reused follow failed");
    expect(registrations).toEqual(["prior-profile"]);
    expect(submissions).toEqual([]);
    expect(baselineStatusCalls).toBe(2);
  });

  test("passes the operator signal through the public profile command and removes listeners", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    let signalSeen: AbortSignal | undefined;
    const services: ProfileEvaluationServices = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async () => ({
        ...terminalTaskForEvaluation("baseline-task"),
        state: "admitted" as const,
      }),
      followTask: async (_url: string, taskId: string, options?: FollowOptions) => {
        signalSeen = options?.signal;
        return new Promise<TaskResource>((complete) => {
          options?.signal?.addEventListener(
            "abort",
            () => complete(terminalTaskForEvaluation(taskId)),
            { once: true },
          );
          process.emit("SIGINT");
        });
      },
      retryTask: async (_url: string, taskId: string) => terminalTaskForEvaluation(taskId),
      taskEvidence: async (_url: string, taskId: string) => minimalAcceptedEvidence(taskId),
    };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    try {
      await Effect.runPromise(
        Command.runWith(profileCommand("http://server.test", value.environment, services), {
          version: "test",
          renderErrors: false,
        })(["evaluate", value.planPath, "--json"]).pipe(Effect.provide(cliTestLayer)),
      );
    } finally {
      stdout.mockRestore();
    }
    expect(signalSeen?.aborted).toBe(true);
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    process.exitCode = 0;
  });

  test("reasserts the prior registration when the profile-switch guard rejects", async () => {
    const value = await fixture();
    const registrations: string[] = [];
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        if (registration.implementerProfile !== "prior-profile")
          throw new Error("cannot switch repository profiles while a Task is active");
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async () => terminalTaskForEvaluation("baseline-task"),
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("cannot switch repository profiles while a Task is active");
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
  });

  test("restores after an ambiguous registration response", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    let registerCalls = 0;
    let submitCalls = 0;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registerCalls += 1;
        registrations.push(registration.implementerProfile);
        if (registerCalls === 1) throw new Error("registration response lost");
        return {
          id: "evaluation",
          revision: registerCalls,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async () => {
        submitCalls += 1;
        throw new Error("submission must not begin");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async () => minimalAcceptedEvidence("unused-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("registration response lost");
    expect(submitCalls).toBe(0);
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
  });

  test("resolves a lost submit response as no admission before restoring", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    let taskStatusCalls = 0;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => {
        taskStatusCalls += 1;
        return null;
      },
      submitTask: async () => {
        throw new Error("submission response lost");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async () => minimalAcceptedEvidence("unused-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("submission response lost");
    expect(taskStatusCalls).toBe(3);
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
  });

  test("refuses restoration when a lost submit response has unsafe Task identity", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    let taskStatusCalls = 0;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => {
        taskStatusCalls += 1;
        return taskStatusCalls <= 2 ? null : terminalTaskForEvaluation("other-task");
      },
      submitTask: async () => {
        throw new Error("submission response lost");
      },
      followTask: async () => terminalTaskForEvaluation("unused-task"),
      retryTask: async () => terminalTaskForEvaluation("unused-task"),
      taskEvidence: async () => minimalAcceptedEvidence("unused-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("admission identity could not be validated");
    expect(registrations).toEqual(["baseline-profile"]);
  });

  test("restores after cancellation at the evidence boundary", async () => {
    const value = await fixture();
    const controller = new AbortController();
    const registrations: string[] = [];
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async () => terminalTaskForEvaluation("baseline-task"),
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => {
        controller.abort();
        return minimalAcceptedEvidence("baseline-task");
      },
    };
    await runProfileEvaluateCommand(
      {
        planPath: value.planPath,
        subjectRole: "implementer",
        json: true,
        signal: controller.signal,
      },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
    process.exitCode = 0;
  });

  test("restores after cancellation while following an admitted Task", async () => {
    const value = await fixture();
    const controller = new AbortController();
    const registrations: string[] = [];
    let followAttempted = false;
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async (_url: string, taskId: string) =>
        followAttempted ? terminalTaskForEvaluation(taskId) : null,
      submitTask: async () => ({
        ...terminalTaskForEvaluation("baseline-task"),
        state: "admitted" as const,
      }),
      followTask: async () => {
        followAttempted = true;
        controller.abort();
        throw new Error("task follow cancelled");
      },
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await runProfileEvaluateCommand(
      {
        planPath: value.planPath,
        subjectRole: "implementer",
        json: true,
        signal: controller.signal,
      },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
    process.exitCode = 0;
  });

  test("accepts a terminal status raced with cleanup follow timeout", async () => {
    const value = await fixture();
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const registrations: string[] = [];
    let statusCalls = 0;
    let followCalls = 0;
    const active = admittedTaskForEvaluation("baseline-task", Date.now() + 60_000);
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      registerRepository: async (_url: string, registration: { implementerProfile: string }) => {
        registrations.push(registration.implementerProfile);
        return {
          id: "evaluation",
          revision: registrations.length,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => {
        statusCalls += 1;
        return statusCalls <= 2
          ? null
          : statusCalls === 3
            ? active
            : terminalTaskForEvaluation("baseline-task");
      },
      submitTask: async () => active,
      followTask: async () => {
        followCalls += 1;
        if (followCalls === 1) return active;
        throw new Error("cleanup follow reached its deadline");
      },
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("Task baseline-task did not reach a durable stopping state");
    expect(followCalls).toBe(2);
    expect(statusCalls).toBe(4);
    expect(registrations).toEqual(["baseline-profile", "prior-profile"]);
  });

  test("waits for an active real Task to release its lease before restoring", async () => {
    const value = await fixture(false, 5_000);
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-profile-evaluation-server-"));
    const serverEnvironment = {
      ...value.environment,
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_EVALUATION_APP_SLUG: "test-app",
      USINE_FORGE_PROFILE_EVALUATION_TEST_TOKEN: "test-token",
      USINE_FORGE_PROFILE_EVALUATION_API_URL: "http://127.0.0.1:9",
      USINE_FORGE_PROFILE_EVALUATION_REPOSITORY: "example/evaluation",
    };
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((complete) => {
      startedResolve = complete;
    });
    let guardRejected = false;
    let launches = 0;
    const server = await startUsineServer({
      environment: serverEnvironment,
      execute: async ({ authority, contract, result }) => {
        launches += 1;
        const reserved = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        startedResolve?.();
        try {
          await registerRuntimeRepository(stateDirectory, {
            ...loaded.registration,
            implementerProfile: "raced-profile",
          });
        } catch (error) {
          guardRejected =
            error instanceof Error &&
            error.message === "cannot switch repository profiles while a Task is active";
        }
        await new Promise<void>((complete) => setTimeout(complete, 25));
        return authority.block(
          { taskId: result.taskId, revision: reserved.result.revision },
          "observation cleanup test",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      await registerRuntimeRepository(stateDirectory, loaded.registration);
      let firstObservation = true;
      const services = {
        inspectRepository: inspectServerRepository,
        registerRepository: registerServerRepository,
        submitTask: submitServerTask,
        taskStatus: readServerTaskStatus,
        followTask: async (url: string, taskId: string, options: FollowOptions = {}) => {
          if (firstObservation) {
            firstObservation = false;
            await started;
            throw new Error("observation failed");
          }
          return followServerTask(url, taskId, options);
        },
        retryTask: retryServerTask,
        taskEvidence: readServerTaskEvidence,
      };
      await expect(
        executeProfileEvaluation(loaded, server.url, undefined, services),
      ).rejects.toThrow("observation failed");
      expect(guardRejected).toBe(true);
      expect(launches).toBe(1);
      await expect(readServerTaskStatus(server.url, "baseline-task")).resolves.toMatchObject({
        state: "blocked",
      });
      await expect(inspectRuntimeRepository(stateDirectory, "evaluation")).resolves.toMatchObject({
        implementerProfile: "prior-profile",
        reviewerProfile: "fixed-reviewer",
      });
    } finally {
      await server.close();
    }
  });

  test("restores after a real admitted Task loses its submit response", async () => {
    const value = await fixture(false, 5_000);
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-profile-evaluation-submit-loss-"));
    const serverEnvironment = {
      ...value.environment,
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_EVALUATION_APP_SLUG: "test-app",
      USINE_FORGE_PROFILE_EVALUATION_TEST_TOKEN: "test-token",
      USINE_FORGE_PROFILE_EVALUATION_API_URL: "http://127.0.0.1:9",
      USINE_FORGE_PROFILE_EVALUATION_REPOSITORY: "example/evaluation",
    };
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((complete) => {
      startedResolve = complete;
    });
    let launches = 0;
    const restoreStates: Array<TaskResource["state"] | "missing"> = [];
    const server = await startUsineServer({
      environment: serverEnvironment,
      execute: async ({ authority, contract, result }) => {
        launches += 1;
        const reserved = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        startedResolve?.();
        await new Promise<void>((complete) => setTimeout(complete, 25));
        return authority.block(
          { taskId: result.taskId, revision: reserved.result.revision },
          "submit response loss test",
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      await registerRuntimeRepository(stateDirectory, loaded.registration);
      const services = {
        inspectRepository: inspectServerRepository,
        registerRepository: async (
          url: string,
          registration: Parameters<typeof registerServerRepository>[1],
        ) => {
          if (registration.implementerProfile === "prior-profile") {
            const current = await readServerTaskStatus(url, "baseline-task");
            restoreStates.push(current?.state ?? "missing");
          }
          return registerServerRepository(url, registration);
        },
        submitTask: async (url: string, submission: Parameters<typeof submitServerTask>[1]) => {
          await submitServerTask(url, submission);
          await started;
          throw new Error("submission response lost");
        },
        taskStatus: readServerTaskStatus,
        followTask: followServerTask,
        retryTask: retryServerTask,
        taskEvidence: readServerTaskEvidence,
      };
      await expect(
        executeProfileEvaluation(loaded, server.url, undefined, services),
      ).rejects.toThrow("submission response lost");
      expect(launches).toBe(1);
      expect(restoreStates).toEqual(["blocked"]);
      await expect(readServerTaskStatus(server.url, "baseline-task")).resolves.toMatchObject({
        state: "blocked",
      });
      await expect(inspectRuntimeRepository(stateDirectory, "evaluation")).resolves.toMatchObject({
        implementerProfile: "prior-profile",
        reviewerProfile: "fixed-reviewer",
      });
    } finally {
      await server.close();
    }
  });

  test("expires a real waiting Task through the existing retry path without relaunching it", async () => {
    const value = await fixture(false, 500);
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-profile-evaluation-waiting-"));
    const serverEnvironment = {
      ...value.environment,
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_EVALUATION_APP_SLUG: "test-app",
      USINE_FORGE_PROFILE_EVALUATION_TEST_TOKEN: "test-token",
      USINE_FORGE_PROFILE_EVALUATION_API_URL: "http://127.0.0.1:9",
      USINE_FORGE_PROFILE_EVALUATION_REPOSITORY: "example/evaluation",
    };
    let launches = 0;
    const server = await startUsineServer({
      environment: serverEnvironment,
      execute: async ({ authority, contract, result }) => {
        launches += 1;
        const reserved = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        return authority.recordWaiting(
          { taskId: result.taskId, revision: reserved.result.revision },
          {
            reason: "network_interruption",
            resumeState: "admitted",
            activation: reserved.activation,
          },
        );
      },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      await registerRuntimeRepository(stateDirectory, loaded.registration);
      const services = {
        inspectRepository: inspectServerRepository,
        registerRepository: registerServerRepository,
        submitTask: submitServerTask,
        taskStatus: readServerTaskStatus,
        followTask: followServerTask,
        retryTask: retryServerTask,
        taskEvidence: readServerTaskEvidence,
      };
      await expect(
        executeProfileEvaluation(loaded, server.url, undefined, services),
      ).rejects.toThrow("waiting for an explicit retry");
      expect(launches).toBe(1);
      await expect(readServerTaskStatus(server.url, "baseline-task")).resolves.toMatchObject({
        state: "blocked",
      });
      await expect(inspectRuntimeRepository(stateDirectory, "evaluation")).resolves.toMatchObject({
        implementerProfile: "prior-profile",
        reviewerProfile: "fixed-reviewer",
      });
    } finally {
      await server.close();
    }
  });

  test("keeps the primary failure observable when restoration also fails", async () => {
    const value = await fixture();
    let registrations = 0;
    const loaded = await readProfileEvaluationPlan(value.planPath, value.environment);
    const services = {
      inspectRepository: async (): Promise<RepositoryResource> => ({
        id: "evaluation",
        revision: 1,
        owner: "example",
        name: "evaluation",
        baseBranch: "main",
      }),
      listTasks: async () => ({ tasks: [] }),
      registerRepository: async () => {
        registrations += 1;
        if (registrations === 2) throw new Error("restore failed");
        return {
          id: "evaluation",
          revision: registrations,
          owner: "example",
          name: "evaluation",
          baseBranch: "main",
        };
      },
      taskStatus: async () => null,
      submitTask: async () => {
        throw new Error("submit failed");
      },
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      retryTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ProfileEvaluationRestorationError && error.cause instanceof AggregateError
      );
    });
    expect(registrations).toBe(2);
  });
});

function terminalTaskForEvaluation(taskId: string, contractHash = "a".repeat(64)): TaskResource {
  return {
    schemaVersion: 3,
    taskId,
    contractHash,
    revision: 1,
    deadlineEpochMs: Date.now() + 60_000,
    state: "reviewed_pr",
    mergeAuthorized: false,
    candidateSha: "b".repeat(40),
    candidateFence: 1,
    check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
    review: {
      sha: "b".repeat(40),
      verdict: "approved",
      classification: "approved",
      findingCount: 0,
    },
    delivery: null,
    blocker: null,
    waiting: null,
    retryable: false,
    activeActivation: null,
    writer: { repositoryIdentity: "example/evaluation" },
    repository: { id: "evaluation", owner: "example", name: "evaluation", baseBranch: "main" },
    evidence: {
      implementerActivations: 1,
      reviewCycles: 1,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
  };
}

function admittedTaskForEvaluation(
  taskId: string,
  deadlineEpochMs: number,
  contractHash = "a".repeat(64),
): TaskResource {
  return {
    ...terminalTaskForEvaluation(taskId, contractHash),
    deadlineEpochMs,
    state: "admitted",
    candidateSha: null,
    candidateFence: null,
    check: null,
    review: null,
    activeActivation: null,
  };
}

function waitingTaskForEvaluation(taskId: string, contractHash = "a".repeat(64)): TaskResource {
  return {
    ...terminalTaskForEvaluation(taskId, contractHash),
    state: "waiting",
    candidateSha: null,
    candidateFence: null,
    check: null,
    review: null,
    waiting: { reason: "network_interruption" },
    retryable: true,
  };
}

function minimalAcceptedEvidence(taskId: string): TaskEvidence {
  return {
    schemaVersion: 1,
    taskId,
    roleRuns: { implementer: [], reviewer: [] },
    task: {
      state: "reviewed_pr",
      candidateSha: "b".repeat(40),
      candidateFence: 1,
      check: { sha: "b".repeat(40), status: "passed", exitCode: 0 },
      review: {
        sha: "b".repeat(40),
        verdict: "approved",
        classification: "approved",
        findingCount: 0,
      },
      repairBatches: 0,
      delivery: null,
      relation: "accepted_exact_sha",
    },
  };
}

async function sha256(value: Uint8Array): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}
