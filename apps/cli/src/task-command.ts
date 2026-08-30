import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import {
  followTask,
  getTask,
  listTasks,
  retryTask,
  submitTask,
  taskEvidence,
  taskEvents,
  taskStatus,
} from "./server-client.js";
import { CliFailure, notFoundFailure, runCommand } from "./cli-failure.js";
import { boundedLimitFlag, jsonFlag, naturalFlag } from "./cli-parameters.js";
import { renderTaskEvidence } from "./task-evidence.js";
import {
  renderEvent,
  renderJson,
  renderTask,
  renderTaskEvents,
  renderTaskList,
} from "./cli-renderer.js";

export interface TaskListOptions {
  readonly limit: number;
  readonly json: boolean;
}

export interface TaskEvidenceOptions {
  readonly taskId: string;
  readonly json: boolean;
}

export interface TaskGetOptions {
  readonly taskId: string;
  readonly json: boolean;
}

export interface TaskWatchOptions {
  readonly taskId: string;
  readonly after: number;
  readonly timeout: Option.Option<number>;
  readonly json: boolean;
}

export interface TaskHistoryOptions {
  readonly taskId: string;
  readonly after: number;
  readonly limit: number;
  readonly json: boolean;
}

export function taskCommand(serverUrl: string) {
  const list = Command.make(
    "list",
    {
      limit: boundedLimitFlag(100),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runTaskListCommand(options, serverUrl)),
  );

  const get = Command.make(
    "get",
    {
      taskId: Argument.string("task-id"),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runTaskGetCommand(options, serverUrl)),
  );

  const watch = Command.make(
    "watch",
    {
      taskId: Argument.string("task-id"),
      after: naturalFlag("after").pipe(Flag.withDefault(0)),
      timeout: naturalFlag("timeout").pipe(Flag.optional),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runTaskWatchCommand(options, serverUrl)),
  );

  const history = Command.make(
    "history",
    {
      taskId: Argument.string("task-id"),
      after: naturalFlag("after").pipe(Flag.withDefault(0)),
      limit: boundedLimitFlag(200),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runTaskHistoryCommand(options, serverUrl)),
  );

  const evidence = Command.make(
    "evidence",
    {
      taskId: Argument.string("task-id"),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runTaskEvidenceCommand(options, serverUrl)),
  );

  const retry = Command.make(
    "retry",
    { taskId: Argument.string("task-id"), json: jsonFlag() },
    (options) => Effect.promise(() => runTaskRetryCommand(options, serverUrl)),
  );

  return Command.make("task").pipe(
    Command.withSubcommands([list, get, watch, history, evidence, retry]),
  );
}

export function compatibilityTaskCommands(serverUrl: string) {
  const status = Command.make("status", { taskId: Argument.string("task-id") }, ({ taskId }) =>
    Effect.promise(() => runLegacyTaskStatus(taskId, serverUrl)),
  );

  const follow = Command.make("follow", { taskId: Argument.string("task-id") }, ({ taskId }) =>
    Effect.promise(() => runLegacyTaskFollow(taskId, serverUrl)),
  );

  const submit = Command.make(
    "submit",
    { contractPath: Argument.string("task-contract.json") },
    ({ contractPath }) => Effect.promise(() => runSubmitCommand(contractPath, serverUrl)),
  );

  return [status, follow, submit] as const;
}

export async function runTaskListCommand(
  options: TaskListOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("task_list_failed", async () => {
    const page = await listTasks(serverUrl, options.limit);
    process.stdout.write(renderTaskList(page, options.json));
  });
}

export async function runTaskGetCommand(options: TaskGetOptions, serverUrl: string): Promise<void> {
  return runCommand("task_get_failed", async () => {
    const task = await getTask(serverUrl, options.taskId);
    if (!task) throw notFoundFailure("task", "taskId", options.taskId);
    process.stdout.write(renderTask(task, options.json));
  });
}

export async function runTaskWatchCommand(
  options: TaskWatchOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("task_watch_failed", async () => {
    const task = await followTask(serverUrl, options.taskId, {
      afterSequence: options.after,
      timeoutMs: Option.getOrUndefined(options.timeout),
      onEvent: (event) => process.stderr.write(renderEvent(event)),
    });
    process.stdout.write(renderTask(task, options.json));
  });
}

export async function runTaskHistoryCommand(
  options: TaskHistoryOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("task_history_failed", async () => {
    const page = await taskEvents(serverUrl, options.taskId, options.after, options.limit);
    process.stdout.write(renderTaskEvents(page, options.after, options.json));
  });
}

export async function runTaskEvidenceCommand(
  options: TaskEvidenceOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("task_evidence_failed", async () => {
    const evidence = await taskEvidence(serverUrl, options.taskId);
    if (!evidence) throw notFoundFailure("task", "taskId", options.taskId);
    process.stdout.write(renderTaskEvidence(evidence, options.json));
  });
}

export async function runTaskRetryCommand(
  options: { readonly taskId: string; readonly json: boolean },
  serverUrl: string,
): Promise<void> {
  return runCommand("task_retry_failed", async () => {
    const task = await retryTask(serverUrl, options.taskId);
    process.stdout.write(renderTask(task, options.json));
  });
}

export async function runLegacyTaskStatus(taskId: string, serverUrl: string): Promise<void> {
  return runCommand("status_failed", async () => {
    const result = await taskStatus(serverUrl, taskId);
    if (!result) throw notFoundFailure("task", "taskId", taskId);
    process.stdout.write(renderJson(result));
  });
}

export async function runLegacyTaskFollow(taskId: string, serverUrl: string): Promise<void> {
  return runCommand("follow_failed", async () => {
    const result = await followTask(serverUrl, taskId, {
      onEvent: (event) => process.stderr.write(renderEvent(event)),
    });
    process.stdout.write(renderJson(result));
  });
}

export async function runSubmitCommand(contractPath: string, serverUrl: string): Promise<void> {
  return runCommand("submit_failed", async () => {
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
