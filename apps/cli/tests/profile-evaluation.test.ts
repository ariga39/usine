import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  compareProfileEvaluation,
  readProfileEvaluationPlan,
  runProfileEvaluateCommand,
} from "../src/profile-evaluation.js";
import type { TaskEvidence } from "../src/task-evidence.js";
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
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "evaluation-plan",
      repositoryId: "evaluation",
      baseSha,
      subjectRole: "implementer",
      profiles: { baseline: "baseline-profile", candidate: "candidate-profile" },
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
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
    await writeFile(join(codexHome, `${profile}.config.toml`), 'model = "test-model"\n');
  }
  return { root, planPath, environment: { CODEX_HOME: codexHome } };
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
      baselineProfile: "baseline-profile",
      candidateProfile: "candidate-profile",
      reviewerProfile: "fixed-reviewer",
      maxTasks: 2,
      pairs: [],
    };
    const run = (profile: string, elapsedMs: number) => ({
      role: "implementer" as const,
      activation: 1,
      reviewCycle: null,
      requestedProfile: profile,
      effectiveProfile: {
        profileName: profile,
        configSha256: null,
        adapter: null,
        model: null,
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
        if (registration.implementerProfile === "candidate-profile")
          throw new Error("switch failed");
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
      submitTask: async () => terminalTask("baseline-task"),
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
    expect(JSON.parse(output.join("")).recommendation).toBe("inconclusive");
    process.exitCode = 0;
  });

  test("refuses the first profile switch when another Task owns the writer lease", async () => {
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
      listTasks: async () => ({
        tasks: [
          {
            taskId: "active-task",
            revision: 1,
            deadlineEpochMs: 1,
            state: "admitted" as const,
            candidateSha: null,
            activeActivation: 1,
            retryable: false,
            writer: { repositoryIdentity: "example/evaluation" },
            evidence: {
              implementerActivations: 1,
              reviewCycles: 0,
              changesRequestedBatches: 0,
              restartRecoveries: 0,
            },
          },
        ],
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
      taskStatus: async () => null,
      submitTask: async () => terminalTaskForEvaluation("baseline-task"),
      followTask: async () => terminalTaskForEvaluation("baseline-task"),
      taskEvidence: async () => minimalAcceptedEvidence("baseline-task"),
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "implementer", json: true },
      "http://server.test",
      value.environment,
      services,
    );
    expect(registrations).toEqual(["prior-profile"]);
    process.exitCode = 0;
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
});

function terminalTaskForEvaluation(taskId: string): TaskResource {
  return {
    schemaVersion: 3,
    taskId,
    contractHash: "a".repeat(64),
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
