import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  readSessionArchive,
  reviewerOutputSchema,
  type CodingSessionClientFactory,
} from "@usine/coding-session";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { QualityGate, type QualityGateCheckResult } from "@usine/quality-gate";
import type { CheckResult, ResolvedTaskContract } from "@usine/task-authority";

function requireCheckResult(result: QualityGateCheckResult): CheckResult {
  if ("kind" in result) throw new Error("expected a project check result");
  return result;
}

const contract = { id: "quality-test" } as ResolvedTaskContract;
const testEnvironment = {
  ...credentialFreeGitEnvironment(process.env),
  CI: "true",
  USINE_CHECK_POLICY: "credential-free",
};

function localSdkReviewerClient(
  finalResponse: string,
): Awaited<ReturnType<CodingSessionClientFactory>> {
  type LocalThread = ReturnType<Awaited<ReturnType<CodingSessionClientFactory>>["startThread"]>;
  const thread = {
    id: "quality-review-thread",
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started", thread_id: "quality-review-thread" };
        yield { type: "turn.started" };
        yield {
          type: "item.completed",
          item: { type: "agent_message", id: "quality-review-message", text: finalResponse },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 12,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 7,
            reasoning_output_tokens: 0,
          },
        };
      })(),
    }),
  } as unknown as LocalThread;
  return { startThread: () => thread } as Awaited<ReturnType<CodingSessionClientFactory>>;
}

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
  let reviewerContract: unknown;
  let reviewerPrompt: string | undefined;
  let sessionStatus: "completed" | "failed" = "completed";
  let reviewerSha = base;
  const gate = new QualityGate({
    workspace,
    session: {
      run: async ({
        outputSchema,
        environment,
        contract: requestContract,
        prompt,
      }: {
        outputSchema: unknown;
        environment?: NodeJS.ProcessEnv;
        contract: unknown;
        prompt: string;
      }) => {
        reviewerSchema = outputSchema;
        reviewerEnvironment = environment;
        reviewerContract = requestContract;
        reviewerPrompt = prompt;
        return {
          status: sessionStatus,
          sessionId: "review",
          output: { sha: reviewerSha, verdict: "approved", summary: "ok", findings: [] },
          usage: null,
          summary: "ok",
          failure: sessionStatus === "failed" ? "provider failed" : null,
          ...(sessionStatus === "failed"
            ? { phase: "turn" as const, failureClass: "rate_limit" as const }
            : {}),
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
  const check = requireCheckResult(await gate.check(task, base, 1));
  expect(check.status).toBe("passed");
  const capability = await new QualityGate({
    workspace,
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
    environment: { PATH: join(root, "missing-bin") },
    deadlineEpochMs: Date.now() + 30_000,
  }).check(task, base, 1);
  expect(capability).toEqual({
    kind: "capability_blocked",
    operation: "project_check",
    owner: "quality_gate",
  });
  const launchedFailure = await gate.check(
    { ...task, projectCheck: { command: "exit 127", timeoutMs: 10_000 } },
    base,
    1,
  );
  expect(launchedFailure).toMatchObject({ status: "failed", exitCode: 127 });
  const boundedCheck = requireCheckResult(
    await gate.check(
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
    ),
  );
  expect(boundedCheck.stdout.length).toBeLessThanOrEqual(16_384);
  expect(boundedCheck.stdout).toContain("[stdout truncated to 16384 characters]");
  expect(boundedCheck.stdout).toContain("stdout-head");
  expect(boundedCheck.stdout).toContain("stdout-tail");
  expect(boundedCheck.stderr.length).toBeLessThanOrEqual(16_384);
  expect(boundedCheck.stderr).toContain("[stderr truncated to 16384 characters]");
  expect(boundedCheck.stderr).toContain("stderr-head");
  expect(boundedCheck.stderr).toContain("stderr-tail");
  await expect(
    gate.reviewWithObservation(task, base, { ...check, status: "failed", exitCode: 1 }, 1),
  ).rejects.toThrow("review requires a passing exact-SHA check");
  const reviewAttempt = await gate.reviewWithObservation(task, base, check, 1);
  expect(reviewAttempt).toMatchObject({
    review: { sha: base, verdict: "approved", findings: [] },
    usage: null,
    requestedProfile: "reviewer-profile",
  });
  expect(reviewerSchema).toBe(reviewerOutputSchema);
  expect(reviewerEnvironment).toEqual(testEnvironment);
  expect(reviewerContract).toMatchObject({
    authorization: { delivery: true },
    delivery: { branch: "agent/test", issue: 1 },
  });
  expect(reviewerContract).not.toHaveProperty("repository");
  expect(reviewerContract).not.toHaveProperty("projectCheck");
  expect(reviewerContract).not.toHaveProperty("delivery.baseBranch");
  expect(reviewerPrompt).toContain(`Task Contract: ${JSON.stringify(reviewerContract)}`);
  reviewerSha = "b".repeat(40);
  const staleReviewAttempt = await gate.reviewWithObservation(task, base, check, 1);
  expect(staleReviewAttempt).toMatchObject({
    review: {
      sha: base,
      verdict: "inconclusive",
      summary: "review output was stale",
      findings: [],
    },
    usage: null,
    requestedProfile: "reviewer-profile",
  });
  sessionStatus = "failed";
  const failedReviewAttempt = await gate.reviewWithObservation(task, base, check, 1);
  expect(failedReviewAttempt).toMatchObject({
    review: null,
    usage: null,
    requestedProfile: "reviewer-profile",
    interruption: {
      phase: "turn",
      failureClass: "transient_capacity",
    },
  });

  let reviewerResponse = `Review notes include {version, fleets}.\n${JSON.stringify({
    sha: base,
    verdict: "approved",
    summary: "The candidate satisfies the task contract.",
    findings: [],
  })}`;
  const sessionStateDirectory = await mkdtemp(join(tmpdir(), "usine-quality-session-"));
  const codingSession = new CodexCodingSession(
    async () => localSdkReviewerClient(reviewerResponse),
    {
      environment: testEnvironment,
      profileResolver: async () => ({ model: "fixture-model" }),
      sessionArchive: { stateDirectory: sessionStateDirectory },
    },
  );
  const integratedGate = new QualityGate({
    workspace,
    session: codingSession,
    reviewer: {
      role: "reviewer",
      profile: "reviewer-profile",
      sandbox: "read-only",
    },
    environment: testEnvironment,
    deadlineEpochMs: Date.now() + 30_000,
  });
  const integratedReview = await integratedGate.reviewWithObservation(task, base, check, 2);
  expect(integratedReview).toMatchObject({
    review: {
      sha: base,
      verdict: "approved",
      summary: "The candidate satisfies the task contract.",
      findings: [],
    },
    usage: { inputTokens: 12, outputTokens: 7 },
    archive: { status: "stored", completeness: "complete" },
  });
  const integratedArchive = await readSessionArchive(
    sessionStateDirectory,
    integratedReview.archive!.archiveId,
  );
  expect(integratedArchive).toMatchObject({
    rawFinalResponse: reviewerResponse,
    normalizedOutput: {
      sha: base,
      verdict: "approved",
      findings: [],
    },
    usage: { inputTokens: 12, outputTokens: 7 },
  });

  reviewerResponse = `Review notes include {version, fleets}.\n${JSON.stringify({
    sha: "b".repeat(40),
    verdict: "approved",
    summary: "The candidate satisfies the task contract.",
    findings: [],
  })}`;
  const integratedStaleReview = await integratedGate.reviewWithObservation(task, base, check, 3);
  expect(integratedStaleReview).toMatchObject({
    review: {
      sha: base,
      verdict: "inconclusive",
      summary: "review output was stale",
      findings: [],
    },
    usage: { inputTokens: 12, outputTokens: 7 },
    archive: { status: "stored", completeness: "complete" },
  });
});

test("does not accept a missing mandatory Vite+ requirement behind a green candidate check", async () => {
  const sha = "a".repeat(40);
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
  });

  const task = {
    ...contract,
    repositoryId: "repo",
    baseSha: sha,
    instructions: "Keep the required toolchain intact.",
    acceptance: [
      {
        id: "vite-plus",
        criterion: "Actual Vite+ is installed and its shipped entry executes.",
        mandatory: true,
        checkId: "vite-plus",
      },
    ],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 10_000 },
    acceptanceChecks: [
      {
        id: "vite-plus",
        source: "host",
        workingDirectory: process.cwd(),
        command: "false",
        timeoutMs: 10_000,
      },
    ],
  } as unknown as ResolvedTaskContract;

  const result = requireCheckResult(await gate.check(task, sha, 1));
  expect(result.status).toBe("failed");
});

test("does not call an unavailable checkout a missing shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "usine-quality-missing-checkout-"));
  const command = "true";
  const sha = "a".repeat(40);
  const gate = new QualityGate({
    workspace: {
      withCheckout: async (_purpose, _sha, callback) => callback(join(root, "checkout")),
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
    environment: { PATH: join(root, "missing-bin") },
    deadlineEpochMs: Date.now() + 30_000,
  });

  await expect(
    gate.check(
      {
        ...contract,
        projectCheck: { command, timeoutMs: 10_000 },
      } as ResolvedTaskContract,
      sha,
      1,
    ),
  ).resolves.toEqual({
    sha,
    status: "failed",
    command,
    exitCode: 1,
    stdout: "",
    stderr: "",
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
