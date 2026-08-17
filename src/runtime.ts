import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { DrizzleDataSource } from "@dbos-inc/drizzle-datasource";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { execa } from "execa";
import { Pool } from "pg";
import type { TaskContract } from "./contract.js";
import { repositoryLeases, taskRuns } from "./schema.js";

interface AdmittedResult {
  taskId: string;
  contractHash: string;
  state: "admitted";
  candidateSha: null;
  check: null;
  review: null;
  delivery: null;
  blocker: null;
  writer: { repository: string; generation: number };
}

type UsineDatabase = NodePgDatabase<{
  repositoryLeases: typeof repositoryLeases;
  taskRuns: typeof taskRuns;
}>;

async function verifyCommittedContract(
  contractPath: string,
  contract: TaskContract,
): Promise<void> {
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

export async function admitTask(
  contractPath: string,
  rawContract: string,
  contract: TaskContract,
): Promise<AdmittedResult> {
  const databaseUrl = process.env.USINE_DATABASE_URL;
  if (!databaseUrl) throw new Error("USINE_DATABASE_URL is required");
  await verifyCommittedContract(contractPath, contract);
  await applyMigrations(databaseUrl);

  const dataSource = new DrizzleDataSource<UsineDatabase>(
    "usine-domain",
    { connectionString: databaseUrl },
    { repositoryLeases, taskRuns },
  );
  const contractHash = createHash("sha256").update(rawContract).digest("hex");
  const repository = await realpath(contract.repository.path);

  const admit = dataSource.registerTransaction(
    async (): Promise<AdmittedResult> => {
      const existing = await dataSource.client.query.taskRuns.findFirst({
        where: eq(taskRuns.taskId, contract.id),
      });
      if (existing) {
        if (existing.contractHash !== contractHash)
          throw new Error("admitted contract is immutable");
        return existing.result as AdmittedResult;
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

      const result: AdmittedResult = {
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

  DBOS.setConfig({
    name: "usine",
    systemDatabaseUrl: databaseUrl,
    applicationVersion: "0.1.0",
    logLevel: "warn",
  });
  await DBOS.launch();
  try {
    const result = await admit();
    const resultPath = resolve(
      process.env.USINE_STATE_DIR ?? ".usine",
      "results",
      `${contract.id}.json`,
    );
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "w" });
    return result;
  } finally {
    await DBOS.shutdown({ deregister: true });
  }
}
