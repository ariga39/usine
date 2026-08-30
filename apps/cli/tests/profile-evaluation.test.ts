import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  compareProfileEvaluation,
  executeProfileEvaluation,
  readProfileEvaluationPlan,
  runProfileEvaluateCommand,
  ProfileEvaluationRestorationError,
} from "../src/profile-evaluation.js";
import type { RoleRunEvidence, TaskEvidence } from "../src/task-evidence.js";
import type { RepositoryResource, TaskResource } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function fixture(pairDrift = false) {
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
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
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

  test("reuses completed Tasks without changing the registration", async () => {
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
      taskEvidence: async (_url: string, taskId: string) => minimalAcceptedEvidence(taskId),
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "implementer", json: true },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual([]);
    expect(submissions).toEqual([]);
    process.exitCode = 0;
  });

  test("does not restore when the atomic profile-switch guard rejects", async () => {
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
        throw new Error("cannot switch repository profiles while a Task is active");
      },
      taskStatus: async () => null,
      submitTask: async () => terminalTaskForEvaluation("baseline-task"),
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await expect(
      executeProfileEvaluation(loaded, "http://server.test", undefined, services),
    ).rejects.toThrow("cannot switch repository profiles while a Task is active");
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
      submitTask: async () => ({
        ...terminalTaskForEvaluation("baseline-task"),
        state: "admitted" as const,
      }),
      followTask: async () => {
        controller.abort();
        throw new Error("task follow cancelled");
      },
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
