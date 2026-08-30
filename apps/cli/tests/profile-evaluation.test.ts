import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  readProfileEvaluationPlan,
  runProfileEvaluateCommand,
} from "../src/profile-evaluation.js";

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
  await writeFile(join(root, "baseline.json"), JSON.stringify(contract("baseline-task", 278, "agent/baseline" , "same outcome")));
  await writeFile(join(root, "candidate.json"), JSON.stringify(contract("candidate-task", 279, "agent/candidate", pairDrift ? "different outcome" : "same outcome")));
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
});
