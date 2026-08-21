#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import { repositoryRegistrationSchema } from "@usine/task-authority";
import { createRuntimeExecutionAdapter, startUsineServer } from "@usine/runtime";
import {
  followTask,
  getTask,
  inspectRepository,
  listTasks,
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
        executionAdapter: createRuntimeExecutionAdapter(process.env),
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

  if (command === "task") {
    await runTaskCommand(process.argv.slice(3));
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
        onEvent: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
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

async function runTaskCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const json = rest.includes("--json");
  const values = rest.filter((value) => value !== "--json");
  const serverUrl = serverUrlFromEnvironment(process.env);

  if (operation === "list" && values.length === 0) {
    try {
      const page = await listTasks(serverUrl);
      if (json) process.stdout.write(`${JSON.stringify(page)}\n`);
      else {
        process.stdout.write("TASK ID\tSTATE\tREVISION\n");
        for (const task of page.tasks)
          process.stdout.write(`${task.taskId}\t${task.state}\t${task.revision}\n`);
      }
    } catch (error) {
      taskCommandFailure("task_list_failed", error);
    }
    return;
  }

  if (operation === "get") {
    const taskId = values.length === 1 ? values[0] : undefined;
    if (!taskId) return taskUsage("usine task get <task-id> [--json]");
    try {
      const task = await getTask(serverUrl, taskId);
      if (!task) {
        process.stderr.write(`${JSON.stringify({ error: "task_not_found", taskId })}\n`);
        process.exitCode = 3;
        return;
      }
      if (json) process.stdout.write(`${JSON.stringify(task)}\n`);
      else process.stdout.write(`Task ${task.taskId}: ${task.state} (revision ${task.revision})\n`);
    } catch (error) {
      taskCommandFailure("task_get_failed", error);
    }
    return;
  }

  if (operation === "watch") {
    const taskId = values[0];
    const afterIndex = values.indexOf("--after");
    const timeoutIndex = values.indexOf("--timeout");
    const optionIndices = new Set<number>();
    for (const index of [afterIndex, timeoutIndex]) {
      if (index >= 0) {
        optionIndices.add(index);
        optionIndices.add(index + 1);
      }
    }
    const positional = values.filter((_, index) => !optionIndices.has(index));
    if (
      !taskId ||
      positional.length !== 1 ||
      (afterIndex >= 0 && !values[afterIndex + 1]) ||
      (timeoutIndex >= 0 && !values[timeoutIndex + 1])
    ) {
      return taskUsage("usine task watch <task-id> [--after <sequence>] [--timeout <ms>] [--json]");
    }
    const afterSequence = afterIndex < 0 ? 0 : parseTaskNumber(values[afterIndex + 1], "after");
    const timeoutMs =
      timeoutIndex < 0 ? undefined : parseTaskNumber(values[timeoutIndex + 1], "timeout");
    if (afterSequence === null || timeoutMs === null) return;
    try {
      const task = await followTask(serverUrl, taskId, {
        afterSequence,
        timeoutMs,
        onEvent: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
      });
      if (json) process.stdout.write(`${JSON.stringify(task)}\n`);
      else process.stdout.write(`Task ${task.taskId}: ${task.state} (revision ${task.revision})\n`);
    } catch (error) {
      taskCommandFailure("task_watch_failed", error);
    }
    return;
  }

  taskUsage("usine task <list|get|watch> ...");
}

function parseTaskNumber(value: string | undefined, name: string): number | null {
  if (!value || !/^\d+$/.test(value)) {
    taskUsage(`usine task watch <task-id> [--${name} <number>]`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    taskUsage(`usine task watch <task-id> [--${name} <number>]`);
    return null;
  }
  return parsed;
}

function taskUsage(usage: string): void {
  process.stderr.write(`${JSON.stringify({ error: "usage", usage })}\n`);
  process.exitCode = 2;
}

function taskCommandFailure(error: string, cause: unknown): void {
  process.stderr.write(`${JSON.stringify({ error, message: String(cause) })}\n`);
  process.exitCode = 1;
}
