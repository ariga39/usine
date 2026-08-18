import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { DrizzleDataSource } from "@dbos-inc/drizzle-datasource";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { execa } from "execa";
import { App, Octokit } from "octokit";
import { Pool } from "pg";
import { z } from "zod";
import {
  codexCommand,
  herdrEnvironment,
  herdrErrorCode,
  workerEnvironment,
} from "@usine/agent-runtime";
import {
  configuredExtractorBaseUrl,
  ElapsedBudgetError,
  extractReviewerVerdict,
} from "@usine/review-extractor";
import type { ReviewerVerdict } from "@usine/review-extractor";
import type { TaskContract } from "./contract.js";
import { httpStatus } from "./http-status.js";
import { processTimedOut } from "./process-timed-out.js";
import { projectCheckEnvironment } from "./project-check-environment.js";
import { remainingUntil } from "./remaining-until.js";
import { repositoryLeases, taskRuns } from "./schema.js";

interface CheckResult {
  sha: string;
  status: "passed" | "failed";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

type ReviewResult = ReviewerVerdict;

interface DeliveryResult {
  sha: string;
  effect: "recorded" | "github";
  prNumber: number;
  url: string;
  attestationId: string;
}

interface TaskResult {
  taskId: string;
  contractHash: string;
  state: "admitted" | "candidate" | "checked" | "reviewed" | "reviewed_pr" | "blocked";
  candidateSha: string | null;
  check: CheckResult | null;
  review: ReviewResult | null;
  delivery: DeliveryResult | null;
  blocker: string | null;
  writer: { repository: string; repositoryIdentity: string; generation: number };
  evidence: {
    workflowId: string;
    implementerActivations: number;
    reviewCycles: number;
    changesRequestedBatches: number;
    restartRecoveries: number;
  };
}

interface WorkflowInput {
  contract: TaskContract;
  contractHash: string;
  canonicalCorpus: Array<{ path: string; contents: string }>;
  targetRules: Array<{ path: string; contents: string }>;
  repository: string;
  repositoryIdentity: string;
  stateDirectory: string;
  deadlineEpochMs: number;
  implementerModel: string;
  implementerProfile: string;
  reviewerModel: string;
  extractorModel: string;
  extractorBaseUrl: string;
  reviewerReasoningEffort: string;
  stopAfterAdmitted: boolean;
  crashAfterAdmitted: boolean;
  crashAfterActivation: boolean;
  crashAfterDelivery: boolean;
}

interface ImplementerResult {
  candidateSha: string;
  observation: { summary: string; sessionId: string | null; stdout: string; stderr: string };
}

type ImplementerAttempt =
  | { status: "succeeded"; implementation: ImplementerResult }
  | { status: "failed"; reason: string; budgetExhausted: boolean };

type UsineDatabase = NodePgDatabase<{
  repositoryLeases: typeof repositoryLeases;
  taskRuns: typeof taskRuns;
}>;

const implementerOutputSchema = z.object({
  status: z.enum(["proposed", "blocked"]),
  summary: z.string(),
});

const implementerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["proposed", "blocked"] },
    summary: { type: "string" },
  },
};

const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
const coordinatorRoot = fileURLToPath(new URL("../../../", import.meta.url));
const canonicalDocumentPaths = [
  "AGENTS.md",
  "docs/DESIGN.md",
  "docs/DEVELOPMENT.md",
  "docs/DECISIONS.md",
] as const;

function operationTimeout(input: WorkflowInput, maximum = Number.POSITIVE_INFINITY): number {
  const remaining = input.deadlineEpochMs - Date.now() - 150;
  if (remaining <= 0) throw new ElapsedBudgetError();
  return Math.max(1, Math.min(remaining, maximum));
}

async function startHerdrAgent<T extends { exitCode?: number | null; stderr: unknown }>(
  input: WorkflowInput,
  runHerdr: (args: string[], timeoutMs?: number) => Promise<T>,
  args: string[],
): Promise<T> {
  while (true) {
    const started = await runHerdr(args);
    if (processTimedOut(started)) throw new ElapsedBudgetError();
    if (started.exitCode === 0 || herdrErrorCode(started.stderr) !== "agent_pane_busy") {
      return started;
    }
    const delay = Math.min(50, operationTimeout(input, 50));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
  }
}

async function runGit(input: WorkflowInput, args: string[]): Promise<{ stdout: string }> {
  const result = await execa("git", args, { timeout: operationTimeout(input) });
  return { stdout: String(result.stdout) };
}

async function runCredentialFreeGit(
  input: WorkflowInput,
  args: string[],
): Promise<{ stdout: string }> {
  const result = await execa("git", args, {
    env: workerEnvironment("implementer"),
    extendEnv: false,
    timeout: operationTimeout(input),
  });
  return { stdout: String(result.stdout) };
}

async function verifyCommittedContract(
  contractPath: string,
  contract: TaskContract,
  deadlineEpochMs: number,
): Promise<string> {
  const repository = await realpath(contract.repository.path);
  const path = await realpath(contractPath);
  const relativePath = relative(repository, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("task contract must be a committed file in the authorized repository");
  }

  await execa("git", ["-C", repository, "ls-files", "--error-unmatch", relativePath], {
    timeout: remainingUntil(deadlineEpochMs),
  });
  const status = await execa(
    "git",
    ["-C", repository, "status", "--porcelain", "--", relativePath],
    { timeout: remainingUntil(deadlineEpochMs) },
  );
  if (status.stdout !== "") throw new Error("task contract has uncommitted changes");
  await execa("git", ["-C", repository, "cat-file", "-e", `${contract.baseSha}^{commit}`], {
    timeout: remainingUntil(deadlineEpochMs),
  });
  await execa("git", ["-C", repository, "merge-base", "--is-ancestor", contract.baseSha, "HEAD"], {
    timeout: remainingUntil(deadlineEpochMs),
  });
  return repository;
}

async function readCanonicalCorpus(): Promise<Array<{ path: string; contents: string }>> {
  return Promise.all(
    canonicalDocumentPaths.map(async (path) => {
      return { path, contents: await readFile(resolve(coordinatorRoot, path), "utf8") };
    }),
  );
}

async function readTargetRules(
  repository: string,
  baseSha: string,
  deadlineEpochMs: number,
): Promise<Array<{ path: string; contents: string }>> {
  const path = "AGENTS.md";
  const result = await execa("git", ["-C", repository, "show", `${baseSha}:${path}`], {
    timeout: remainingUntil(deadlineEpochMs),
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return [{ path, contents: String(result.stdout) }];
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: migrationsDirectory });
  } finally {
    await pool.end();
  }
  await DrizzleDataSource.initializeDBOSSchema({ connectionString: databaseUrl });
}

async function rejectChangedAdmittedContract(
  databaseUrl: string,
  taskId: string,
  contractHash: string,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const database = drizzle(pool, { schema: { taskRuns } });
    const existing = await database.query.taskRuns.findFirst({
      where: eq(taskRuns.taskId, taskId),
    });
    if (existing && existing.contractHash !== contractHash) {
      throw new Error("admitted contract is immutable");
    }
  } finally {
    await pool.end();
  }
}

async function ensureWorktree(input: WorkflowInput): Promise<string> {
  const workspace = resolve(input.stateDirectory, "workspaces", input.contract.id);
  try {
    const current = await runGit(input, ["-C", workspace, "rev-parse", "HEAD"]);
    await runGit(input, [
      "-C",
      workspace,
      "merge-base",
      "--is-ancestor",
      input.contract.baseSha,
      current.stdout,
    ]);
    return workspace;
  } catch {
    await rm(workspace, { recursive: true, force: true });
  }
  await mkdir(dirname(workspace), { recursive: true });
  await runGit(input, [
    "-C",
    input.repository,
    "worktree",
    "add",
    "--detach",
    workspace,
    input.contract.baseSha,
  ]);
  return workspace;
}

function sessionIdFromJsonl(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // JSONL is observation only; malformed lines do not grant authority.
    }
  }
  return null;
}

async function finalizeCandidate(
  input: WorkflowInput,
  workspace: string,
  previousSha: string,
): Promise<string> {
  const currentSha = (await runGit(input, ["-C", workspace, "rev-parse", "HEAD"])).stdout;
  const status = await runGit(input, ["-C", workspace, "status", "--porcelain"]);
  let candidateSha = currentSha;
  if (currentSha === previousSha) {
    if (status.stdout === "") throw new Error("implementer proposed no workspace changes");
    const gitConfig = ["-c", "core.hooksPath=/dev/null"];
    await runCredentialFreeGit(input, [...gitConfig, "-C", workspace, "add", "--all"]);
    await runCredentialFreeGit(input, [
      ...gitConfig,
      "-C",
      workspace,
      "commit",
      "-m",
      "Implement authorized task",
    ]);
    candidateSha = (await runGit(input, ["-C", workspace, "rev-parse", "HEAD"])).stdout;
    if (candidateSha === previousSha) throw new Error("host did not create a new candidate commit");
  } else if (status.stdout !== "") {
    throw new Error("implementer left a committed candidate workspace dirty");
  }

  await runGit(input, ["-C", workspace, "merge-base", "--is-ancestor", previousSha, candidateSha]);
  await runGit(input, [
    "-C",
    workspace,
    "merge-base",
    "--is-ancestor",
    input.contract.baseSha,
    candidateSha,
  ]);
  const finalStatus = await runGit(input, ["-C", workspace, "status", "--porcelain"]);
  if (finalStatus.stdout !== "") throw new Error("candidate workspace is dirty");
  return candidateSha;
}

async function runImplementer(
  input: WorkflowInput,
  activation: number,
  findings: string[],
  previousSha: string,
): Promise<ImplementerResult> {
  const workspace = await ensureWorktree(input);
  await runGit(input, ["-C", workspace, "reset", "--hard", previousSha]);
  await runGit(input, ["-C", workspace, "clean", "-fd"]);
  const startingSha = (await runGit(input, ["-C", workspace, "rev-parse", "HEAD"])).stdout;
  if (startingSha !== previousSha)
    throw new Error("candidate workspace did not start at prior SHA");
  const schemaPath = resolve(input.stateDirectory, "schemas", "implementer.json");
  const outputPath = resolve(
    input.stateDirectory,
    "observations",
    `${input.contract.id}-implementer-${activation}.json`,
  );
  await mkdir(dirname(schemaPath), { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(schemaPath, JSON.stringify(implementerJsonSchema));
  const prompt = [
    "Role: implementer.",
    "The coordinator has provided the authoritative credential-separated projection of active private Issue/PR/thread authority for this activation.",
    "GitHub access is neither available nor required: do not access GitHub, do not wait for user input, and missing GitHub credentials are not a blocker.",
    `Frozen Task Contract JSON: ${JSON.stringify(input.contract)}`,
    "Canonical corpus already loaded; do not reread before first action.",
    ...input.canonicalCorpus.map(
      ({ path, contents }) =>
        `Canonical document ${path}:\n${contents}\nEnd canonical document ${path}.`,
    ),
    ...input.targetRules.map(
      ({ path, contents }) => `Target repository rule ${path} (exact base SHA):\n${contents}`,
    ),
    `Authorization source: ${input.contract.authorization.source}`,
    `Base SHA: ${input.contract.baseSha}`,
    `Current SHA: ${previousSha}`,
    "The workspace is isolated and clean at the current SHA.",
    "Make the first observable in-scope action promptly; avoid broad planning.",
    ...(findings.length > 0
      ? [`Unresolved findings from the prior review: ${findings.join("; ")}`]
      : ["Unresolved findings from the prior review: none."]),
    "Implement the following authorized task in this isolated workspace.",
    "Commit the complete change and leave the worktree clean.",
    `Before settling, atomically write the exact JSON object {"status":"proposed","summary":"..."} (or status "blocked") to ${outputPath}; this file is coordinator evidence and must exist even though interactive Herdr mode has no exec structured-output flags.`,
    `Instructions: ${input.contract.instructions}`,
    `Acceptance: ${input.contract.acceptance.join("; ")}`,
    `Non-goals: ${input.contract.nonGoals.join("; ")}`,
    ...(findings.length > 0 ? [`Aggregated review findings: ${findings.join("; ")}`] : []),
  ].join("\n");
  const directBinary = process.env.USINE_CODEX_BIN ?? "codex";
  const herdrBinary = process.env.USINE_HERDR_BIN ?? "herdr";
  const observationDirectory = dirname(outputPath);
  const runHerdr = async (args: string[], timeoutMs?: number) =>
    (() => {
      const invocation = codexCommand(herdrBinary, args);
      return execa(invocation.executable, invocation.args, {
        cwd: workspace,
        env: {
          ...herdrEnvironment("implementer"),
          USINE_EXPECTED_OBSERVATION_DIR: observationDirectory,
        },
        extendEnv: false,
        reject: false,
        timeout: timeoutMs ?? operationTimeout(input),
      });
    })();
  const clearedPaneEnvironment = [
    "USINE_DATABASE_URL",
    "USINE_STATE_DIR",
    "USINE_GITHUB_TEST_TOKEN",
    "USINE_GITHUB_PRIVATE_KEY_PATH",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "USINE_EXTRACTOR_API_KEY",
    "OPENAI_API_KEY",
  ];
  const paneResult = await runHerdr([
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    workspace,
    "--no-focus",
    ...clearedPaneEnvironment.flatMap((key) => ["--env", `${key}=`]),
    "--env",
    "USINE_CODEX_ROLE=implementer",
  ]);
  const herdrUnavailable = paneResult.failed === true && paneResult.code === "ENOENT";
  if (herdrUnavailable) {
    const invocation = codexCommand(directBinary, [
      "exec",
      "--model",
      input.implementerModel,
      "--profile",
      input.implementerProfile,
      "--json",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      "--sandbox",
      "workspace-write",
      "-C",
      workspace,
      prompt,
    ]);
    const processResult = await execa(invocation.executable, invocation.args, {
      cwd: workspace,
      env: workerEnvironment("implementer"),
      extendEnv: false,
      reject: false,
      timeout: operationTimeout(input),
    });
    if (processTimedOut(processResult) || Date.now() >= input.deadlineEpochMs - 100)
      throw new ElapsedBudgetError();
    if (processResult.exitCode !== 0)
      throw new Error(`implementer process failed: ${processResult.stderr}`);
    const output = implementerOutputSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
    if (output.status === "blocked") throw new Error(`implementer blocked: ${output.summary}`);
    const candidateSha = await finalizeCandidate(input, workspace, previousSha);
    return {
      candidateSha,
      observation: {
        summary: output.summary,
        sessionId: sessionIdFromJsonl(String(processResult.stdout)),
        stdout: String(processResult.stdout),
        stderr: String(processResult.stderr),
      },
    };
  }
  if (paneResult.exitCode !== 0) throw new Error(`herdr pane split failed: ${paneResult.stderr}`);
  const pane = JSON.parse(String(paneResult.stdout)).result?.pane?.pane_id;
  if (typeof pane !== "string") throw new Error("herdr pane split returned no pane id");
  const agentName = `usine-impl-${createHash("sha256").update(input.contract.id).digest("hex").slice(0, 12)}-${activation}`;
  let implementation: ImplementerResult;
  try {
    const started = await startHerdrAgent(input, runHerdr, [
      "agent",
      "start",
      agentName,
      "--kind",
      "codex",
      "--pane",
      pane,
      "--",
      "--model",
      input.implementerModel,
      "-p",
      input.implementerProfile,
      "--sandbox",
      "workspace-write",
      "-C",
      workspace,
      "--no-alt-screen",
      "--add-dir",
      dirname(outputPath),
      "--config",
      "shell_environment_policy.inherit=core",
    ]);
    if (started.exitCode !== 0) throw new Error(`herdr agent start failed: ${started.stderr}`);
    const prompted = await runHerdr([
      "agent",
      "prompt",
      agentName,
      prompt,
      "--wait",
      "--timeout",
      String(operationTimeout(input)),
    ]);
    if (prompted.exitCode !== 0) throw new Error(`herdr agent prompt failed: ${prompted.stderr}`);
    let processResult: { stdout: string; stderr: string; exitCode: number };
    let output: z.infer<typeof implementerOutputSchema>;
    while (true) {
      const observed = await runHerdr([
        "agent",
        "read",
        agentName,
        "--source",
        "recent-unwrapped",
        "--lines",
        "200",
      ]);
      if (observed.exitCode !== 0) throw new Error(`herdr agent read failed: ${observed.stderr}`);
      processResult = {
        stdout: String(observed.stdout),
        stderr: String(observed.stderr),
        exitCode: 0,
      };
      try {
        output = implementerOutputSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
        break;
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      const lifecycle = await runHerdr(["agent", "get", agentName]);
      if (lifecycle.exitCode !== 0) throw new Error(`herdr agent get failed: ${lifecycle.stderr}`);
      let agentStatus: unknown;
      try {
        agentStatus = (
          JSON.parse(String(lifecycle.stdout)) as {
            result?: { agent?: { agent_status?: unknown } };
          }
        ).result?.agent?.agent_status;
      } catch (error) {
        throw new Error("herdr agent get returned invalid JSON", { cause: error });
      }
      if (agentStatus === "blocked") throw new Error("herdr agent blocked");
      if (typeof agentStatus !== "string")
        throw new Error("herdr agent get returned no lifecycle state");
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(50, operationTimeout(input, 50))),
      );
    }
    if (output.status === "blocked") throw new Error(`implementer blocked: ${output.summary}`);
    const candidateSha = await finalizeCandidate(input, workspace, previousSha);
    implementation = {
      candidateSha,
      observation: {
        summary: output.summary,
        sessionId: sessionIdFromJsonl(processResult.stdout),
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      },
    };
  } catch (error) {
    const closed = await runHerdr(["pane", "close", pane], 1_000);
    if (closed.exitCode !== 0)
      throw new Error(`herdr pane close failed: ${closed.stderr}`, { cause: error });
    throw error;
  }
  const closed = await runHerdr(["pane", "close", pane], 1_000);
  if (closed.exitCode !== 0) throw new Error(`herdr pane close failed: ${closed.stderr}`);
  return implementation;
}

async function attemptImplementer(
  input: WorkflowInput,
  activation: number,
  findings: string[],
  previousSha: string,
): Promise<ImplementerAttempt> {
  try {
    return {
      status: "succeeded",
      implementation: await runImplementer(input, activation, findings, previousSha),
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      budgetExhausted: processTimedOut(error) || Date.now() >= input.deadlineEpochMs - 100,
    };
  }
}

async function withDisposableWorktree<T>(
  input: WorkflowInput,
  purpose: string,
  sha: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const path = resolve(input.stateDirectory, "checkouts", `${input.contract.id}-${purpose}`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await runGit(input, ["-C", input.repository, "worktree", "remove", "--force", path]);
  } catch {
    await rm(path, { recursive: true, force: true });
  }
  await runGit(input, ["-C", input.repository, "worktree", "add", "--detach", path, sha]);
  try {
    return await callback(path);
  } finally {
    if (Date.now() < input.deadlineEpochMs - 25) {
      await runGit(input, ["-C", input.repository, "worktree", "remove", "--force", path]);
    }
  }
}

async function runCheck(input: WorkflowInput, sha: string): Promise<CheckResult> {
  return withDisposableWorktree(input, `check-${sha}`, sha, async (path) => {
    let result;
    try {
      result = await execa("sh", ["-c", input.contract.projectCheck.command], {
        cwd: path,
        env: projectCheckEnvironment(),
        extendEnv: false,
        reject: false,
        timeout: operationTimeout(input, input.contract.projectCheck.timeoutMs),
      });
    } catch (error) {
      if (processTimedOut(error) || Date.now() >= input.deadlineEpochMs - 100) {
        throw new ElapsedBudgetError();
      }
      throw error;
    }
    if (processTimedOut(result) || Date.now() >= input.deadlineEpochMs - 100) {
      throw new ElapsedBudgetError();
    }
    return {
      sha,
      status: result.exitCode === 0 ? "passed" : "failed",
      command: input.contract.projectCheck.command,
      exitCode: result.exitCode ?? 1,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  });
}

async function runReviewer(
  input: WorkflowInput,
  sha: string,
  check: CheckResult,
  cycle: number,
): Promise<ReviewResult> {
  return withDisposableWorktree(input, `review-${sha}`, sha, async (path) => {
    const prompt = [
      "Role: reviewer.",
      "The frozen Task Contract is the complete private Issue authority projection for this review.",
      "GitHub access is neither available nor required: do not access GitHub, do not wait for user input, and missing GitHub credentials are not a blocker.",
      "Independently review this exact candidate against the authorized contract.",
      `Candidate SHA: ${sha}`,
      `Contract: ${JSON.stringify(input.contract)}`,
      `Check evidence: ${JSON.stringify(check)}`,
      "Return an explicit exact-SHA verdict. Process success alone is not approval.",
      "Do not use or request implementer chat; review only the frozen contract, candidate, and check evidence.",
      'Before settling, emit exactly one transcript line whose prefix is formed by joining the literal fragments "USINE_REVIEW_" and "VERDICT="; append one compact JSON object with the exact candidate SHA, verdict, summary, and findings.',
    ].join("\n");
    const herdrBinary = process.env.USINE_HERDR_BIN ?? "herdr";
    const runHerdr = async (args: string[], timeoutMs?: number) =>
      (() => {
        const invocation = codexCommand(herdrBinary, args);
        return execa(invocation.executable, invocation.args, {
          cwd: path,
          env: herdrEnvironment("reviewer"),
          extendEnv: false,
          reject: false,
          timeout: timeoutMs ?? operationTimeout(input),
        });
      })();
    const clearedPaneEnvironment = [
      "USINE_DATABASE_URL",
      "USINE_STATE_DIR",
      "USINE_GITHUB_TEST_TOKEN",
      "USINE_GITHUB_PRIVATE_KEY_PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "USINE_EXTRACTOR_API_KEY",
      "OPENAI_API_KEY",
    ];
    const paneResult = await runHerdr([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      path,
      "--no-focus",
      ...clearedPaneEnvironment.flatMap((key) => ["--env", `${key}=`]),
      "--env",
      "USINE_CODEX_ROLE=reviewer",
    ]);
    if (processTimedOut(paneResult)) throw new ElapsedBudgetError();
    if (paneResult.exitCode !== 0) throw new Error(`herdr pane split failed: ${paneResult.stderr}`);
    const pane = JSON.parse(String(paneResult.stdout)).result?.pane?.pane_id;
    if (typeof pane !== "string") throw new Error("herdr pane split returned no pane id");
    const agentName = `usine-review-${createHash("sha256").update(input.contract.id).digest("hex").slice(0, 12)}-${cycle}`;
    const closePane = async () => {
      const remaining = input.deadlineEpochMs - Date.now();
      if (remaining <= 0) return;
      const closed = await runHerdr(["pane", "close", pane], Math.min(1_000, remaining));
      if (closed.exitCode !== 0) throw new Error(`herdr pane close failed: ${closed.stderr}`);
    };
    try {
      const started = await startHerdrAgent(input, runHerdr, [
        "agent",
        "start",
        agentName,
        "--kind",
        "codex",
        "--pane",
        pane,
        "--",
        "--model",
        input.reviewerModel,
        "--sandbox",
        "read-only",
        "-C",
        path,
        "--no-alt-screen",
        "--config",
        "shell_environment_policy.inherit=core",
        "--config",
        `model_reasoning_effort=${input.reviewerReasoningEffort}`,
        "--config",
        "service_tier=default",
      ]);
      if (started.exitCode !== 0) throw new Error(`herdr agent start failed: ${started.stderr}`);
      const prompted = await runHerdr([
        "agent",
        "prompt",
        agentName,
        prompt,
        "--wait",
        "--timeout",
        String(operationTimeout(input)),
      ]);
      if (processTimedOut(prompted)) throw new ElapsedBudgetError();
      if (prompted.exitCode !== 0) throw new Error(`herdr agent prompt failed: ${prompted.stderr}`);
      while (true) {
        const observed = await runHerdr([
          "agent",
          "read",
          agentName,
          "--source",
          "recent-unwrapped",
          "--lines",
          "200",
        ]);
        if (processTimedOut(observed)) throw new ElapsedBudgetError();
        if (observed.exitCode !== 0) throw new Error(`herdr agent read failed: ${observed.stderr}`);
        const transcript = String(observed.stdout);
        if (transcript.replaceAll(/\r?\n/g, "").includes("USINE_REVIEW_VERDICT=")) {
          try {
            const review = await extractReviewerVerdict(input, transcript, sha);
            await closePane();
            return review;
          } catch (error) {
            await closePane();
            if (processTimedOut(error)) throw error;
            return {
              sha,
              verdict: "inconclusive",
              summary: error instanceof Error ? error.message : String(error),
              findings: [],
            };
          }
        }
        const lifecycle = await runHerdr(["agent", "get", agentName]);
        if (processTimedOut(lifecycle)) throw new ElapsedBudgetError();
        if (lifecycle.exitCode !== 0)
          throw new Error(`herdr agent get failed: ${lifecycle.stderr}`);
        let agentStatus: unknown;
        try {
          agentStatus = (
            JSON.parse(String(lifecycle.stdout)) as {
              result?: { agent?: { agent_status?: unknown } };
            }
          ).result?.agent?.agent_status;
        } catch (error) {
          throw new Error("herdr agent get returned invalid JSON", { cause: error });
        }
        if (agentStatus === "blocked") throw new Error("herdr agent blocked");
        if (typeof agentStatus !== "string")
          throw new Error("herdr agent get returned no lifecycle state");
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, Math.min(50, operationTimeout(input, 50))),
        );
      }
    } catch (error) {
      await closePane();
      throw error;
    }
  });
}

async function recordDelivery(input: WorkflowInput, sha: string): Promise<DeliveryResult> {
  const delivery: DeliveryResult = {
    sha,
    effect: "recorded",
    prNumber: input.contract.delivery.issue,
    url: `record://${input.contract.repository.owner}/${input.contract.repository.name}/pull/${input.contract.delivery.issue}`,
    attestationId: `${input.contract.id}:${sha}`,
  };
  const counterPath = process.env.USINE_RECORD_DELIVERY_COUNTER;
  if (counterPath) {
    let count = 0;
    try {
      const existing = JSON.parse(await readFile(counterPath, "utf8")) as {
        count: number;
      };
      count = existing.count;
    } catch {
      // Missing means no delivery effect attempt has been recorded yet.
    }
    await mkdir(dirname(counterPath), { recursive: true });
    await writeFile(counterPath, JSON.stringify({ count: count + 1, delivery }));
  }
  return delivery;
}

async function githubClient(): Promise<{
  octokit: InstanceType<typeof Octokit>;
  token: string;
  appSlug: string;
}> {
  const testToken = process.env.USINE_GITHUB_TEST_TOKEN;
  const apiUrl = process.env.USINE_GITHUB_API_URL;
  const appSlug = process.env.USINE_GITHUB_APP_SLUG;
  if (!appSlug) throw new Error("USINE_GITHUB_APP_SLUG is required");
  if (testToken) {
    if (!apiUrl || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(apiUrl)) {
      throw new Error("USINE_GITHUB_TEST_TOKEN is restricted to a loopback API URL");
    }
    return {
      octokit: new Octokit({ auth: testToken, baseUrl: apiUrl }),
      token: testToken,
      appSlug,
    };
  }

  const appId = process.env.USINE_GITHUB_APP_ID;
  const installationId = Number(process.env.USINE_GITHUB_INSTALLATION_ID);
  const privateKeyPath = process.env.USINE_GITHUB_PRIVATE_KEY_PATH;
  if (!appId || !Number.isSafeInteger(installationId) || !privateKeyPath) {
    throw new Error(
      "USINE_GITHUB_APP_ID, USINE_GITHUB_INSTALLATION_ID, and USINE_GITHUB_PRIVATE_KEY_PATH are required",
    );
  }
  const privateKey = await readFile(privateKeyPath, "utf8");
  const app = new App({ appId, privateKey });
  const octokit = await app.getInstallationOctokit(installationId);
  const authentication = (await octokit.auth({ type: "installation" })) as { token?: unknown };
  if (typeof authentication.token !== "string") {
    throw new Error("GitHub App did not produce an installation token");
  }
  return { octokit, token: authentication.token, appSlug };
}

function approvalAttestationBody(
  input: WorkflowInput,
  sha: string,
  check: CheckResult,
  review: ReviewResult,
): string {
  return [
    `<!-- usine-approval:${input.contract.id}:${sha} -->`,
    "Usine exact-SHA semantic approval attestation",
    `- Candidate: \`${sha}\``,
    `- Project check: \`${check.command}\` (${check.status})`,
    `- Fresh reviewer verdict: \`${review.verdict}\``,
    `- Review summary: ${review.summary}`,
  ].join("\n");
}

async function githubDelivery(
  input: WorkflowInput,
  sha: string,
  check: CheckResult,
  review: ReviewResult,
): Promise<DeliveryResult> {
  const { owner, name: repo } = input.contract.repository;
  const { branch, baseBranch } = input.contract.delivery;
  const { octokit, token, appSlug } = await githubClient();
  let expectedHead: string | null = null;
  try {
    const reference = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      request: { timeout: operationTimeout(input), retries: 0 },
    });
    expectedHead = reference.data.object.sha;
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }

  if (expectedHead !== sha) {
    const gitUrl = process.env.USINE_GITHUB_GIT_URL ?? `https://github.com/${owner}/${repo}.git`;
    const environment: NodeJS.ProcessEnv = { ...process.env };
    if (gitUrl.startsWith("https://github.com/")) {
      environment.GIT_CONFIG_COUNT = "1";
      environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    }
    await execa(
      "git",
      [
        "-C",
        input.repository,
        "push",
        `--force-with-lease=refs/heads/${branch}:${expectedHead ?? ""}`,
        gitUrl,
        `${sha}:refs/heads/${branch}`,
      ],
      { env: environment, timeout: operationTimeout(input) },
    );
  }

  const pullRequests = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    base: baseBranch,
    state: "all",
    per_page: 100,
    request: { timeout: operationTimeout(input), retries: 0 },
  });
  const existingPullRequest = pullRequests.data.find((pullRequest) => pullRequest.head.sha === sha);
  if (existingPullRequest && existingPullRequest.state !== "open") {
    throw new Error(
      `closed delivery PR #${existingPullRequest.number} already targets candidate ${sha}; delivery quarantined`,
    );
  }
  if (!existingPullRequest && pullRequests.data.length > 0) {
    const conflicting = pullRequests.data[0];
    throw new Error(
      `open delivery PR #${conflicting?.number ?? "unknown"} has head ${conflicting?.head.sha ?? "unknown"}, not candidate ${sha}; delivery quarantined`,
    );
  }
  const pullRequest =
    existingPullRequest ??
    (
      await octokit.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base: baseBranch,
        title: input.contract.delivery.title,
        body: `${input.contract.delivery.body}\n\nCloses #${input.contract.delivery.issue}`,
        draft: false,
        request: { retries: 0, timeout: operationTimeout(input) },
      })
    ).data;
  const expectedAttestationBody = approvalAttestationBody(input, sha, check, review);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullRequest.number,
    per_page: 100,
    request: { timeout: operationTimeout(input), retries: 0 },
  });
  const existingAttestation = comments.find((comment) => {
    const identity = comment as typeof comment & {
      performed_via_github_app?: { slug?: string } | null;
    };
    return (
      comment.body === expectedAttestationBody &&
      identity.performed_via_github_app?.slug === appSlug &&
      comment.user?.type === "Bot"
    );
  });
  const attestation =
    existingAttestation ??
    (
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequest.number,
        body: expectedAttestationBody,
        request: { retries: 0, timeout: operationTimeout(input) },
      })
    ).data;
  return {
    sha,
    effect: "github",
    prNumber: pullRequest.number,
    url: pullRequest.html_url,
    attestationId: String(attestation.id),
  };
}

async function deliver(
  input: WorkflowInput,
  sha: string,
  check: CheckResult,
  review: ReviewResult,
): Promise<DeliveryResult> {
  if (process.env.USINE_DELIVERY_MODE === "record") return recordDelivery(input, sha);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await githubDelivery(input, sha, check, review);
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === 3) throw error;
      const delay = Math.min(50, operationTimeout(input));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw lastError;
}

async function crashOnce(
  input: WorkflowInput,
  stage: "admitted" | "activation" | "delivery",
): Promise<boolean> {
  const marker = resolve(input.stateDirectory, "recovery", `${input.contract.id}-${stage}-crash`);
  try {
    await readFile(marker, "utf8");
    return true;
  } catch {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, `crash injected after checkpointed ${stage}\n`);
    process.kill(process.pid, "SIGKILL");
    return new Promise<boolean>(() => undefined);
  }
}

async function writeResultArtifact(stateDirectory: string, result: TaskResult): Promise<void> {
  const resultPath = resolve(stateDirectory, "results", `${result.taskId}.json`);
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "w" });
}

export async function admitTask(
  contractPath: string,
  rawContract: string,
  contract: TaskContract,
): Promise<TaskResult> {
  const databaseUrl = process.env.USINE_DATABASE_URL;
  if (!databaseUrl) throw new Error("USINE_DATABASE_URL is required");
  const deadlineEpochMs = Date.now() + contract.budget.maxElapsedMs;
  const repository = await verifyCommittedContract(contractPath, contract, deadlineEpochMs);
  const [canonicalCorpus, targetRules] = await Promise.all([
    readCanonicalCorpus(),
    readTargetRules(repository, contract.baseSha, deadlineEpochMs),
  ]);
  await applyMigrations(databaseUrl);
  const stateDirectory = resolve(process.env.USINE_STATE_DIR ?? ".usine");
  const contractHash = createHash("sha256").update(rawContract).digest("hex");
  const repositoryIdentity =
    `${contract.repository.owner}/${contract.repository.name}`.toLowerCase();
  const input: WorkflowInput = {
    contract,
    contractHash,
    canonicalCorpus,
    targetRules,
    repository,
    repositoryIdentity,
    stateDirectory,
    deadlineEpochMs,
    implementerModel: process.env.USINE_IMPLEMENTER_MODEL ?? "gpt-5.6-luna",
    implementerProfile: process.env.USINE_IMPLEMENTER_PROFILE ?? "usine-implementer",
    reviewerModel: process.env.USINE_REVIEWER_MODEL ?? "gpt-5.6-sol",
    extractorModel: process.env.USINE_EXTRACTOR_MODEL ?? "gpt-5.6-luna",
    extractorBaseUrl: configuredExtractorBaseUrl(),
    reviewerReasoningEffort: process.env.USINE_REVIEWER_REASONING_EFFORT ?? "low",
    stopAfterAdmitted: process.env.USINE_STOP_AFTER === "admitted",
    crashAfterAdmitted: process.env.USINE_CRASH_AFTER === "admitted",
    crashAfterActivation: process.env.USINE_CRASH_AFTER === "activation",
    crashAfterDelivery: process.env.USINE_CRASH_AFTER === "delivery",
  };
  await rejectChangedAdmittedContract(databaseUrl, contract.id, contractHash);

  const dataSource = new DrizzleDataSource<UsineDatabase>(
    "usine-domain",
    { connectionString: databaseUrl },
    { repositoryLeases, taskRuns },
  );
  const admit = dataSource.registerTransaction(
    async (frozenInput: WorkflowInput): Promise<TaskResult> => {
      const { contract, contractHash, repository, repositoryIdentity } = frozenInput;
      const existing = await dataSource.client.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, contract.id),
      });
      if (existing) {
        if (existing.contractHash !== contractHash)
          throw new Error("admitted contract is immutable");
        return existing.result as TaskResult;
      }

      const insertedLease = await dataSource.client
        .insert(repositoryLeases)
        .values({ repositoryIdentity, taskId: contract.id, generation: 1 })
        .onConflictDoNothing()
        .returning();
      const lease =
        insertedLease[0] ??
        (await dataSource.client.query.repositoryLeases.findFirst({
          where: and(
            eq(repositoryLeases.repositoryIdentity, repositoryIdentity),
            eq(repositoryLeases.taskId, contract.id),
          ),
        }));
      if (!lease) throw new Error("repository already has an active writer");

      const result: TaskResult = {
        taskId: contract.id,
        contractHash,
        state: "admitted",
        candidateSha: null,
        check: null,
        review: null,
        delivery: null,
        blocker: null,
        writer: { repository, repositoryIdentity, generation: lease.generation },
        evidence: {
          workflowId: contract.id,
          implementerActivations: 0,
          reviewCycles: 0,
          changesRequestedBatches: 0,
          restartRecoveries: 0,
        },
      };
      await dataSource.client.insert(taskRuns).values({
        taskId: contract.id,
        contractHash,
        contract,
        repository,
        state: result.state,
        writerGeneration: lease.generation,
        deadlineAt: new Date(frozenInput.deadlineEpochMs),
        result,
      });
      return result;
    },
    { name: "admitTask" },
  );
  const saveResult = dataSource.registerTransaction(
    async (result: TaskResult): Promise<TaskResult> => {
      await dataSource.client
        .update(taskRuns)
        .set({ state: result.state, result, updatedAt: new Date() })
        .where(eq(taskRuns.taskId, result.taskId));
      return result;
    },
    { name: "saveTaskResult" },
  );
  const workflow = DBOS.registerWorkflow(
    async (frozenInput: WorkflowInput): Promise<TaskResult> => {
      const input = frozenInput;
      let result = await admit(input);
      if (input.crashAfterAdmitted) {
        await DBOS.runStep(() => crashOnce(input, "admitted"), {
          name: "crash-after-admitted",
        });
      }
      if (input.stopAfterAdmitted) return result;
      let findings: string[] = [];
      let previousSha = input.contract.baseSha;
      for (let cycle = 1; cycle <= input.contract.budget.maxReviewCycles; cycle += 1) {
        let implementation: ImplementerResult | null = null;
        while (implementation === null) {
          const activation = result.evidence.implementerActivations + 1;
          if (activation > input.contract.budget.maxImplementerActivations) {
            return saveResult({
              ...result,
              state: "blocked",
              blocker: "implementer activation budget exhausted",
            });
          }
          result = await saveResult({
            ...result,
            evidence: { ...result.evidence, implementerActivations: activation },
          });
          if (input.crashAfterActivation) {
            await DBOS.runStep(() => crashOnce(input, "activation"), {
              name: `crash-after-activation-${activation}`,
            });
          }
          const attempt = await DBOS.runStep(
            () => attemptImplementer(input, activation, findings, previousSha),
            { name: `implementer-${activation}` },
          );
          if (attempt.status === "failed") {
            if (attempt.budgetExhausted) {
              return saveResult({
                ...result,
                state: "blocked",
                blocker: "elapsed budget exhausted during implementation",
              });
            }
            if (activation >= input.contract.budget.maxImplementerActivations) {
              return saveResult({
                ...result,
                state: "blocked",
                blocker: `implementer failed after ${activation} activation(s): ${attempt.reason}`,
              });
            }
            continue;
          }
          implementation = attempt.implementation;
        }
        result = await saveResult({
          ...result,
          state: "candidate",
          candidateSha: implementation.candidateSha,
          check: null,
          review: null,
          delivery: null,
          blocker: null,
        });
        let check: CheckResult;
        try {
          check = await DBOS.runStep(() => runCheck(input, implementation.candidateSha), {
            name: `check-${cycle}`,
          });
        } catch (error) {
          if (processTimedOut(error)) {
            return saveResult({
              ...result,
              state: "blocked",
              blocker: "elapsed budget exhausted during project checks",
            });
          }
          throw error;
        }
        result = await saveResult({ ...result, state: "checked", check });
        if (check.status !== "passed") {
          return saveResult({ ...result, state: "blocked", blocker: "project check failed" });
        }
        let review: ReviewResult;
        try {
          review = await DBOS.runStep(
            () => runReviewer(input, implementation.candidateSha, check, cycle),
            { name: `review-${cycle}` },
          );
        } catch (error) {
          if (processTimedOut(error)) {
            return saveResult({
              ...result,
              state: "blocked",
              blocker: "elapsed budget exhausted during review",
            });
          }
          throw error;
        }
        result = await saveResult({
          ...result,
          state: "reviewed",
          review,
          evidence: { ...result.evidence, reviewCycles: cycle },
        });
        if (review.verdict === "approved") {
          let delivery: DeliveryResult;
          try {
            delivery = await DBOS.runStep(
              () => deliver(input, implementation.candidateSha, check, review),
              { name: "delivery" },
            );
          } catch (error) {
            if (processTimedOut(error)) {
              return saveResult({
                ...result,
                state: "blocked",
                blocker: "elapsed budget exhausted during delivery",
              });
            }
            throw error;
          }
          if (input.crashAfterDelivery) {
            const recovered = await DBOS.runStep(() => crashOnce(input, "delivery"), {
              name: "crash-after-delivery",
            });
            result = {
              ...result,
              evidence: {
                ...result.evidence,
                restartRecoveries: result.evidence.restartRecoveries + (recovered ? 1 : 0),
              },
            };
          }
          return saveResult({ ...result, state: "reviewed_pr", delivery });
        }
        if (review.verdict === "inconclusive") {
          return saveResult({
            ...result,
            state: "blocked",
            blocker: `review inconclusive: ${review.summary}`,
          });
        }
        result = await saveResult({
          ...result,
          evidence: {
            ...result.evidence,
            changesRequestedBatches: result.evidence.changesRequestedBatches + 1,
          },
        });
        if (
          cycle >= input.contract.budget.maxReviewCycles ||
          result.evidence.implementerActivations >= input.contract.budget.maxImplementerActivations
        ) {
          return saveResult({
            ...result,
            state: "blocked",
            blocker: "review changes requested after recovery budget was exhausted",
          });
        }
        findings = review.findings;
        previousSha = implementation.candidateSha;
      }
      return saveResult({ ...result, state: "blocked", blocker: "review budget exhausted" });
    },
    { name: "firstDeliveryWorkflow" },
  );

  DBOS.setConfig({
    name: "usine",
    systemDatabaseUrl: databaseUrl,
    applicationVersion: "0.1.0",
    logLevel: "warn",
  });
  await DBOS.launch();
  try {
    const handle = await DBOS.startWorkflow(workflow, { workflowID: contract.id })(input);
    const result = await handle.getResult();
    await writeResultArtifact(stateDirectory, result);
    return result;
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}
