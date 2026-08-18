import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  implementerOutputSchema,
  reviewerOutputSchema,
} from "../packages/runtime/src/coding-session.js";
import { approvalAttestationBody } from "../packages/runtime/src/forge-delivery.js";
import { applyTaskFact, canTransition, type TaskResult } from "@usine/task-authority";
import type { TaskContract } from "@usine/task-authority";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { QualityGate } from "../packages/runtime/src/quality-gate.js";
import { ForgeDelivery } from "../packages/runtime/src/forge-delivery.js";
import {
  capabilityEnvironments,
  explicitWorkerEnvironment,
} from "../packages/runtime/src/runtime-policy.js";

const sha = "a".repeat(40);
const contract = { id: "module-test" } as TaskContract;

describe("module contracts", () => {
  test("Task Authority accepts only legal lifecycle transitions", () => {
    expect(canTransition("admitted", "candidate")).toBe(true);
    expect(canTransition("reviewed_pr", "candidate")).toBe(false);
  });

  test("Task Authority applies legal facts and rejects stale fences without persistence", () => {
    const admitted: TaskResult = {
      taskId: "module-test",
      contractHash: "hash",
      revision: 4,
      deadlineEpochMs: 10_000,
      state: "admitted",
      candidateSha: null,
      candidateFence: null,
      check: null,
      review: null,
      delivery: null,
      blocker: null,
      activeActivation: 1,
      writer: { repository: "/repo", repositoryIdentity: "owner/repo", generation: 1 },
      evidence: {
        implementerActivations: 1,
        reviewCycles: 0,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    };
    const candidate = applyTaskFact(admitted, {
      type: "candidate",
      candidate: { sha, baseSha: sha, generation: 1, fence: 1 },
    });
    expect(candidate).toMatchObject({
      state: "candidate",
      candidateSha: sha,
      activeActivation: null,
    });
    expect(() =>
      applyTaskFact(admitted, {
        type: "candidate",
        candidate: { sha, baseSha: sha, generation: 1, fence: 0 },
      }),
    ).toThrow("stale");
  });

  test("Coding Session strips coordinator and delivery credentials", () => {
    const env = explicitWorkerEnvironment({
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      SAFE: "yes",
      SAFE_TOKEN: "yes-too",
    });
    expect(env).toMatchObject({ CI: "true", SAFE: "yes", SAFE_TOKEN: "yes-too" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("Coding Session maps SDK terminal output through the task-oriented port", async () => {
    let requestOptions: Record<string, unknown> | undefined;
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        id: "opaque-thread",
        run: async (_prompt, options) => {
          requestOptions = options;
          return { finalResponse: JSON.stringify({ status: "proposed", summary: "done" }) };
        },
      }),
    }));
    const observation = await session.run<{ status: string; summary: string }>({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "opaque-thread",
      output: { status: "proposed" },
    });
    expect(requestOptions).toMatchObject({
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["proposed", "blocked"] },
          summary: { type: "string" },
        },
        required: ["status", "summary"],
        additionalProperties: false,
      },
    });
    expect(requestOptions).not.toHaveProperty("env");
  });

  test("Coding Session preserves the deadline reserve before starting a provider", async () => {
    let started = false;
    const session = new CodexCodingSession(async () => {
      started = true;
      throw new Error("provider should not start");
    });
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 50,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(started).toBe(false);
    expect(observation).toMatchObject({
      status: "failed",
      failure: "elapsed budget exhausted",
    });
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong status", JSON.stringify({ status: "finished", summary: "done" })],
    ["missing summary", JSON.stringify({ status: "proposed" })],
  ])("Coding Session fails closed on implementer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        run: async () => ({ finalResponse }),
      }),
    }));
    const observation = await session.run({
      role: "implementer",
      workspace: ".",
      contract,
      prompt: "work",
      model: "test-model",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: implementerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output did not match role schema",
    });
  });

  test.each([
    ["malformed JSON", "{malformed"],
    ["wrong verdict", JSON.stringify({ sha, verdict: "wrong", summary: "ok", findings: [] })],
    ["missing summary", JSON.stringify({ sha, verdict: "approved", findings: [] })],
    [
      "non-string finding",
      JSON.stringify({ sha, verdict: "approved", summary: "ok", findings: [7] }),
    ],
  ])("Coding Session fails closed on reviewer output: %s", async (_name, finalResponse) => {
    const session = new CodexCodingSession(async () => ({
      startThread: () => ({
        run: async () => ({ finalResponse }),
      }),
    }));
    const observation = await session.run({
      role: "reviewer",
      workspace: ".",
      contract,
      prompt: "review",
      model: "test-model",
      reasoningEffort: "low",
      sandbox: "read-only",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: reviewerOutputSchema,
      environment: { CI: "true" },
    });
    expect(observation).toMatchObject({
      status: "failed",
      output: null,
      failure: "coding session output did not match role schema",
    });
  });

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
      environment: capabilityEnvironments(process.env),
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

  test("Forge Delivery attestation is bound to exact candidate SHA", () => {
    const body = approvalAttestationBody(
      contract,
      sha,
      { sha, status: "passed", command: "vp test", exitCode: 0, stdout: "", stderr: "" },
      { sha, verdict: "approved", summary: "ok", findings: [] },
    );
    expect(body).toContain(`usine-approval:${contract.id}:${sha}`);
    expect(body).toContain("Fresh reviewer verdict: `approved`");
  });

  test("Forge Delivery fails closed before any effect without exact approval", async () => {
    const forge = new ForgeDelivery({
      repository: "/repo",
      deadlineEpochMs: Date.now() + 10_000,
      forge: {
        mode: "test",
        appSlug: "test-app",
        token: "test-token",
        apiUrl: "http://127.0.0.1:1",
        gitUrl: "http://127.0.0.1:1/owner/repo.git",
      },
      environment: capabilityEnvironments(process.env),
    });
    await expect(
      forge.deliver(
        contract,
        sha,
        { sha, status: "passed", command: "check", exitCode: 0, stdout: "", stderr: "" },
        { sha, verdict: "changes_requested", summary: "fix", findings: ["fix"] },
      ),
    ).rejects.toThrow("exact-SHA semantic approval");
  });
});

test("CLI keeps invalid contract input at the public parse boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid.json");
  await writeFile(path, "{}");
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], { reject: false });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain("invalid_task_contract");
});
