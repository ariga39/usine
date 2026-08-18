import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { applyMigrations } from "../packages/runtime/src/apply-migrations.js";

const childSource = String.raw`
import { writeFile } from "node:fs/promises";
import { drizzle } from "./packages/runtime/node_modules/drizzle-orm/node-postgres/index.js";
import pg from "./packages/runtime/node_modules/pg/esm/index.mjs";
import { executeDeliveryRun } from "./packages/runtime/dist/delivery-run.mjs";
import { TaskAuthority } from "./packages/runtime/dist/task-authority.mjs";
import { repositoryLeases, taskRuns } from "./packages/runtime/dist/schema.mjs";

const marker = process.env.USINE_RECOVERY_MARKER;
const mode = process.env.USINE_RECOVERY_MODE;
const taskId = process.env.USINE_RECOVERY_TASK;
const databaseUrl = process.env.USINE_TEST_DATABASE_URL;
if (!marker || !taskId || !databaseUrl) throw new Error("recovery test environment is incomplete");
const baseSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const contract = {
  id: taskId,
  repository: { path: ".", owner: "recovery", name: taskId },
  baseSha,
  instructions: "exercise restart recovery",
  acceptance: ["one candidate"],
  nonGoals: [],
  projectCheck: { command: "true", timeoutMs: 1000 },
  budget: { maxImplementerActivations: 2, maxReviewCycles: 1, maxElapsedMs: 60000 },
  authorization: { source: "recovery test", delivery: true },
  delivery: { baseBranch: "main", branch: "agent/recovery", issue: 1, title: "recovery", body: "recovery" },
};
const pool = new pg.Pool({ connectionString: databaseUrl });
const database = drizzle(pool, { schema: { repositoryLeases, taskRuns } });
const authority = new TaskAuthority(database);
const workspace = {
  quarantinePriorWriters: async (_taskId, activation) => {
    if (activation > 1) await writeFile(marker, "prior writer quarantined\\n");
  },
  prepareWriter: async (_taskId, activation, parent) => ({ taskId, activation, fence: activation, path: ".", baseSha: parent }),
  freeze: async (writer, parent) => ({ sha: nextSha, baseSha: parent, workspace: writer }),
  quarantine: async () => undefined,
};
const session = {
  run: async () => {
    if (mode === "kill") {
      await writeFile(marker, "activation durable and session started\\n");
      await new Promise(() => undefined);
    }
    return { status: "completed", sessionId: "recovery", output: { status: "proposed", summary: "candidate" }, usage: null, summary: "done", failure: null };
  },
};
const quality = {
  evaluate: async (_contract, sha) => ({
    check: { sha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
    review: { sha, verdict: "approved", summary: "approved", findings: [] },
  }),
};
const forge = { deliver: async (_contract, sha) => ({ sha, effect: "github", prNumber: 1, url: "https://example.invalid/pr/1", attestationId: "recovery" }) };
const result = await executeDeliveryRun(
  {
    contract,
    contractHash: "recovery-hash",
    repository: ".",
    repositoryIdentity: "recovery/" + taskId,
    deadlineEpochMs: Date.now() + 60000,
    implementerModel: "test",
    reviewerModel: "test",
    reviewerReasoningEffort: "low",
    stopAfterAdmitted: false,
  },
  { authority, workspace, session, quality, forge },
);
let staleRejected = false;
try {
  await authority.save({ ...result, state: "candidate", candidateSha: "c".repeat(40), candidateFence: 1 });
} catch {
  staleRejected = true;
}
if (!staleRejected) throw new Error("stale candidate was accepted");
await writeFile(marker + ".result", JSON.stringify(result));
console.log(JSON.stringify({ ...result, staleRejected }));
await pool.end();
`;

describe("PostgreSQL coordinator restart recovery", () => {
  test.runIf(Boolean(process.env.USINE_TEST_DATABASE_URL))(
    "fences a killed activation and resumes with one accepted candidate",
    async () => {
      await applyMigrations(process.env.USINE_TEST_DATABASE_URL!);
      const directory = await mkdtemp(join(tmpdir(), "usine-recovery-"));
      const marker = join(directory, "marker");
      const taskId = `recovery-${Date.now()}`;
      const env = {
        ...process.env,
        USINE_RECOVERY_MARKER: marker,
        USINE_RECOVERY_TASK: taskId,
        USINE_TEST_DATABASE_URL: process.env.USINE_TEST_DATABASE_URL,
      };
      const first = execa("node", ["--input-type=module", "-e", childSource], {
        env: { ...env, USINE_RECOVERY_MODE: "kill" },
        reject: false,
      });
      let started = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await readFile(marker, "utf8")).includes("session started")) {
            started = true;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (!started) {
        const failed = await first;
        throw new Error(`recovery child failed: ${failed.stderr}`);
      }
      if (!first.pid) throw new Error("recovery child did not expose a process id");
      process.kill(first.pid, "SIGKILL");
      await first;
      const second = await execa("node", ["--input-type=module", "-e", childSource], {
        env: { ...env, USINE_RECOVERY_MODE: "resume" },
      });
      const result = JSON.parse(second.stdout) as {
        state: string;
        candidateSha: string;
        evidence: { implementerActivations: number; restartRecoveries: number };
        staleRejected: boolean;
      };
      expect(result).toMatchObject({
        state: "reviewed_pr",
        candidateSha: "b".repeat(40),
        evidence: { implementerActivations: 2, restartRecoveries: 1 },
        staleRejected: true,
      });
      expect(await readFile(marker, "utf8")).toContain("prior writer quarantined");
    },
    30_000,
  );
});
