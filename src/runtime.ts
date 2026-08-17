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
import type { TaskContract } from "./contract.js";
import { repositoryLeases, taskRuns } from "./schema.js";

interface CheckResult {
  sha: string;
  status: "passed" | "failed";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ReviewResult {
  sha: string;
  verdict: "approved" | "changes_requested" | "inconclusive";
  summary: string;
  findings: string[];
}

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
  repository: string;
  repositoryIdentity: string;
  stateDirectory: string;
  deadlineEpochMs: number;
  stopAfterAdmitted: boolean;
  crashAfterAdmitted: boolean;
  crashAfterDelivery: boolean;
}

interface ImplementerResult {
  candidateSha: string;
  observation: { summary: string; sessionId: string | null; stdout: string; stderr: string };
}

type ImplementerAttempt =
  | { status: "succeeded"; implementation: ImplementerResult }
  | { status: "failed"; reason: string };

type UsineDatabase = NodePgDatabase<{
  repositoryLeases: typeof repositoryLeases;
  taskRuns: typeof taskRuns;
}>;

const implementerOutputSchema = z.object({
  status: z.enum(["proposed", "blocked"]),
  summary: z.string(),
});

const reviewerOutputSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  verdict: z.enum(["approved", "changes_requested", "inconclusive"]),
  summary: z.string(),
  findings: z.array(z.string()),
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

const reviewerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sha", "verdict", "summary", "findings"],
  properties: {
    sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    verdict: {
      type: "string",
      enum: ["approved", "changes_requested", "inconclusive"],
    },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
};

const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));

function workerEnvironment(role: "implementer" | "reviewer"): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { USINE_CODEX_ROLE: role };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "COLORTERM",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function projectCheckEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "true" };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function verifyCommittedContract(
  contractPath: string,
  contract: TaskContract,
): Promise<string> {
  const repository = await realpath(contract.repository.path);
  const path = await realpath(contractPath);
  const relativePath = relative(repository, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("task contract must be a committed file in the authorized repository");
  }

  await execa("git", ["-C", repository, "ls-files", "--error-unmatch", relativePath]);
  const status = await execa("git", [
    "-C",
    repository,
    "status",
    "--porcelain",
    "--",
    relativePath,
  ]);
  if (status.stdout !== "") throw new Error("task contract has uncommitted changes");
  await execa("git", ["-C", repository, "cat-file", "-e", `${contract.baseSha}^{commit}`]);
  await execa("git", ["-C", repository, "merge-base", "--is-ancestor", contract.baseSha, "HEAD"]);
  return repository;
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
    const current = await execa("git", ["-C", workspace, "rev-parse", "HEAD"]);
    await execa("git", [
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
  await execa("git", [
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

function codexCommand(binary: string, args: string[]): { executable: string; args: string[] } {
  return binary.endsWith(".mjs")
    ? { executable: process.execPath, args: [binary, ...args] }
    : { executable: binary, args };
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

async function runImplementer(
  input: WorkflowInput,
  activation: number,
  findings: string[],
  previousSha: string,
): Promise<ImplementerResult> {
  const workspace = await ensureWorktree(input);
  await execa("git", ["-C", workspace, "reset", "--hard", previousSha]);
  await execa("git", ["-C", workspace, "clean", "-fd"]);
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
    "Implement the following authorized task in this isolated workspace.",
    "Commit the complete change and leave the worktree clean.",
    `Instructions: ${input.contract.instructions}`,
    `Acceptance: ${input.contract.acceptance.join("; ")}`,
    `Non-goals: ${input.contract.nonGoals.join("; ")}`,
    ...(findings.length > 0 ? [`Aggregated review findings: ${findings.join("; ")}`] : []),
  ].join("\n");
  const binary = process.env.USINE_CODEX_BIN ?? "codex";
  const invocation = codexCommand(binary, [
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    "--sandbox",
    "workspace-write",
    "--approve-for-me",
    "-C",
    workspace,
    prompt,
  ]);
  const processResult = await execa(invocation.executable, invocation.args, {
    cwd: workspace,
    env: workerEnvironment("implementer"),
    extendEnv: false,
    reject: false,
    timeout: input.contract.budget.maxElapsedMs,
  });
  if (processResult.exitCode !== 0) {
    throw new Error(`implementer process failed: ${processResult.stderr}`);
  }
  const output = implementerOutputSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
  if (output.status === "blocked") throw new Error(`implementer blocked: ${output.summary}`);
  const status = await execa("git", ["-C", workspace, "status", "--porcelain"]);
  if (status.stdout !== "") throw new Error("implementer left uncommitted changes");
  const candidateSha = (await execa("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout;
  if (candidateSha === previousSha)
    throw new Error("implementer did not create a new candidate commit");
  await execa("git", [
    "-C",
    workspace,
    "merge-base",
    "--is-ancestor",
    input.contract.baseSha,
    candidateSha,
  ]);
  return {
    candidateSha,
    observation: {
      summary: output.summary,
      sessionId: sessionIdFromJsonl(processResult.stdout),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    },
  };
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
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
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
    await execa("git", ["-C", input.repository, "worktree", "remove", "--force", path]);
  } catch {
    await rm(path, { recursive: true, force: true });
  }
  await execa("git", ["-C", input.repository, "worktree", "add", "--detach", path, sha]);
  try {
    return await callback(path);
  } finally {
    await execa("git", ["-C", input.repository, "worktree", "remove", "--force", path]);
  }
}

async function runCheck(input: WorkflowInput, sha: string): Promise<CheckResult> {
  return withDisposableWorktree(input, `check-${sha}`, sha, async (path) => {
    const result = await execa("sh", ["-c", input.contract.projectCheck.command], {
      cwd: path,
      env: projectCheckEnvironment(),
      extendEnv: false,
      reject: false,
      timeout: input.contract.projectCheck.timeoutMs,
    });
    return {
      sha,
      status: result.exitCode === 0 ? "passed" : "failed",
      command: input.contract.projectCheck.command,
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
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
    const schemaPath = resolve(input.stateDirectory, "schemas", "reviewer.json");
    const outputPath = resolve(
      input.stateDirectory,
      "observations",
      `${input.contract.id}-reviewer-${cycle}.json`,
    );
    await mkdir(dirname(schemaPath), { recursive: true });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(schemaPath, JSON.stringify(reviewerJsonSchema));
    const prompt = [
      "Role: reviewer.",
      "Independently review this exact candidate against the authorized contract.",
      `Candidate SHA: ${sha}`,
      `Contract: ${JSON.stringify(input.contract)}`,
      `Check evidence: ${JSON.stringify(check)}`,
      "Return an explicit exact-SHA verdict. Process success alone is not approval.",
    ].join("\n");
    const binary = process.env.USINE_CODEX_BIN ?? "codex";
    const invocation = codexCommand(binary, [
      "exec",
      "--ephemeral",
      "--json",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      "--sandbox",
      "read-only",
      "-C",
      path,
      prompt,
    ]);
    const processResult = await execa(invocation.executable, invocation.args, {
      cwd: path,
      env: workerEnvironment("reviewer"),
      extendEnv: false,
      reject: false,
      timeout: input.contract.budget.maxElapsedMs,
    });
    if (processResult.exitCode !== 0) {
      return {
        sha,
        verdict: "inconclusive",
        summary: `reviewer process failed: ${processResult.stderr}`,
        findings: [],
      };
    }
    const review = reviewerOutputSchema.parse(JSON.parse(await readFile(outputPath, "utf8")));
    if (review.sha !== sha) throw new Error("review verdict names a stale candidate SHA");
    return review;
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
    try {
      const existing = JSON.parse(await readFile(counterPath, "utf8")) as {
        count: number;
        delivery: DeliveryResult;
      };
      if (existing.delivery.sha === sha) return existing.delivery;
    } catch {
      // A missing or incomplete record means the effect has not been confirmed.
    }
    await mkdir(dirname(counterPath), { recursive: true });
    await writeFile(counterPath, JSON.stringify({ count: 1, delivery }));
  }
  return delivery;
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

async function githubClient(): Promise<{ octokit: InstanceType<typeof Octokit>; token: string }> {
  const testToken = process.env.USINE_GITHUB_TEST_TOKEN;
  const apiUrl = process.env.USINE_GITHUB_API_URL;
  if (testToken) {
    if (!apiUrl || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(apiUrl)) {
      throw new Error("USINE_GITHUB_TEST_TOKEN is restricted to a loopback API URL");
    }
    return { octokit: new Octokit({ auth: testToken, baseUrl: apiUrl }), token: testToken };
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
  return { octokit, token: authentication.token };
}

async function githubDelivery(
  input: WorkflowInput,
  sha: string,
  check: CheckResult,
  review: ReviewResult,
): Promise<DeliveryResult> {
  const { owner, name: repo } = input.contract.repository;
  const { branch, baseBranch } = input.contract.delivery;
  const { octokit, token } = await githubClient();
  let expectedHead: string | null = null;
  try {
    const reference = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
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
      { env: environment },
    );
  }

  const pullRequests = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    base: baseBranch,
    state: "open",
    per_page: 100,
  });
  const existingPullRequest = pullRequests.data.find((pullRequest) => pullRequest.head.sha === sha);
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
      })
    ).data;
  const marker = `<!-- usine-approval:${input.contract.id}:${sha} -->`;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullRequest.number,
    per_page: 100,
  });
  const existingAttestation = comments.find((comment) => comment.body?.includes(marker));
  const attestation =
    existingAttestation ??
    (
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullRequest.number,
        body: [
          marker,
          "Usine exact-SHA semantic approval attestation",
          `- Candidate: \`${sha}\``,
          `- Project check: \`${check.command}\` (${check.status})`,
          `- Fresh reviewer verdict: \`${review.verdict}\``,
          `- Review summary: ${review.summary}`,
        ].join("\n"),
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
  return process.env.USINE_DELIVERY_MODE === "record"
    ? recordDelivery(input, sha)
    : githubDelivery(input, sha, check, review);
}

async function crashOnce(input: WorkflowInput, stage: "admitted" | "delivery"): Promise<boolean> {
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
  const repository = await verifyCommittedContract(contractPath, contract);
  await applyMigrations(databaseUrl);
  const stateDirectory = resolve(process.env.USINE_STATE_DIR ?? ".usine");
  const contractHash = createHash("sha256").update(rawContract).digest("hex");
  const repositoryIdentity =
    `${contract.repository.owner}/${contract.repository.name}`.toLowerCase();
  const input: WorkflowInput = {
    contract,
    contractHash,
    repository,
    repositoryIdentity,
    stateDirectory,
    deadlineEpochMs: Date.now() + contract.budget.maxElapsedMs,
    stopAfterAdmitted: process.env.USINE_STOP_AFTER === "admitted",
    crashAfterAdmitted: process.env.USINE_CRASH_AFTER === "admitted",
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
          const attempt = await DBOS.runStep(
            () => attemptImplementer(input, activation, findings, previousSha),
            { name: `implementer-${activation}` },
          );
          if (attempt.status === "failed") {
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
        const check = await DBOS.runStep(() => runCheck(input, implementation.candidateSha), {
          name: `check-${cycle}`,
        });
        result = await saveResult({ ...result, state: "checked", check });
        if (check.status !== "passed") {
          return saveResult({ ...result, state: "blocked", blocker: "project check failed" });
        }
        const review = await DBOS.runStep(
          () => runReviewer(input, implementation.candidateSha, check, cycle),
          { name: `review-${cycle}` },
        );
        result = await saveResult({
          ...result,
          state: "reviewed",
          review,
          evidence: { ...result.evidence, reviewCycles: cycle },
        });
        if (review.verdict === "approved") {
          const delivery = await DBOS.runStep(
            () => deliver(input, implementation.candidateSha, check, review),
            { name: "delivery" },
          );
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
    const handle = await DBOS.startWorkflow(workflow, {
      workflowID: contract.id,
      timeoutMS: contract.budget.maxElapsedMs,
    })(input);
    const result = await handle.getResult();
    await writeResultArtifact(stateDirectory, result);
    return result;
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}
