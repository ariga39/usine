#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import { runtimePolicyFromEnvironment, startUsineServer } from "@usine/runtime";
import { submitTask, taskStatus } from "./server-client.js";

export async function main(): Promise<void> {
  const [command, contractPath] = process.argv.slice(2);
  if (command === "server") {
    if (contractPath || process.argv.length > 3) {
      process.stderr.write(`${JSON.stringify({ error: "usage", usage: "usine server" })}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const policy = runtimePolicyFromEnvironment(process.env, {
        owner: process.env.USINE_REPOSITORY_OWNER?.trim() || "local",
        name: process.env.USINE_REPOSITORY_NAME?.trim() || "local",
      });
      const server = await startUsineServer({
        policy,
        host: process.env.USINE_SERVER_HOST?.trim() || "127.0.0.1",
        port: Number(process.env.USINE_SERVER_PORT || 8787),
      });
      process.stdout.write(`${JSON.stringify({ event: "server_ready", url: server.url })}\n`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await server.close();
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ error: "server_failed", message: String(error) })}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "status") {
    if (!contractPath || process.argv.length > 4) {
      process.stderr.write(
        `${JSON.stringify({ error: "usage", usage: "usine status <task-id>" })}\n`,
      );
      process.exitCode = 2;
      return;
    }

    try {
      const result = await taskStatus(serverUrl(), contractPath);
      if (!result) {
        process.stderr.write(
          `${JSON.stringify({ error: "task_not_found", taskId: contractPath })}\n`,
        );
        process.exitCode = 3;
        return;
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ error: "status_failed", message: String(error) })}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if ((command !== "run" && command !== "submit") || !contractPath) {
    process.stderr.write(
      `${JSON.stringify({ error: "usage", usage: "usine submit <task-contract.json>" })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  let input: unknown;
  let rawContract: string;
  try {
    rawContract = await readFile(contractPath, "utf8");
    input = JSON.parse(rawContract);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: "invalid_task_contract", issues: [{ path: "", message: String(error) }] })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    process.stderr.write(
      `${JSON.stringify({ error: "invalid_task_contract", issues: contractIssues(parsed.error) })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = await submitTask(serverUrl(), {
      contractPath: resolve(contractPath),
      repositoryPath: await realpath(parsed.data.repository.path),
      rawContract,
      contract: parsed.data,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: "run_failed", message: String(error) })}\n`);
    process.exitCode = 1;
  }
}

function serverUrl(): string {
  return process.env.USINE_SERVER_URL?.trim() || "http://127.0.0.1:8787";
}

await main();
