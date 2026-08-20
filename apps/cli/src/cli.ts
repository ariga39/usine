#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import { repositoryRegistrationSchema } from "@usine/task-authority";
import { startUsineServer } from "@usine/runtime";
import {
  followTask,
  inspectRepository,
  registerRepository,
  serverUrlFromEnvironment,
  submitTask,
  taskStatus,
} from "./server-client.js";

export async function main(): Promise<void> {
  const [command, contractPath] = process.argv.slice(2);
  if (command === "server") {
    if (contractPath || process.argv.length > 3) {
      process.stderr.write(`${JSON.stringify({ error: "usage", usage: "usine server" })}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const server = await startUsineServer({
        environment: process.env,
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
      const result = await taskStatus(serverUrlFromEnvironment(process.env), contractPath);
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

  if (command === "inspect") {
    if (!contractPath || process.argv.length > 4) {
      process.stderr.write(
        `${JSON.stringify({ error: "usage", usage: "usine inspect <repository-id>" })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      const repository = await inspectRepository(
        serverUrlFromEnvironment(process.env),
        contractPath,
      );
      if (!repository) {
        process.stderr.write(
          `${JSON.stringify({ error: "repository_not_found", repositoryId: contractPath })}\n`,
        );
        process.exitCode = 3;
        return;
      }
      process.stdout.write(`${JSON.stringify(repository)}\n`);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ error: "inspect_failed", message: String(error) })}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "register") {
    if (!contractPath || process.argv.length > 4) {
      process.stderr.write(
        `${JSON.stringify({ error: "usage", usage: "usine register <repository.json>" })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      const input = JSON.parse(await readFile(contractPath, "utf8")) as unknown;
      const registration = repositoryRegistrationSchema.parse(input);
      const parsed = repositoryRegistrationSchema.parse({
        ...registration,
        path: await realpath(registration.path),
      });
      const repository = await registerRepository(serverUrlFromEnvironment(process.env), parsed);
      process.stdout.write(`${JSON.stringify(repository)}\n`);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ error: "register_failed", message: String(error) })}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command === "follow") {
    if (!contractPath || process.argv.length > 4) {
      process.stderr.write(
        `${JSON.stringify({ error: "usage", usage: "usine follow <task-id>" })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      const result = await followTask(serverUrlFromEnvironment(process.env), contractPath, {
        onProgress: (progress) => process.stderr.write(`${JSON.stringify(progress)}\n`),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ error: "follow_failed", message: String(error) })}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (command !== "submit" || !contractPath) {
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
    const result = await submitTask(serverUrlFromEnvironment(process.env), {
      contractPath: resolve(contractPath),
      repositoryId: parsed.data.repositoryId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: "submit_failed", message: String(error) })}\n`);
    process.exitCode = 1;
  }
}

await main();
