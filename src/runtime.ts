import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { DrizzleDataSource } from "@dbos-inc/drizzle-datasource";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { execa } from "execa";
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
  writer: { repository: string; generation: number };
}

interface WorkflowInput {
  contract: TaskContract;
  contractHash: string;
  repository: string;
  stateDirectory: string;
  stopAfterAdmitted: boolean;
}

interface ImplementerResult {
  candidateSha: string;
  observation: { summary: string; sessionId: string | null; stdout: string; stderr: string };
}

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

function workerEnvironment(role: "implementer" | "reviewer"): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, USINE_CODEX_ROLE: role };
  for (const key of Object.keys(environment)) {
    if (key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key.startsWith("USINE_GITHUB_")) {
      delete environment[key];
    }
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
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  } finally {
    await pool.end();
  }
  await DrizzleDataSource.initializeDBOSSchema({ connectionString: databaseUrl });
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

async function runImplementer(input: WorkflowInput): Promise<ImplementerResult> {
  const workspace = await ensureWorktree(input);
  const schemaPath = resolve(input.stateDirectory, "schemas", "implementer.json");
  const outputPath = resolve(
    input.stateDirectory,
    "observations",
    `${input.contract.id}-implementer.json`,
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
  if (candidateSha === input.contract.baseSha)
    throw new Error("implementer did not create a candidate commit");
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
  return withDisposableWorktree(input, "check-1", sha, async (path) => {
    const result = await execa("sh", ["-lc", input.contract.projectCheck.command], {
      cwd: path,
      env: workerEnvironment("implementer"),
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
): Promise<ReviewResult> {
  return withDisposableWorktree(input, "review-1", sha, async (path) => {
    const schemaPath = resolve(input.stateDirectory, "schemas", "reviewer.json");
    const outputPath = resolve(
      input.stateDirectory,
      "observations",
      `${input.contract.id}-reviewer.json`,
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
  if (process.env.USINE_DELIVERY_MODE !== "record") {
    throw new Error("GitHub delivery is not configured");
  }
  return {
    sha,
    effect: "recorded",
    prNumber: input.contract.delivery.issue,
    url: `record://${input.contract.repository.owner}/${input.contract.repository.name}/pull/${input.contract.delivery.issue}`,
    attestationId: `${input.contract.id}:${sha}`,
  };
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
  const input: WorkflowInput = {
    contract,
    contractHash,
    repository,
    stateDirectory,
    stopAfterAdmitted: process.env.USINE_STOP_AFTER === "admitted",
  };

  const dataSource = new DrizzleDataSource<UsineDatabase>(
    "usine-domain",
    { connectionString: databaseUrl },
    { repositoryLeases, taskRuns },
  );
  const admit = dataSource.registerTransaction(
    async (): Promise<TaskResult> => {
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
        .values({ repository, taskId: contract.id, generation: 1 })
        .onConflictDoNothing()
        .returning();
      const lease =
        insertedLease[0] ??
        (await dataSource.client.query.repositoryLeases.findFirst({
          where: and(
            eq(repositoryLeases.repository, repository),
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
        writer: { repository, generation: lease.generation },
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
    async (): Promise<TaskResult> => {
      let result = await admit();
      if (input.stopAfterAdmitted) return result;

      const implementation = await DBOS.runStep(() => runImplementer(input), {
        name: "implementer-1",
      });
      result = await saveResult({
        ...result,
        state: "candidate",
        candidateSha: implementation.candidateSha,
      });
      const check = await DBOS.runStep(() => runCheck(input, implementation.candidateSha), {
        name: "check-1",
      });
      result = await saveResult({ ...result, state: "checked", check });
      if (check.status !== "passed") {
        return saveResult({ ...result, state: "blocked", blocker: "project check failed" });
      }
      const review = await DBOS.runStep(
        () => runReviewer(input, implementation.candidateSha, check),
        { name: "review-1" },
      );
      result = await saveResult({ ...result, state: "reviewed", review });
      if (review.verdict !== "approved") {
        return saveResult({
          ...result,
          state: "blocked",
          blocker: `review ${review.verdict}: ${review.summary}`,
        });
      }
      const delivery = await DBOS.runStep(
        () => recordDelivery(input, implementation.candidateSha),
        {
          name: "delivery",
        },
      );
      return saveResult({ ...result, state: "reviewed_pr", delivery });
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
    })();
    const result = await handle.getResult();
    await writeResultArtifact(stateDirectory, result);
    return result;
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}
