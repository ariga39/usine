import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { reviewerOutputSchema } from "@usine/coding-session";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { QualityGate } from "@usine/quality-gate";
import type { ResolvedTaskContract } from "@usine/task-authority";

const contract = { id: "quality-test" } as ResolvedTaskContract;
const testEnvironment = {
  ...credentialFreeGitEnvironment(process.env),
  CI: "true",
  USINE_CHECK_POLICY: "credential-free",
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
    repositoryId: "repo",
    repository: { path: repository, owner: "owner", name: "repo" },
    baseSha: base,
    instructions: "Review",
    acceptance: ["ready"],
    nonGoals: [],
    projectCheck: {
      command: 'test -f ready.txt && test "$USINE_CHECK_POLICY" = credential-free',
      timeoutMs: 10_000,
    },
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 30_000 },
    authorization: { source: "test", delivery: true },
    delivery: { baseBranch: "main", branch: "agent/test", issue: 1, title: "test", body: "test" },
  } as ResolvedTaskContract;
  const workspace = new CandidateWorkspace({
    repository,
    stateDirectory: join(root, "state"),
    deadlineEpochMs: Date.now() + 30_000,
    credentialFreeGit: credentialFreeGitEnvironment(process.env),
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  let reviewerSchema: unknown;
  let reviewerEnvironment: NodeJS.ProcessEnv | undefined;
  let sessionStatus: "completed" | "failed" = "completed";
  let reviewerSha = base;
  const gate = new QualityGate({
    workspace,
    session: {
      run: async ({
        outputSchema,
        environment,
      }: {
        outputSchema: unknown;
        environment?: NodeJS.ProcessEnv;
      }) => {
        reviewerSchema = outputSchema;
        reviewerEnvironment = environment;
        return {
          status: sessionStatus,
          sessionId: "review",
          output: { sha: reviewerSha, verdict: "approved", summary: "ok", findings: [] },
          usage: null,
          summary: "ok",
          failure: sessionStatus === "failed" ? "provider failed" : null,
        };
      },
    },
    reviewer: {
      role: "reviewer",
      profile: "reviewer-profile",
      sandbox: "read-only",
    },
    environment: testEnvironment,
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
  expect(reviewerEnvironment).toEqual(testEnvironment);
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

test("cancels a running project check subprocess without recording a check fact", async () => {
  const controller = new AbortController();
  const gate = new QualityGate({
    workspace: {
      withCheckout: async (_purpose, _sha, callback) => callback(tmpdir()),
    },
    session: {
      run: async () => {
        throw new Error("reviewer should not start");
      },
    },
    reviewer: {
      role: "reviewer",
      profile: "reviewer-profile",
      sandbox: "read-only",
    },
    environment: testEnvironment,
    deadlineEpochMs: Date.now() + 30_000,
    signal: controller.signal,
  });
  const task = {
    ...contract,
    projectCheck: {
      command: "sleep 10",
      timeoutMs: 20_000,
    },
  } as ResolvedTaskContract;
  const pending = gate.check(task, "a".repeat(40), 1);
  setTimeout(() => controller.abort(), 25);
  await expect(pending).rejects.toThrow();
});
