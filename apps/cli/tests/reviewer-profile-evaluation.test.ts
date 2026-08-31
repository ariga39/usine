import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, test } from "vite-plus/test";
import {
  readReviewerEvaluationPlan,
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
  };
}

describe("reviewer profile evaluation public path", () => {
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

  test("runs both profiles serially over identical cases and makes a correctness-first report", async () => {
    const value = await fixture();
    const loaded = await readReviewerEvaluationPlan(value.planPath, value.environment);
    const calls: Array<{
      profile: string;
      caseId: string;
      candidateSha: string;
      checkSha: string;
    }> = [];
    const services: ReviewerEvaluationServices = {
      review: async (input) => {
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
      },
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
});
