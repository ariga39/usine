import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { reviewerOutputSchema } from "@usine/coding-session";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { QualityGate } from "@usine/quality-gate";
import type { TaskContract } from "@usine/task-authority";

const contract = { id: "quality-test" } as TaskContract;
const testEnvironment = {
  ...credentialFreeGitEnvironment(process.env),
  CI: "true",
};

test("Quality Gate checks a disposable exact-SHA checkout before fresh review", async () => {
  const root = await mkdtemp(join(tmpdir(), "usine-quality-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "ready.txt"), "yes\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const base = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const task = {
    ...contract,
    repository: { path: repository, owner: "owner", name: "repo" },
    baseSha: base,
    instructions: "Review",
    acceptance: ["ready"],
    nonGoals: [],
    projectCheck: { command: "test -f ready.txt", timeoutMs: 10_000 },
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 30_000 },
    authorization: { source: "test", delivery: true },
    delivery: { baseBranch: "main", branch: "agent/test", issue: 1, title: "test", body: "test" },
  } as TaskContract;
  const workspace = new CandidateWorkspace({
    repository,
    stateDirectory: join(root, "state"),
    deadlineEpochMs: Date.now() + 30_000,
    credentialFreeGit: credentialFreeGitEnvironment(process.env),
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  let reviewerSchema: unknown;
  let sessionStatus: "completed" | "failed" = "completed";
  let reviewerSha = base;
  const gate = new QualityGate({
    workspace,
    session: {
      run: async ({ outputSchema }: { outputSchema: unknown }) => {
        reviewerSchema = outputSchema;
        return {
          status: sessionStatus,
          sessionId: "review",
          output: { sha: reviewerSha, verdict: "approved", summary: "ok", findings: [] },
          usage: null,
          summary: "ok",
          failure: sessionStatus === "failed" ? "provider failed" : null,
        };
      },
    } as never,
    reviewer: {
      role: "reviewer",
      model: "reviewer",
      reasoningEffort: "low",
      sandbox: "read-only",
    },
    checkEnvironment: testEnvironment,
    reviewerEnvironment: testEnvironment,
    deadlineEpochMs: Date.now() + 30_000,
  });
  const check = await gate.check(task, base, 1);
  expect(check.status).toBe("passed");
  const boundedCheck = await gate.check(
    {
      ...task,
      projectCheck: {
        command:
          'test -f ready.txt && node -e \'process.stdout.write("stdout-head" + "x".repeat(20000) + "stdout-tail"); process.stderr.write("stderr-head" + "y".repeat(20000) + "stderr-tail")\'',
        timeoutMs: 10_000,
      },
    },
    base,
    1,
  );
  expect(boundedCheck.stdout.length).toBeLessThanOrEqual(16_384);
  expect(boundedCheck.stdout).toContain("[stdout truncated to 16384 characters]");
  expect(boundedCheck.stdout).toContain("stdout-head");
  expect(boundedCheck.stdout).toContain("stdout-tail");
  expect(boundedCheck.stderr.length).toBeLessThanOrEqual(16_384);
  expect(boundedCheck.stderr).toContain("[stderr truncated to 16384 characters]");
  expect(boundedCheck.stderr).toContain("stderr-head");
  expect(boundedCheck.stderr).toContain("stderr-tail");
  const review = await gate.review(task, base, check, 1);
  expect(review.verdict).toBe("approved");
  expect(reviewerSchema).toBe(reviewerOutputSchema);
  reviewerSha = "b".repeat(40);
  const staleReview = await gate.review(task, base, check, 1);
  expect(staleReview).toMatchObject({
    sha: base,
    verdict: "inconclusive",
    summary: "review output was stale",
    findings: [],
  });
  sessionStatus = "failed";
  const failedReview = await gate.review(task, base, check, 1);
  expect(failedReview).toMatchObject({
    sha: base,
    verdict: "inconclusive",
    summary: "provider failed",
    findings: [],
  });
});
