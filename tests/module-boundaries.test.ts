import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { CodexCodingSession, workerEnvironment } from "../packages/runtime/src/coding-session.js";
import { approvalAttestationBody } from "../packages/runtime/src/forge-delivery.js";
import { parseReviewObservation } from "../packages/runtime/src/quality-gate.js";
import {
  applyTaskFact,
  canTransition,
  type TaskResult,
} from "../packages/runtime/src/task-authority.js";
import type { TaskContract } from "../packages/runtime/src/contract.js";
import { CandidateWorkspace } from "../packages/runtime/src/candidate-workspace.js";
import { QualityGate } from "../packages/runtime/src/quality-gate.js";
import { ForgeDelivery } from "../packages/runtime/src/forge-delivery.js";

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
    const env = workerEnvironment({
      environment: { OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret", SAFE: "yes" },
    });
    expect(env).toMatchObject({ CI: "true", SAFE: "yes" });
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
      sandbox: "workspace-write",
      deadlineEpochMs: Date.now() + 10_000,
      outputSchema: { type: "object" },
    });
    expect(observation).toMatchObject({
      status: "completed",
      sessionId: "opaque-thread",
      output: { status: "proposed" },
    });
    expect(requestOptions).toMatchObject({ outputSchema: { type: "object" } });
    expect(requestOptions).not.toHaveProperty("env");
  });

  test("Quality Gate rejects malformed and stale exact-SHA review output", () => {
    expect(
      parseReviewObservation(
        JSON.stringify({ sha, verdict: "approved", summary: "ok", findings: [] }),
        sha,
      ).verdict,
    ).toBe("approved");
    expect(
      parseReviewObservation(
        { sha: "b".repeat(40), verdict: "approved", summary: "ok", findings: [] },
        sha,
      ).verdict,
    ).toBe("inconclusive");
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
    });
    const gate = new QualityGate({
      workspace,
      session: {
        run: async () => ({
          status: "completed",
          sessionId: "review",
          output: { sha: base, verdict: "approved", summary: "ok", findings: [] },
          usage: null,
          summary: "ok",
          failure: null,
        }),
      } as never,
      reviewerModel: "reviewer",
      reviewerReasoningEffort: "low",
      deadlineEpochMs: Date.now() + 30_000,
    });
    const evaluation = await gate.evaluate(task, base, 1);
    expect(evaluation.check.status).toBe("passed");
    expect(evaluation.review.verdict).toBe("approved");
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
    const forge = new ForgeDelivery({ repository: "/repo", deadlineEpochMs: Date.now() + 10_000 });
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
