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
  listRepositories,
  listTasks,
  registerRepository,
  serverUrlFromEnvironment,
  serverHealth,
  serverSnapshot,
  submitTask,
  taskEvents,
  taskStatus,
} from "./server-client.js";

export async function main(): Promise<void> {
  const [command, contractPath] = process.argv.slice(2);
  if (command === "server" && (contractPath === "health" || contractPath === "snapshot")) {
    await runServerReadCommand(process.argv.slice(3));
    return;
  }
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
      taskCommandFailure("server_failed", error, "server");
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
      taskCommandFailure("status_failed", error);
    }
    return;
  }

  if (command === "task") {
    await runTaskCommand(process.argv.slice(3));
    return;
  }

  if (command === "repository") {
    await runRepositoryCommand(process.argv.slice(3));
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
      taskCommandFailure("inspect_failed", error);
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
      taskCommandFailure("register_failed", error, "validation");
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
      taskCommandFailure("follow_failed", error);
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
  } catch {
    process.stderr.write(
      `${JSON.stringify({ error: "invalid_task_contract", issues: [{ path: "", message: "contract input is unreadable or invalid JSON" }] })}\n`,
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
    taskCommandFailure("submit_failed", error);
  }
}

await main();

async function runTaskCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const json = rest.includes("--json");
  const values = rest.filter((value) => value !== "--json");
  const serverUrl = serverUrlFromEnvironment(process.env);

  if (operation === "list") {
    const limitIndex = values.indexOf("--limit");
    const positional =
      limitIndex < 0
        ? values
        : values.filter((_, index) => index !== limitIndex && index !== limitIndex + 1);
    if (positional.length > 0 || (limitIndex >= 0 && !values[limitIndex + 1]))
      return taskUsage("usine task list [--limit <count>] [--json]");
    const limit =
      limitIndex < 0
        ? 100
        : parseBoundedLimit(values[limitIndex + 1], "usine task list [--limit <count>] [--json]");
    if (limit === null) return;
    try {
      const page = await listTasks(serverUrl, limit);
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

  if (operation === "history") {
    const taskId = values[0];
    const afterIndex = values.indexOf("--after");
    const limitIndex = values.indexOf("--limit");
    const optionIndices = new Set<number>();
    for (const index of [afterIndex, limitIndex]) {
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
      (limitIndex >= 0 && !values[limitIndex + 1])
    )
      return taskUsage(
        "usine task history <task-id> [--after <sequence>] [--limit <count>] [--json]",
      );
    const afterSequence = afterIndex < 0 ? 0 : parseTaskNumber(values[afterIndex + 1], "after");
    const limit = limitIndex < 0 ? 200 : parseTaskNumber(values[limitIndex + 1], "limit");
    if (afterSequence === null || limit === null || limit < 1 || limit > 200)
      return taskUsage(
        "usine task history <task-id> [--after <sequence>] [--limit <count>] [--json]",
      );
    try {
      const page = await taskEvents(serverUrl, taskId, afterSequence, limit);
      if (json) process.stdout.write(`${JSON.stringify(page)}\n`);
      else {
        process.stdout.write(`Task ${page.taskId} events after ${afterSequence}:\n`);
        for (const event of page.events)
          process.stdout.write(`#${event.sequence}\t${event.data.type}\n`);
      }
    } catch (error) {
      taskCommandFailure("task_history_failed", error);
    }
    return;
  }

  taskUsage("usine task <list|get|watch|history> ...");
}

async function runRepositoryCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const json = rest.includes("--json");
  const values = rest.filter((value) => value !== "--json");
  const serverUrl = serverUrlFromEnvironment(process.env);

  if (operation === "list") {
    const limitIndex = values.indexOf("--limit");
    const positional =
      limitIndex < 0
        ? values
        : values.filter((_, index) => index !== limitIndex && index !== limitIndex + 1);
    if (positional.length > 0 || (limitIndex >= 0 && !values[limitIndex + 1]))
      return taskUsage("usine repository list [--limit <count>] [--json]");
    const limit =
      limitIndex < 0
        ? 100
        : parseBoundedLimit(
            values[limitIndex + 1],
            "usine repository list [--limit <count>] [--json]",
          );
    if (limit === null) return;
    try {
      const page = await listRepositories(serverUrl, limit);
      if (json) process.stdout.write(`${JSON.stringify(page)}\n`);
      else {
        process.stdout.write("REPOSITORY ID\tOWNER/NAME\tREVISION\n");
        for (const repository of page.repositories)
          process.stdout.write(
            `${repository.id}\t${repository.owner}/${repository.name}\t${repository.revision}\n`,
          );
      }
    } catch (error) {
      taskCommandFailure("repository_list_failed", error);
    }
    return;
  }

  if (operation === "get") {
    const repositoryId = values.length === 1 ? values[0] : undefined;
    if (!repositoryId) return taskUsage("usine repository get <repository-id> [--json]");
    try {
      const repository = await inspectRepository(serverUrl, repositoryId);
      if (!repository) {
        process.stderr.write(
          `${JSON.stringify({ error: "repository_not_found", repositoryId })}\n`,
        );
        process.exitCode = 3;
        return;
      }
      if (json) process.stdout.write(`${JSON.stringify(repository)}\n`);
      else
        process.stdout.write(
          `Repository ${repository.id}: ${repository.owner}/${repository.name} (revision ${repository.revision})\n`,
        );
    } catch (error) {
      taskCommandFailure("repository_get_failed", error);
    }
    return;
  }

  taskUsage("usine repository <list|get> ...");
}

async function runServerReadCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const json = rest.includes("--json");
  const values = rest.filter((value) => value !== "--json");
  const limitIndex = values.indexOf("--limit");
  const positional =
    limitIndex < 0
      ? values
      : values.filter((_, index) => index !== limitIndex && index !== limitIndex + 1);
  if (
    !operation ||
    (operation === "health" && values.length > 0) ||
    (operation !== "health" &&
      (positional.length > 0 || (limitIndex >= 0 && !values[limitIndex + 1])))
  ) {
    return taskUsage("usine server <health|snapshot> [--json]");
  }
  try {
    const url = serverUrlFromEnvironment(process.env);
    if (operation === "health") {
      const health = await serverHealth(url);
      if (json) process.stdout.write(`${JSON.stringify(health)}\n`);
      else process.stdout.write(`Server: ${health.status} (revision ${health.revision})\n`);
      return;
    }
    if (operation === "snapshot") {
      const limit =
        limitIndex < 0
          ? 100
          : parseBoundedLimit(
              values[limitIndex + 1],
              "usine server snapshot [--limit <count>] [--json]",
            );
      if (limit === null) return;
      const snapshot = await serverSnapshot(url, limit);
      if (json) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      else {
        process.stdout.write(`Server: ${snapshot.server.status} (revision ${snapshot.revision})\n`);
        process.stdout.write(`Repositories: ${snapshot.repositories.length}\n`);
        process.stdout.write(`Tasks: ${snapshot.tasks.length}\n`);
        process.stdout.write(`Coding sessions: ${snapshot.codingSessions.length}\n`);
      }
      return;
    }
    return taskUsage("usine server <health|snapshot> [--json]");
  } catch (error) {
    taskCommandFailure(`server_${operation}_failed`, error);
  }
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

function parseBoundedLimit(value: string | undefined, usage: string): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return taskUsageAndNull(usage);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    return taskUsageAndNull(usage);
  }
  return parsed;
}

function taskUsageAndNull(usage: string): null {
  taskUsage(usage);
  return null;
}

function taskUsage(usage: string): void {
  process.stderr.write(`${JSON.stringify({ error: "usage", usage })}\n`);
  process.exitCode = 2;
}

function taskCommandFailure(
  error: string,
  cause: unknown,
  forcedKind?: "validation" | "server",
): void {
  const typed =
    cause instanceof Error && "kind" in cause ? (cause as { kind?: string }) : undefined;
  const kind = forcedKind ?? (typed?.kind as string | undefined) ?? "server";
  const diagnostic =
    cause instanceof Error && "diagnostic" in cause
      ? (cause as { diagnostic?: string }).diagnostic
      : undefined;
  process.stderr.write(
    `${JSON.stringify({ error: diagnostic ?? error, kind, message: failureMessage(cause) })}\n`,
  );
  process.exitCode = exitCodeForKind(kind);
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && "kind" in cause) return cause.message;
  return "operation failed";
}

function exitCodeForKind(kind: string): number {
  if (kind === "not_found") return 3;
  if (kind === "timeout") return 4;
  if (kind === "connection") return 5;
  if (kind === "server") return 6;
  return 2;
}
