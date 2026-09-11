import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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

test("runs a frozen Vite+ verifier against the exact candidate, not its self-check", async () => {
  const root = await mkdtemp(join(tmpdir(), "usine-quality-vite-plus-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  const vitePlusPackage = JSON.parse(
    await readFile(join(process.cwd(), "node_modules/vite-plus/package.json"), "utf8"),
  ) as { version: string };
  const shippedEntry = 'process.stdout.write("vite-plus shipped entry\\n");\n';
  const candidateSelfTest = 'process.stdout.write("candidate self-test\\n");\n';
  await writeFile(join(repository, "shipped-entry.mjs"), shippedEntry);
  await writeFile(join(repository, "self-test.mjs"), candidateSelfTest);
  const shippedEntryDigest = createHash("sha256").update(shippedEntry, "utf8").digest("hex");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: { "vite-plus": vitePlusPackage.version },
      scripts: { verify: "node shipped-entry.mjs" },
    }),
  );
  await execa("git", ["add", "package.json", "shipped-entry.mjs", "self-test.mjs"], {
    cwd: repository,
  });
  await execa("git", ["commit", "-m", "vite-plus-present"], { cwd: repository });
  const positiveSha = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ private: true, devDependencies: { vite: vitePlusPackage.version } }),
  );
  await execa("git", ["add", "package.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "vite-plus-lookalike"], { cwd: repository });
  const adverseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

  const verifier = join(root, "frozen-vite-plus-verifier.mjs");
  await writeFile(
    verifier,
    [
      'import { execFileSync } from "node:child_process";',
      'import { createHash } from "node:crypto";',
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const candidate = process.env.USINE_CANDIDATE_PATH;",
      "const expected = process.env.USINE_EXPECTED_VITE_PLUS;",
      'const packageJson = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));',
      'if (packageJson.devDependencies?.["vite-plus"] !== expected) process.exit(17);',
      'if (packageJson.scripts?.verify !== "node shipped-entry.mjs") process.exit(18);',
      'const entryPath = join(candidate, "shipped-entry.mjs");',
      'const digest = createHash("sha256").update(readFileSync(entryPath)).digest("hex");',
      "if (digest !== process.env.USINE_EXPECTED_ENTRY_DIGEST) process.exit(19);",
      'const output = execFileSync(process.env.USINE_FROZEN_VP, ["run", "verify"], { cwd: candidate, encoding: "utf8" });',
      'if (!output.includes("vite-plus shipped entry")) process.exit(20);',
      'process.stdout.write(JSON.stringify({ artifact: "vite-plus shipped entry", entry: "verify pipeline", observation: "executed real Vite+ run pipeline" }));',
    ].join("\n"),
  );
  const workspace = new CandidateWorkspace({
    repository,
    stateDirectory: join(root, "state"),
    deadlineEpochMs: Date.now() + 30_000,
    credentialFreeGit: credentialFreeGitEnvironment(process.env),
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  const task = {
    ...contract,
    repositoryId: "repo",
    baseSha: positiveSha,
    instructions: "Keep the real Vite+ entry available.",
    delivery: {
      baseBranch: "main",
      branch: "agent/acceptance",
      issue: 1,
      title: "Acceptance",
      body: "Verify the shipped entry",
    },
    acceptance: [
      {
        id: "vite-plus",
        criterion: "The actual Vite+ shipped entry executes.",
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
        command: 'node "$USINE_VITE_PLUS_VERIFIER"',
        timeoutMs: 10_000,
        publicObservation: "safe-json-v1",
      },
    ],
  } as unknown as ResolvedTaskContract;
  let actualReviewPrompt = "";
  const gate = new QualityGate({
    workspace,
    session: {
      run: async (request) => {
        actualReviewPrompt = request.prompt;
        return {
          status: "completed",
          summary: "Verified shipped entry",
          failure: null,
          output: {
            sha: positiveSha,
            verdict: "approved",
            summary: "Verified shipped entry",
            findings: [],
          },
        };
      },
    },
    reviewer: { role: "reviewer", profile: "reviewer-profile", sandbox: "read-only" },
    environment: {
      ...testEnvironment,
      USINE_VITE_PLUS_VERIFIER: verifier,
      USINE_FROZEN_VP: join(process.cwd(), "node_modules/vite-plus/bin/vp"),
      USINE_EXPECTED_VITE_PLUS: vitePlusPackage.version,
      USINE_EXPECTED_ENTRY_DIGEST: shippedEntryDigest,
    },
    deadlineEpochMs: Date.now() + 30_000,
  });

  const positive = requireCheckResult(await gate.check(task, positiveSha, 1));
  expect(positive.status).toBe("passed");
  const reviewed = await gate.reviewWithObservation(task, positiveSha, positive, 1);
  expect(reviewed.review?.verdict).toBe("approved");
  expect(actualReviewPrompt).toContain("executed real Vite+ run pipeline");
  expect(actualReviewPrompt).toContain(positiveSha);
  expect(actualReviewPrompt).toContain(positive.acceptanceChecks![0]!.outputDigest!);
  expect(actualReviewPrompt).not.toContain(verifier);
  expect(positive.acceptanceChecks).toMatchObject([
    {
      id: "vite-plus",
      sha: positiveSha,
      status: "passed",
      outputDigest: expect.any(String),
      observation: {
        artifact: "vite-plus shipped entry",
        entry: "verify pipeline",
        observation: "executed real Vite+ run pipeline",
      },
    },
  ]);

  const adverse = requireCheckResult(
    await gate.check({ ...task, baseSha: adverseSha }, adverseSha, 2),
  );
  expect(adverse.status).toBe("failed");
  expect(adverse.acceptanceChecks).toMatchObject([
    { id: "vite-plus", sha: adverseSha, status: "failed", exitCode: 17 },
  ]);

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: { vite: vitePlusPackage.version },
      scripts: { verify: "true" },
    }),
  );
  await execa("git", ["add", "package.json"], { cwd: repository });
  await execa("git", ["rm", "self-test.mjs"], { cwd: repository });
  await execa("git", ["commit", "-m", "remove self-test and keep green check"], {
    cwd: repository,
  });
  const missingToolchainAfterSelfTestRemoval = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const missingToolchain = requireCheckResult(
    await gate.check(
      { ...task, baseSha: missingToolchainAfterSelfTestRemoval },
      missingToolchainAfterSelfTestRemoval,
      3,
    ),
  );
  expect(missingToolchain).toMatchObject({
    status: "failed",
    acceptanceChecks: [
      {
        id: "vite-plus",
        sha: missingToolchainAfterSelfTestRemoval,
        status: "failed",
        exitCode: 17,
      },
    ],
  });

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: { "vite-plus": vitePlusPackage.version },
      scripts: { verify: "true" },
    }),
  );
  await execa("git", ["add", "package.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "tamper candidate self-check"], { cwd: repository });
  const tamperedSha = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const tampered = requireCheckResult(
    await gate.check({ ...task, baseSha: tamperedSha }, tamperedSha, 3),
  );
  expect(tampered).toMatchObject({
    status: "failed",
    acceptanceChecks: [{ id: "vite-plus", sha: tamperedSha, status: "failed", exitCode: 18 }],
  });

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      devDependencies: { "vite-plus": vitePlusPackage.version },
      scripts: { verify: "node shipped-entry.mjs" },
    }),
  );
  await execa("git", ["add", "package.json"], { cwd: repository });
  await execa("git", ["commit", "-m", "restore valid artifact check"], { cwd: repository });
  const withoutOptionalSelfTestSha = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();
  const withoutOptionalSelfTest = requireCheckResult(
    await gate.check(
      { ...task, baseSha: withoutOptionalSelfTestSha },
      withoutOptionalSelfTestSha,
      4,
    ),
  );
  expect(withoutOptionalSelfTest.status).toBe("passed");

  await execa("git", ["rm", "shipped-entry.mjs"], { cwd: repository });
  await execa("git", ["commit", "-m", "delete shipped entry"], { cwd: repository });
  const deletedSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const deleted = requireCheckResult(
    await gate.check({ ...task, baseSha: deletedSha }, deletedSha, 5),
  );
  expect(deleted).toMatchObject({
    status: "failed",
    acceptanceChecks: [{ id: "vite-plus", sha: deletedSha, status: "failed" }],
  });
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

test("keeps optional acceptance checks nonblocking and distinguishes unavailable verifiers", async () => {
  const sha = "a".repeat(40);
  const baseTask = {
    ...contract,
    baseSha: sha,
    projectCheck: { command: "true", timeoutMs: 10_000 },
  } as ResolvedTaskContract;
  const gate = new QualityGate({
    workspace: {
      withCheckout: async (_purpose, _sha, callback) => callback(tmpdir()),
    },
    session: {
      run: async () => {
        throw new Error("reviewer should not start");
      },
    },
    reviewer: { role: "reviewer", profile: "reviewer-profile", sandbox: "read-only" },
    environment: testEnvironment,
    deadlineEpochMs: Date.now() + 30_000,
  });

  const optional = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "preference", criterion: "Optional", mandatory: false, checkId: "missing" },
        ],
        acceptanceChecks: [],
      } as ResolvedTaskContract,
      sha,
      1,
    ),
  );
  expect(optional.status).toBe("passed");
  expect(optional.acceptanceChecks).toBeUndefined();

  const missing = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "required", criterion: "Required", mandatory: true, checkId: "missing" },
        ],
        acceptanceChecks: [],
      } as ResolvedTaskContract,
      sha,
      2,
    ),
  );
  expect(missing).toMatchObject({
    status: "failed",
    acceptanceChecks: [
      { id: "missing", status: "unavailable", reason: "missing_verifier", exitCode: 127 },
    ],
  });

  const spawnUnavailable = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "required", criterion: "Required", mandatory: true, checkId: "unavailable" },
        ],
        acceptanceChecks: [
          {
            id: "unavailable",
            source: "host",
            workingDirectory: join(
              await mkdtemp(join(tmpdir(), "usine-missing-verifier-")),
              "missing",
            ),
            command: "true",
            timeoutMs: 10_000,
          },
        ],
      } as ResolvedTaskContract,
      sha,
      3,
    ),
  );
  expect(spawnUnavailable).toMatchObject({
    status: "failed",
    acceptanceChecks: [
      { id: "unavailable", status: "unavailable", reason: "spawn_unavailable", exitCode: 127 },
    ],
  });
  const commandFailure = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "required", criterion: "Required", mandatory: true, checkId: "launched" },
        ],
        acceptanceChecks: [
          {
            id: "launched",
            source: "host",
            workingDirectory: tmpdir(),
            command: "exit 127",
            timeoutMs: 10_000,
          },
        ],
      },
      sha,
      4,
    ),
  );
  expect(commandFailure.acceptanceChecks).toMatchObject([
    { id: "launched", status: "failed", exitCode: 127 },
  ]);
  expect(commandFailure.acceptanceChecks?.[0]?.reason).toBeUndefined();

  const missingObservation = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "required", criterion: "Required", mandatory: true, checkId: "observation" },
        ],
        acceptanceChecks: [
          {
            id: "observation",
            source: "host",
            workingDirectory: tmpdir(),
            command: "true",
            timeoutMs: 10_000,
            publicObservation: "safe-json-v1",
          },
        ],
      },
      sha,
      5,
    ),
  );
  expect(missingObservation.acceptanceChecks).toMatchObject([
    { id: "observation", status: "unavailable", reason: "invalid_observation", exitCode: 0 },
  ]);
  const omittedObservationContract = requireCheckResult(
    await gate.check(
      {
        ...baseTask,
        acceptance: [
          { id: "required", criterion: "Required", mandatory: true, checkId: "unconfigured" },
        ],
        acceptanceChecks: [
          {
            id: "unconfigured",
            source: "host",
            workingDirectory: tmpdir(),
            command: "true",
            timeoutMs: 10_000,
          },
        ],
      },
      sha,
      6,
    ),
  );
  expect(omittedObservationContract).toMatchObject({
    status: "failed",
    acceptanceChecks: [{ status: "unavailable", reason: "invalid_observation" }],
  });
});

test("preserves acceptance timeout and cancellation classifications", async () => {
  const sha = "a".repeat(40);
  const task = {
    ...contract,
    baseSha: sha,
    acceptance: [{ id: "required", criterion: "Required", mandatory: true, checkId: "required" }],
    projectCheck: { command: "true", timeoutMs: 10_000 },
    acceptanceChecks: [
      {
        id: "required",
        source: "host",
        workingDirectory: tmpdir(),
        command: "sleep 10",
        timeoutMs: 25,
      },
    ],
  } as ResolvedTaskContract;
  const gate = new QualityGate({
    workspace: {
      withCheckout: async (_purpose, _sha, callback) => callback(tmpdir()),
    },
    session: {
      run: async () => {
        throw new Error("reviewer should not start");
      },
    },
    reviewer: { role: "reviewer", profile: "reviewer-profile", sandbox: "read-only" },
    environment: testEnvironment,
    deadlineEpochMs: Date.now() + 30_000,
  });
  const timeout = requireCheckResult(await gate.check(task, sha, 1));
  expect(timeout).toMatchObject({
    status: "failed",
    acceptanceChecks: [{ id: "required", status: "failed", exitCode: 124 }],
  });

  const controller = new AbortController();
  const cancellationRoot = await mkdtemp(join(tmpdir(), "usine-acceptance-cancel-"));
  const startedPath = join(cancellationRoot, "started");
  const cancelledGate = new QualityGate({
    workspace: {
      withCheckout: async (_purpose, _sha, callback) => callback(tmpdir()),
    },
    session: {
      run: async () => {
        throw new Error("reviewer should not start");
      },
    },
    reviewer: { role: "reviewer", profile: "reviewer-profile", sandbox: "read-only" },
    environment: { ...testEnvironment, USINE_ACCEPTANCE_STARTED: startedPath },
    deadlineEpochMs: Date.now() + 30_000,
    signal: controller.signal,
  });
  const pending = cancelledGate.check(
    {
      ...task,
      acceptanceChecks: [
        {
          id: "required",
          source: "host",
          workingDirectory: cancellationRoot,
          command: 'printf started > "$USINE_ACCEPTANCE_STARTED"; exec sleep 10',
          timeoutMs: 10_000,
        },
      ],
    },
    sha,
    2,
  );
  const rejection = expect(pending).rejects.toThrow("acceptance check cancelled");
  try {
    await expect.poll(() => readFile(startedPath, "utf8").catch(() => null)).toBe("started");
    controller.abort();
    await rejection;
  } finally {
    controller.abort();
  }
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
