import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import {
  followTask,
  getTask,
  listTasks,
  submitTask,
  taskEvents,
  taskStatus,
} from "./server-client.js";
import { CliFailure, notFoundFailure, runCommand, usageFailure } from "./cli-failure.js";
import {
  optionIndex,
  parseBoundedLimit,
  parseNonNegativeNumber,
  parseOptions,
  withoutOption,
} from "./cli-options.js";
import {
  renderEvent,
  renderJson,
  renderTask,
  renderTaskEvents,
  renderTaskList,
} from "./cli-renderer.js";

export async function runTaskCommand(args: string[], serverUrl: string): Promise<void> {
  const [operation, ...rest] = args;
  const options = parseOptions(rest);

  if (operation === "list") {
    return runCommand("task_list_failed", async () => {
      const limitIndex = optionIndex(options.values, "--limit");
      const values = limitIndex < 0 ? options.values : withoutOption(options.values, limitIndex);
      if (values.length > 0 || (limitIndex >= 0 && !options.values[limitIndex + 1]))
        throw usageFailure("usine task list [--limit <count>] [--json]");
      const limit =
        limitIndex < 0
          ? 100
          : parseBoundedLimit(
              options.values[limitIndex + 1],
              "usine task list [--limit <count>] [--json]",
            );
      const page = await listTasks(serverUrl, limit);
      process.stdout.write(renderTaskList(page, options.json));
    });
  }

  if (operation === "get") {
    return runCommand("task_get_failed", async () => {
      if (options.values.length !== 1) throw usageFailure("usine task get <task-id> [--json]");
      const taskId = options.values[0]!;
      const task = await getTask(serverUrl, taskId);
      if (!task) throw notFoundFailure("task", "taskId", taskId);
      process.stdout.write(renderTask(task, options.json));
    });
  }

  if (operation === "watch") {
    return runCommand("task_watch_failed", async () => {
      const taskId = options.values[0];
      const afterIndex = optionIndex(options.values, "--after");
      const timeoutIndex = optionIndex(options.values, "--timeout");
      const optionIndices = [afterIndex, timeoutIndex].flatMap((index) =>
        index < 0 ? [] : [index, index + 1],
      );
      const values = options.values.filter((_, index) => !optionIndices.includes(index));
      if (
        !taskId ||
        values.length !== 1 ||
        (afterIndex >= 0 && !options.values[afterIndex + 1]) ||
        (timeoutIndex >= 0 && !options.values[timeoutIndex + 1])
      )
        throw usageFailure(
          "usine task watch <task-id> [--after <sequence>] [--timeout <ms>] [--json]",
        );
      const afterSequence =
        afterIndex < 0
          ? 0
          : parseNonNegativeNumber(
              options.values[afterIndex + 1],
              "usine task watch <task-id> [--after <number>]",
            );
      const timeoutMs =
        timeoutIndex < 0
          ? undefined
          : parseNonNegativeNumber(
              options.values[timeoutIndex + 1],
              "usine task watch <task-id> [--timeout <number>]",
            );
      const task = await followTask(serverUrl, taskId, {
        afterSequence,
        timeoutMs,
        onEvent: (event) => process.stderr.write(renderEvent(event)),
      });
      process.stdout.write(renderTask(task, options.json));
    });
  }

  if (operation === "history") {
    return runCommand("task_history_failed", async () => {
      const taskId = options.values[0];
      const afterIndex = optionIndex(options.values, "--after");
      const limitIndex = optionIndex(options.values, "--limit");
      const optionIndices = [afterIndex, limitIndex].flatMap((index) =>
        index < 0 ? [] : [index, index + 1],
      );
      const values = options.values.filter((_, index) => !optionIndices.includes(index));
      const usage = "usine task history <task-id> [--after <sequence>] [--limit <count>] [--json]";
      if (
        !taskId ||
        values.length !== 1 ||
        (afterIndex >= 0 && !options.values[afterIndex + 1]) ||
        (limitIndex >= 0 && !options.values[limitIndex + 1])
      )
        throw usageFailure(usage);
      const afterSequence =
        afterIndex < 0
          ? 0
          : parseNonNegativeNumber(
              options.values[afterIndex + 1],
              "usine task watch <task-id> [--after <number>]",
            );
      const limit =
        limitIndex < 0
          ? 200
          : parseNonNegativeNumber(
              options.values[limitIndex + 1],
              "usine task watch <task-id> [--limit <number>]",
            );
      if (limit < 1 || limit > 200) throw usageFailure(usage);
      const page = await taskEvents(serverUrl, taskId, afterSequence, limit);
      process.stdout.write(renderTaskEvents(page, afterSequence, options.json));
    });
  }

  throw usageFailure("usine task <list|get|watch|history> ...");
}

export async function runLegacyTaskStatus(args: string[], serverUrl: string): Promise<void> {
  return runCommand("status_failed", async () => {
    if (args.length !== 1) throw usageFailure("usine status <task-id>");
    const taskId = args[0]!;
    const result = await taskStatus(serverUrl, taskId);
    if (!result) throw notFoundFailure("task", "taskId", taskId);
    process.stdout.write(renderJson(result));
  });
}

export async function runLegacyTaskFollow(args: string[], serverUrl: string): Promise<void> {
  return runCommand("follow_failed", async () => {
    if (args.length !== 1) throw usageFailure("usine follow <task-id>");
    const result = await followTask(serverUrl, args[0]!, {
      onEvent: (event) => process.stderr.write(renderEvent(event)),
    });
    process.stdout.write(renderJson(result));
  });
}

export async function runSubmitCommand(args: string[], serverUrl: string): Promise<void> {
  return runCommand("submit_failed", async () => {
    if (args.length !== 1) throw usageFailure("usine submit <task-contract.json>");
    const contractPath = args[0]!;
    let input: unknown;
    try {
      input = JSON.parse(await readFile(contractPath, "utf8"));
    } catch {
      throw new CliFailure("invalid_task_contract", "validation", {
        issues: [{ path: "", message: "contract input is unreadable or invalid JSON" }],
      });
    }
    const parsed = taskContractSchema.safeParse(input);
    if (!parsed.success)
      throw new CliFailure("invalid_task_contract", "validation", {
        issues: contractIssues(parsed.error),
      });
    const result = await submitTask(serverUrl, {
      contractPath: resolve(contractPath),
      repositoryId: parsed.data.repositoryId,
    });
    process.stdout.write(renderJson(result));
  });
}
