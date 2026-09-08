import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  readReviewerEvaluationPlan,
  type ReviewerEvaluationArchiveManifest,
  type ReviewerEvaluationReviewInput,
  type ReviewerEvaluationServices,
} from "../src/reviewer-profile-evaluation.js";
import { runProfileEvaluateCommand } from "../src/profile-evaluation.js";
import type { ReviewAttemptObservation } from "@usine/runtime";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd })).stdout.trim();
}

const execFile = promisify(execFileCallback);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usine-reviewer-profile-evaluation-"));
  await execFile("git", ["init", "--initial-branch=main"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "reviewer evaluation\n");
  await execFile("git", ["add", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  const baseSha = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "candidate.txt"), "frozen candidate\n");
  await execFile("git", ["add", "candidate.txt"], { cwd: root });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: root });
  const candidateSha = await git(root, "rev-parse", "HEAD");
  const contract = (id: string, issue: number) => ({
    id,
    repositoryId: "evaluation",
    baseSha,
    instructions: "Review the frozen candidate.",
    acceptance: ["The candidate is reviewed against the task contract."],
    nonGoals: ["No delivery or merge is authorized."],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: `https://github.com/example/evaluation/issues/${issue}`,
      delivery: true,
    },
    delivery: { branch: `agent/review-${id}`, issue, title: "Review", body: "Review" },
  });
  await writeFile(join(root, "case-approved.json"), JSON.stringify(contract("approved", 286)));
  await writeFile(join(root, "case-defective.json"), JSON.stringify(contract("defective", 287)));
  const check = {
    sha: candidateSha,
    status: "passed",
    command: "true",
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  await writeFile(join(root, "check.json"), JSON.stringify(check));
  await writeFile(
    join(root, "label-approved.json"),
    JSON.stringify({
      verdict: "approved",
      rationale: "The candidate satisfies the contract.",
      reference: "external-case-approved",
    }),
  );
  await writeFile(
    join(root, "label-defective.json"),
    JSON.stringify({
      verdict: "changes_requested",
      rationale: "The candidate contains the labelled defect.",
      reference: "external-case-defective",
      protected: true,
    }),
  );
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  await writeFile(join(codexHome, "baseline-reviewer.config.toml"), 'model = "baseline-model"\n');
  await writeFile(join(codexHome, "candidate-reviewer.config.toml"), 'model = "candidate-model"\n');
  const usineBuild = await git(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    "rev-parse",
    "HEAD",
  );
  await writeFile(
    join(root, "repository.json"),
    JSON.stringify({
      id: "evaluation",
      path: root,
      owner: "example",
      name: "evaluation",
      baseBranch: "main",
      implementerProfile: "unused-implementer",
      reviewerProfile: "unused-reviewer",
      forgeProfile: "evaluation",
      githubReadProfile: null,
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    }),
  );
  await writeFile(join(root, ".gitignore"), "repository.json\n");
  const planPath = join(root, "reviewer-evaluation-plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "reviewer-evaluation",
      repositoryId: "evaluation",
      baseSha,
      subjectRole: "reviewer",
      changedFactor: "model_stack",
      baselineProfile: "baseline-reviewer",
      candidateProfile: "candidate-reviewer",
      maxRuns: 4,
      usineBuild,
      reportPath: "reports/reviewer-report.json",
      registrationPath: "repository.json",
      cases: [
        {
          id: "approved",
          repetition: 1,
          contractPath: "case-approved.json",
          candidateSha,
          checkPath: "check.json",
          labelPath: "label-approved.json",
        },
        {
          id: "defective",
          repetition: 1,
          contractPath: "case-defective.json",
          candidateSha,
          checkPath: "check.json",
          labelPath: "label-defective.json",
        },
      ],
    }),
  );
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "authorize reviewer evaluation"], { cwd: root });
  return { root, planPath, environment: { CODEX_HOME: codexHome } };
}

function observation(
  input: ReviewerEvaluationReviewInput,
  verdict: "approved" | "changes_requested",
  configSha256: string,
): ReviewAttemptObservation {
  return {
    review: {
      sha: input.candidateSha,
      verdict,
      summary: "bounded result",
      findings: verdict === "approved" ? [] : ["defect"],
    },
    usage: { inputTokens: 3, outputTokens: 2 },
    requestedProfile: input.profile,
    effectiveProfile: {
      profileName: input.profile,
      configSha256,
      adapter: "sdk",
      model: input.profile === "baseline-reviewer" ? "baseline-model" : "candidate-model",
      modelProvider: null,
      reasoningEffort: null,
      developerInstructionsSha256: null,
    },
    archive: {
      archiveId: "archive_00000000-0000-0000-0000-000000000001",
      status: "stored",
      completeness: "complete",
    },
  };
}

function currentArchiveManifest(
  taskId: string,
  patch: Partial<ReviewerEvaluationArchiveManifest> = {},
): ReviewerEvaluationArchiveManifest {
  return {
    archiveId: "archive_00000000-0000-0000-0000-000000000001",
    taskId,
    role: "reviewer",
    captureStatus: "stored",
    completeness: "complete",
    ...patch,
  };
}

async function writeAssessorArchive(stateDirectory: string, taskId: string): Promise<string> {
  const archiveId = "archive_00000000-0000-0000-0000-000000000002";
  const directory = join(stateDirectory, "session-archives");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const profileFields = { name: "assessor-profile" };
  const profile = {
    ...profileFields,
    sha256: createHash("sha256").update(JSON.stringify(profileFields), "utf8").digest("hex"),
  };
  const archive = {
    schemaVersion: 1 as const,
    archiveId,
    taskId,
    role: "assessor" as const,
    attempt: "1",
    createdAtEpochMs: 1,
    updatedAtEpochMs: 2,
    status: "completed" as const,
    captureStatus: "stored" as const,
    completeness: "complete" as const,
    sessionId: "assessor-session",
    adapter: "sdk" as const,
    phase: "output" as const,
    failureClass: null,
    failure: null,
    prompt: "assessor archive must not become reviewer evidence",
    contract: { id: taskId },
    profile,
    items: [],
    rawFinalResponse: "assessor response",
    normalizedOutput: { verdict: "approved" },
    usage: { inputTokens: 1, outputTokens: 1 },
    byteLength: 0,
    truncated: false,
    warnings: [],
  };
  for (;;) {
    const bytes = JSON.stringify(archive);
    const byteLength = Buffer.byteLength(bytes);
    if (archive.byteLength === byteLength) {
      await writeFile(join(directory, `${archiveId}.json`), bytes, {
        encoding: "utf8",
        mode: 0o600,
      });
      return archiveId;
    }
    archive.byteLength = byteLength;
  }
}

type ReviewerArchiveProjectionReport = {
  inconclusiveReasons: string[];
  baseline: { runs: Array<{ archive: unknown }> };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReviewerArchiveProjectionReport(
  value: unknown,
): value is ReviewerArchiveProjectionReport {
  if (!isRecord(value) || !Array.isArray(value.inconclusiveReasons)) return false;
  if (!value.inconclusiveReasons.every((reason) => typeof reason === "string")) return false;
  if (!isRecord(value.baseline) || !Array.isArray(value.baseline.runs)) return false;
  return value.baseline.runs.every((run) => isRecord(run) && "archive" in run);
}

function withCurrentArchive(
  review: ReviewerEvaluationServices["review"],
  patch: Partial<ReviewerEvaluationArchiveManifest> = {},
): ReviewerEvaluationServices {
  return {
    review,
    readArchiveManifest: async (archiveId, _environment, expectedTaskId) =>
      currentArchiveManifest(expectedTaskId, { archiveId, ...patch }),
  };
}

describe("reviewer profile evaluation public path", () => {
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
    await execFile("git", ["add", "reviewer-evaluation-plan.json"], { cwd: value.root });
    await execFile("git", ["commit", "-m", "invalid reviewer evaluation plan structure"], {
      cwd: value.root,
    });

    let providerCalls = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
      expect(providerCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      expect(stderr).toHaveBeenCalledWith(
        '{"error":"invalid_reviewer_evaluation_plan","kind":"validation","message":"evaluation plan has missing or invalid fields"}\n',
      );
      await expect(readFile(join(value.root, "reports/reviewer-report.json"))).rejects.toThrow();
    } finally {
      stderr.mockRestore();
      process.exitCode = 0;
    }
  }

  async function expectMalformedEvidence(
    value: Awaited<ReturnType<typeof fixture>>,
    path: "check.json" | "label-approved.json",
    mutate: (input: Record<string, unknown>) => unknown,
    message: string,
  ): Promise<void> {
    const evidencePath = join(value.root, path);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
    const malformed = mutate(evidence);
    await writeFile(
      evidencePath,
      typeof malformed === "string" ? malformed : JSON.stringify(malformed),
    );
    await execFile("git", ["add", path], { cwd: value.root });
    await execFile("git", ["commit", "-m", "invalid reviewer evaluation evidence structure"], {
      cwd: value.root,
    });

    let providerCalls = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = 0;
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
      expect(providerCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      expect(stderr).toHaveBeenCalledWith(
        `{"error":"invalid_reviewer_evaluation_plan","kind":"validation","message":"${message}"}\n`,
      );
      await expect(readFile(join(value.root, "reports/reviewer-report.json"))).rejects.toThrow();
    } finally {
      stderr.mockRestore();
      process.exitCode = 0;
    }
  }

  test("rejects a non-object plan before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), () => "[]");
  });

  test("rejects a plan with a missing field before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), (plan) => {
      delete plan.changedFactor;
      return plan;
    });
  });

  test("rejects a plan with a mistyped field before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), (plan) => {
      plan.maxRuns = "4";
      return plan;
    });
  });

  test("rejects an invalid nested case before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), (plan) => {
      plan.cases = [null];
      return plan;
    });
  });

  test("rejects an excess plan field before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), (plan) => {
      plan.unexpected = true;
      return plan;
    });
  });

  test("rejects an excess case field before provider effects or report writes", async () => {
    await expectMalformedPlan(await fixture(), (plan) => {
      plan.cases = [
        {
          id: "case-one",
          repetition: 1,
          contractPath: "case-approved.json",
          candidateSha: "a".repeat(40),
          checkPath: "check.json",
          labelPath: "label-approved.json",
          unexpected: true,
        },
      ];
      return plan;
    });
  });

  test("rejects non-object, missing, mistyped, and excess check evidence before provider effects", async () => {
    const cases: Array<(input: Record<string, unknown>) => unknown> = [
      () => "[]",
      (input) => {
        delete input.sha;
        return input;
      },
      (input) => {
        input.exitCode = "0";
        return input;
      },
      (input) => {
        input.unexpected = true;
        return input;
      },
    ];
    for (const mutate of cases)
      await expectMalformedEvidence(
        await fixture(),
        "check.json",
        mutate,
        "check evidence is invalid",
      );
  });

  test("rejects non-object, missing, mistyped, and excess external labels before provider effects", async () => {
    const cases: Array<(input: Record<string, unknown>) => unknown> = [
      () => "[]",
      (input) => {
        delete input.rationale;
        return input;
      },
      (input) => {
        input.protected = "true";
        return input;
      },
      (input) => {
        input.unexpected = true;
        return input;
      },
    ];
    for (const mutate of cases)
      await expectMalformedEvidence(
        await fixture(),
        "label-approved.json",
        mutate,
        "external label is invalid",
      );
  });

  test("rejects an external label with an invalid verdict before provider effects or report writes", async () => {
    await expectMalformedEvidence(
      await fixture(),
      "label-approved.json",
      (input) => {
        input.verdict = "invalid";
        return input;
      },
      "external label is invalid",
    );
  });

  test("preserves exact external-label semantic diagnostics after structural decoding", async () => {
    for (const field of ["rationale", "reference"] as const)
      await expectMalformedEvidence(
        await fixture(),
        "label-approved.json",
        (input) => {
          input[field] = "  ";
          return input;
        },
        "external label rationale and reference are required",
      );
  });

  test("accepts an ignored uncommitted regular registration before provider execution", async () => {
    const value = await fixture();
    expect(await git(value.root, "check-ignore", "repository.json")).toBe("repository.json");
    await expect(
      git(value.root, "ls-files", "--error-unmatch", "repository.json"),
    ).rejects.toThrow();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    let providerCalls = 0;
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      {
        review: async (input) => {
          providerCalls += 1;
          expect(input.repository.path).toBe(value.root);
          return observation(input, "approved", loaded.profileSelections.baseline.configSha256!);
        },
      },
    );
    expect(providerCalls).toBe(4);
    const report = await readFile(join(value.root, "reports/reviewer-report.json"), "utf8");
    expect(report).not.toContain(value.root);
    for (const field of [
      '"path"',
      '"owner"',
      '"projectCheck"',
      '"gitAuthor"',
      '"implementerProfile"',
      '"reviewerProfile"',
      '"forgeProfile"',
      '"githubReadProfile"',
    ])
      expect(report).not.toContain(field);
    process.exitCode = 0;
  });

  test("rejects a reviewer profile pair with more than its declared changed factor before provider execution", async () => {
    const value = await fixture();
    await writeFile(
      join(value.root, "codex/baseline-reviewer.config.toml"),
      'model = "baseline-model"\nmodel_reasoning_effort = "low"\n',
    );
    await writeFile(
      join(value.root, "codex/candidate-reviewer.config.toml"),
      'model = "candidate-model"\nmodel_reasoning_effort = "high"\n',
    );
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as Record<string, unknown>;
    plan.changedFactor = "reasoning";
    await writeFile(value.planPath, JSON.stringify(plan));
    await execFile("git", ["add", "reviewer-evaluation-plan.json"], { cwd: value.root });
    await execFile("git", ["commit", "-m", "invalid multi-factor reviewer evaluation shape"], {
      cwd: value.root,
    });

    await expect(readReviewerEvaluationPlan(value.planPath, value.environment)).rejects.toThrow(
      "profiles differ outside changedFactor reasoning: model",
    );

    let providerCalls = 0;
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      {
        review: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("holds the reviewer adapter fixed before the evaluation can contact the provider", async () => {
    const value = await fixture();
    await expect(
      readReviewerEvaluationPlan(value.planPath, {
        ...value.environment,
        USINE_CODEX_APP_SERVER_PROFILES: "candidate-reviewer",
      }),
    ).rejects.toThrow("profiles differ outside changedFactor model_stack: adapter");
  });

  test("rejects a symlinked or non-regular registration before provider execution", async () => {
    for (const kind of ["symlink", "directory"] as const) {
      const value = await fixture();
      const registrationPath = join(value.root, "repository.json");
      if (kind === "symlink") {
        const outside = join(value.root, "external-repository.json");
        await writeFile(outside, await readFile(registrationPath));
        await unlink(registrationPath);
        await symlink(outside, registrationPath);
      } else {
        await unlink(registrationPath);
        await mkdir(registrationPath);
      }
      let providerCalls = 0;
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
      expect(providerCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      process.exitCode = 0;
    }
  });

  test("rejects a report hardlink collision with the host-private registration", async () => {
    const value = await fixture();
    await mkdir(join(value.root, "reports"), { recursive: true });
    await link(
      join(value.root, "repository.json"),
      join(value.root, "reports/reviewer-report.json"),
    );
    let providerCalls = 0;
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      {
        review: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("validates immutable case evidence before provider execution", async () => {
    const value = await fixture();
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as {
      cases: Array<{ checkPath: string }>;
    };
    plan.cases[0]!.checkPath = "missing-check.json";
    await writeFile(value.planPath, JSON.stringify(plan));
    await execFile("git", ["add", value.planPath], { cwd: value.root });
    await execFile("git", ["commit", "-m", "invalid check evidence"], { cwd: value.root });
    let providerCalls = 0;
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
    } finally {
      process.stderr.write = stderr;
    }
    expect(providerCalls).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("rejects report path collisions before provider execution", async () => {
    const value = await fixture();
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as {
      reportPath: string;
    };
    plan.reportPath = "check.json";
    await writeFile(value.planPath, JSON.stringify(plan));
    await execFile("git", ["add", value.planPath], { cwd: value.root });
    await execFile("git", ["commit", "-m", "invalid report collision"], { cwd: value.root });
    let providerCalls = 0;
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      {
        review: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("rejects symlink, non-regular, and mutable case inputs before provider execution", async () => {
    const changes: Array<(value: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = [
      async (value) => {
        const target = join(value.root, "external-check.json");
        await writeFile(target, await readFile(join(value.root, "check.json")));
        await unlink(join(value.root, "check.json"));
        await symlink(target, join(value.root, "check.json"));
        await execFile("git", ["add", "-A"], { cwd: value.root });
        await execFile("git", ["commit", "-m", "invalid input path"], { cwd: value.root });
      },
      async (value) => {
        await unlink(join(value.root, "check.json"));
        await mkdir(join(value.root, "check.json"));
        await execFile("git", ["add", "-A"], { cwd: value.root });
        await execFile("git", ["commit", "-m", "invalid input path"], { cwd: value.root });
      },
      async (value) => {
        await writeFile(join(value.root, "check.json"), "{}\n");
      },
    ];
    for (const change of changes) {
      const value = await fixture();
      await change(value);
      let providerCalls = 0;
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
      expect(providerCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      process.exitCode = 0;
    }
  });

  test("rejects a symlinked report path or ancestor before provider execution and write", async () => {
    for (const kind of ["ancestor", "report", "hardlink"] as const) {
      const value = await fixture();
      const outside = join(value.root, "..", `reviewer-report-${kind}`);
      await mkdir(outside, { recursive: true });
      if (kind === "ancestor") {
        await symlink(outside, join(value.root, "reports"));
      } else if (kind === "report") {
        await mkdir(join(value.root, "reports"), { recursive: true });
        await symlink(
          join(outside, "report.json"),
          join(value.root, "reports/reviewer-report.json"),
        );
      } else {
        await mkdir(join(value.root, "reports"), { recursive: true });
        await link(value.planPath, join(value.root, "reports/reviewer-report.json"));
      }
      let providerCalls = 0;
      await runProfileEvaluateCommand(
        { planPath: value.planPath, subjectRole: "reviewer", json: true },
        "http://server.test",
        value.environment,
        undefined,
        {
          review: async () => {
            providerCalls += 1;
            throw new Error("must not run");
          },
        },
      );
      expect(providerCalls).toBe(0);
      expect(process.exitCode).toBe(7);
      process.exitCode = 0;
    }
  });

  test("does not follow a report symlink swapped in after provider execution", async () => {
    const value = await fixture();
    const outside = join(value.root, "..", "reviewer-report-swapped");
    await mkdir(outside, { recursive: true });
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    let providerCalls = 0;
    const services: ReviewerEvaluationServices = {
      review: async (input) => {
        providerCalls += 1;
        await mkdir(join(value.root, "reports"), { recursive: true });
        await symlink(
          join(outside, "report.json"),
          join(value.root, "reports/reviewer-report.json"),
        );
        return observation(input, "approved", loaded.profileSelections.baseline.configSha256!);
      },
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    expect(providerCalls).toBe(4);
    await expect(readFile(join(outside, "report.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("resolves a nested plan registration path inside the evaluation Repository", async () => {
    const value = await fixture();
    const plan = JSON.parse(await readFile(value.planPath, "utf8")) as {
      registrationPath: string;
    };
    const nestedDirectory = join(value.root, "evaluations/reviewer");
    const nestedPlanPath = join(nestedDirectory, "plan.json");
    plan.registrationPath = "../../repository.json";
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(nestedPlanPath, JSON.stringify(plan));
    await unlink(value.planPath);
    await execFile("git", ["add", "-A"], { cwd: value.root });
    await execFile("git", ["commit", "-m", "move evaluation plan"], { cwd: value.root });
    const loaded = await readReviewerEvaluationPlan(nestedPlanPath, value.environment);
    expect(loaded.registration.path).toBe(value.root);
    process.exitCode = 0;
  });

  test("rejects inconsistent passing check evidence before provider execution", async () => {
    for (const change of [{ exitCode: 1 }, { command: "unrelated-check" }]) {
      const value = await fixture();
      await expectMalformedEvidence(
        value,
        "check.json",
        (input) => {
          Object.assign(input, change);
          return input;
        },
        "check evidence identity, status, exit code, or project command is invalid",
      );
    }
  });

  test("runs both profiles serially over identical cases and makes a correctness-first report", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const calls: Array<{
      profile: string;
      caseId: string;
      candidateSha: string;
      checkSha: string;
    }> = [];
    const services = withCurrentArchive(async (input) => {
      calls.push({
        profile: input.profile,
        caseId: input.contract.id,
        candidateSha: input.candidateSha,
        checkSha: input.check.sha,
      });
      const verdict =
        input.profile === "candidate-reviewer" && input.contract.id === "defective"
          ? "approved"
          : input.contract.id === "defective"
            ? "changes_requested"
            : "approved";
      const selection =
        input.profile === "baseline-reviewer"
          ? loaded.profileSelections.baseline
          : loaded.profileSelections.candidate;
      return observation(input, verdict, selection.configSha256!);
    });
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as {
      recommendation: string;
      baseline: {
        correctness: string;
        metrics: { correctVerdicts: number; falseApprovals: number };
      };
      candidate: {
        correctness: string;
        metrics: { correctVerdicts: number; falseApprovals: number };
        runs: Array<{
          hardRegression: boolean;
          expected: { rationale: string; reference: string };
        }>;
      };
    };
    expect(calls.map(({ profile, caseId }) => `${profile}:${caseId}`)).toEqual([
      "baseline-reviewer:approved",
      "candidate-reviewer:approved",
      "baseline-reviewer:defective",
      "candidate-reviewer:defective",
    ]);
    expect(new Set(calls.map((call) => `${call.candidateSha}:${call.checkSha}`)).size).toBe(1);
    expect(report.recommendation).toBe("baseline");
    expect(report.baseline.correctness).toBe("passed");
    expect(report.baseline.metrics.correctVerdicts).toBe(2);
    expect(report.candidate.correctness).toBe("failed");
    expect(report.candidate.metrics.falseApprovals).toBe(1);
    expect(report.candidate.runs[1]!.hardRegression).toBe(true);
    expect(report.candidate.runs[1]!.expected.reference).toBe("external-case-defective");
    process.exitCode = 0;
  });

  test("retains bounded dotted model and provider identities", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const services = withCurrentArchive(async (input) => {
      const result = observation(
        input,
        "approved",
        loaded.profileSelections.baseline.configSha256!,
      );
      return {
        ...result,
        effectiveProfile: {
          ...result.effectiveProfile!,
          model: "vendor.model",
          modelProvider: "vendor.provider",
        },
      };
    });
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as {
      baseline: {
        runs: Array<{
          effectiveProfile: { model: string | null; modelProvider: string | null } | null;
        }>;
      };
    };
    expect(report.baseline.runs[0]!.effectiveProfile).toMatchObject({
      model: "vendor.model",
      modelProvider: "vendor.provider",
    });
    process.exitCode = 0;
  });

  test("rejects a plan reached through a symlinked evaluation Repository root", async () => {
    const value = await fixture();
    const linkedRoot = join(value.root, "evaluation-root-link");
    await symlink(value.root, linkedRoot);
    let providerCalls = 0;
    await runProfileEvaluateCommand(
      {
        planPath: join(linkedRoot, "reviewer-evaluation-plan.json"),
        subjectRole: "reviewer",
        json: true,
      },
      "http://server.test",
      value.environment,
      undefined,
      {
        review: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(process.exitCode).toBe(7);
    process.exitCode = 0;
  });

  test("makes missing, drifted, and incomplete role evidence inconclusive", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const services = withCurrentArchive(
      async (input) => {
        const result = observation(
          input,
          "approved",
          loaded.profileSelections.baseline.configSha256!,
        );
        if (input.profile === "baseline-reviewer")
          return { ...result, effectiveProfile: undefined, archive: undefined };
        return {
          ...result,
          effectiveProfile: { ...result.effectiveProfile!, configSha256: "9".repeat(64) },
          archive: {
            archiveId: "archive_00000000-0000-0000-0000-000000000002",
            status: "truncated",
            completeness: "complete",
          },
        };
      },
      { captureStatus: "truncated" },
    );
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as {
      recommendation: string;
      inconclusiveReasons: string[];
      baseline: { runs: Array<{ observed: { verdict: string } }> };
    };
    expect(report.recommendation).toBe("inconclusive");
    expect(report.inconclusiveReasons).toEqual(
      expect.arrayContaining([
        "approved:reviewer_profile_missing",
        "approved:reviewer_archive_missing",
        "approved:reviewer_profile_drift",
        "approved:reviewer_archive_partial",
      ]),
    );
    expect(report.baseline.runs[0]!.observed.verdict).toBe("approved");
    process.exitCode = 0;
  });

  test("makes missing comparison metrics inconclusive with a reason", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const services = withCurrentArchive(async (input) => {
      const selection =
        input.profile === "baseline-reviewer"
          ? loaded.profileSelections.baseline
          : loaded.profileSelections.candidate;
      const verdict = input.contract.id === "defective" ? "changes_requested" : "approved";
      return { ...observation(input, verdict, selection.configSha256!), usage: null };
    });
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as {
      recommendation: string;
      inconclusiveReasons: string[];
      comparison: { baseline: { inputTokens: number | null } };
    };
    expect(report.recommendation).toBe("inconclusive");
    expect(report.inconclusiveReasons).toContain("comparison:missing_metrics");
    expect(report.comparison.baseline.inputTokens).toBeNull();
    process.exitCode = 0;
  });

  test("replaces stale archive observations after all runs and preserves protected false approvals", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const services = withCurrentArchive(
      async (input) => {
        const selection =
          input.profile === "baseline-reviewer"
            ? loaded.profileSelections.baseline
            : loaded.profileSelections.candidate;
        const verdict =
          input.contract.id === "defective" && input.profile === "candidate-reviewer"
            ? "approved"
            : input.contract.id === "defective"
              ? "changes_requested"
              : "approved";
        return observation(input, verdict, selection.configSha256!);
      },
      { captureStatus: "pruned", completeness: "partial" },
    );
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as {
      recommendation: string;
      inconclusiveReasons: string[];
      candidate: {
        runs: Array<{
          archive: { archiveId: string; status: string; completeness: string } | null;
          hardRegression: boolean;
          correctness: string;
        }>;
      };
    };
    expect(report.recommendation).toBe("inconclusive");
    expect(report.inconclusiveReasons).toContain("defective:reviewer_archive_failed");
    expect(report.candidate.runs[1]!.archive).toEqual({
      archiveId: "archive_00000000-0000-0000-0000-000000000001",
      status: "pruned",
      completeness: "partial",
    });
    expect(report.candidate.runs[1]!.correctness).toBe("inconclusive");
    expect(report.candidate.runs[1]!.hardRegression).toBe(true);
    process.exitCode = 0;
  });

  test("treats a missing current archive manifest as inconclusive", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const services = {
      ...withCurrentArchive(async (input) =>
        observation(input, "approved", loaded.profileSelections.baseline.configSha256!),
      ),
      readArchiveManifest: async () => null,
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      value.environment,
      undefined,
      services,
    );
    const report = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    ) as { recommendation: string; inconclusiveReasons: string[] };
    expect(report.recommendation).toBe("inconclusive");
    expect(report.inconclusiveReasons).toContain("approved:reviewer_archive_missing");
    process.exitCode = 0;
  });

  test("does not treat an assessor archive as reviewer evidence", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const stateDirectory = join(value.root, "assessor-state");
    const archiveId = await writeAssessorArchive(stateDirectory, "approved");
    const services: ReviewerEvaluationServices = {
      review: async (input) => {
        const selection =
          input.profile === "baseline-reviewer"
            ? loaded.profileSelections.baseline
            : loaded.profileSelections.candidate;
        return {
          ...observation(input, "approved", selection.configSha256!),
          archive: {
            archiveId,
            status: "stored",
            completeness: "complete",
          },
        };
      },
    };
    await runProfileEvaluateCommand(
      { planPath: value.planPath, subjectRole: "reviewer", json: true },
      "http://server.test",
      { ...value.environment, USINE_STATE_DIR: stateDirectory },
      undefined,
      services,
    );
    const report: unknown = JSON.parse(
      await readFile(join(value.root, "reports/reviewer-report.json"), "utf8"),
    );
    if (!isReviewerArchiveProjectionReport(report)) throw new Error("invalid reviewer report");
    expect(report.inconclusiveReasons).toContain("approved:reviewer_archive_missing");
    expect(report.baseline.runs[0]?.archive).toBeNull();
    process.exitCode = 0;
  });
});
