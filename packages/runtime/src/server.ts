import { readFile, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect, Fiber, FiberMap } from "effect";
import {
  applyMigrations,
  contractIssues,
  openSqliteDatabase,
  TaskAuthority,
  isTaskStateQuarantinedError,
  taskContractSchema,
  type TaskContract,
  type TaskExecutionInput,
  type TaskResult,
} from "@usine/task-authority";
import {
  admitTask,
  executeAdmittedTask,
  lookupRestartableTasks,
  lookupTaskStatus,
  runtimePolicyFromEnvironment,
  stateDirectoryFromEnvironment,
  type RuntimePolicy,
} from "./runtime.js";

export interface TaskSubmission {
  contractPath: string;
  repositoryPath: string;
}

export interface ServerExecutionContext {
  input: TaskExecutionInput;
  contract: TaskContract;
  result: TaskResult;
  authority: TaskAuthority;
  policy: RuntimePolicy;
  signal: AbortSignal;
}

export type ServerExecution = (context: ServerExecutionContext) => Promise<TaskResult>;

export interface UsineServerOptions {
  environment: NodeJS.ProcessEnv;
  execute?: ServerExecution;
  host?: string;
  port?: number;
}

export interface RunningUsineServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface AdmittedTask {
  input: TaskExecutionInput;
  contract: TaskContract;
  result: TaskResult;
}

export async function startUsineServer(options: UsineServerOptions): Promise<RunningUsineServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!isLoopbackHost(host)) throw new Error("server host must be loopback");
  const urlHost = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  const stateDirectory = stateDirectoryFromEnvironment(options.environment);
  await mkdir(stateDirectory, { recursive: true });
  await applyMigrations(resolve(stateDirectory, "usine.sqlite"));

  let resolveReady: (server: RunningUsineServer) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<RunningUsineServer>((resolveReadyValue, reject) => {
    resolveReady = resolveReadyValue;
    rejectReady = reject;
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const runTask = yield* FiberMap.makeRuntime<never, string>();
      let launchTask: (task: AdmittedTask) => void = () => undefined;
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            listen(host, port, async (request, response) => {
              await handleRequest(request, response, options.environment, launchTask);
            }),
          catch: (cause) => new Error(`server failed to listen: ${String(cause)}`),
        }),
        (value) =>
          Effect.tryPromise({
            try: () => close(value),
            catch: (cause) => new Error(`server failed to close: ${String(cause)}`),
          }).pipe(Effect.ignore),
      );

      launchTask = (task) => {
        runTask(
          task.result.taskId,
          Effect.tryPromise({
            try: (signal) =>
              executeServerTask(task, options.environment, stateDirectory, options.execute, signal),
            catch: (cause) => cause,
          }).pipe(Effect.asVoid),
          { onlyIfMissing: true },
        );
      };

      const running: RunningUsineServer = {
        host,
        port: server.addressPort,
        url: `http://${urlHost}:${server.addressPort}`,
        close: async () => undefined,
      };
      const restartable = yield* Effect.tryPromise({
        try: () => lookupRestartableTasks(stateDirectory),
        catch: (cause) => cause,
      });
      for (const task of restartable) {
        try {
          const contract = parseContract(task.input.rawContract);
          launchTask({ input: task.input, contract, result: task.result });
        } catch (error) {
          try {
            yield* Effect.tryPromise({
              try: () => blockPersistedTask(stateDirectory, task.result.taskId, error),
              catch: (cause) => cause,
            });
          } catch {
            // A readable row remains isolated if its invalid input cannot be blocked.
          }
        }
      }
      resolveReady(running);
      yield* Effect.never;
    }),
  );
  const fiber = Effect.runFork(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => rejectReady(new Error(`server failed: ${String(cause)}`))),
      ),
    ),
  );
  const running = await ready;
  return {
    ...running,
    close: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

async function executeServerTask(
  task: AdmittedTask,
  environment: NodeJS.ProcessEnv,
  stateDirectory: string,
  execute: ServerExecution | undefined,
  signal: AbortSignal,
): Promise<TaskResult> {
  let policy: RuntimePolicy;
  try {
    policy = runtimePolicyFromEnvironment(environment, task.contract.repository);
  } catch (error) {
    return blockPersistedTask(stateDirectory, task.result.taskId, error);
  }
  if (!execute) {
    return executeAdmittedTask(task.input, task.contract, policy, undefined, signal);
  }

  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const handle = openSqliteDatabase(databasePath);
  const authority = new TaskAuthority(handle.database);
  try {
    const current = await authority.lookup(task.result.taskId);
    if (!current || current.state === "reviewed_pr" || current.state === "blocked") {
      return current ?? task.result;
    }
    try {
      return await execute({
        input: task.input,
        contract: task.contract,
        result: current,
        authority,
        policy,
        signal,
      });
    } catch (error) {
      const latest = await authority.lookup(current.taskId);
      if (!latest || latest.state === "reviewed_pr" || latest.state === "blocked") throw error;
      return await authority.block(
        { taskId: latest.taskId, revision: latest.revision },
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    handle.close();
  }
}

async function blockPersistedTask(
  stateDirectory: string,
  taskId: string,
  error: unknown,
): Promise<TaskResult> {
  const handle = openSqliteDatabase(resolve(stateDirectory, "usine.sqlite"));
  const authority = new TaskAuthority(handle.database);
  try {
    const current = await authority.lookup(taskId);
    if (!current) throw new Error(`cannot block missing task ${taskId}: ${String(error)}`);
    if (current.state === "reviewed_pr" || current.state === "blocked") return current;
    return await authority.block(
      { taskId: current.taskId, revision: current.revision },
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    handle.close();
  }
}

interface BoundServer {
  addressPort: number;
  close(callback: (error?: Error) => void): void;
}

function listen(
  host: string,
  port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<BoundServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void handler(request, response).catch((error) => {
        if (!response.headersSent) {
          response.statusCode = 500;
          writeJson(response, { message: String(error) });
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve({ addressPort: address.port, close: (callback) => server.close(callback) });
    });
  });
}

function close(server: BoundServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  environment: NodeJS.ProcessEnv,
  launch: (task: AdmittedTask) => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const taskId = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/)?.[1];
  const stateDirectory = stateDirectoryFromEnvironment(environment);
  if (request.method === "GET" && taskId) {
    const requestedTaskId = decodeURIComponent(taskId);
    let result: TaskResult | null;
    try {
      result = await lookupTaskStatus(stateDirectory, requestedTaskId);
    } catch (error) {
      if (isTaskStateQuarantinedError(error)) {
        response.statusCode = 503;
        writeJson(response, { taskId: requestedTaskId, error: error.code });
        return;
      }
      throw error;
    }
    if (!result) {
      response.statusCode = 404;
      writeJson(response, { message: "task not found" });
      return;
    }
    writeJson(response, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/tasks") {
    const submission = parseSubmission(await readBody(request));
    const rawContract = await readFile(submission.contractPath, "utf8");
    const contract = parseContract(rawContract);
    const policy = runtimePolicyFromEnvironment(environment, contract.repository);
    const result = await admitTask(
      submission.contractPath,
      submission.repositoryPath,
      rawContract,
      contract,
      policy,
    );
    if (result.state !== "reviewed_pr" && result.state !== "blocked") {
      launch({
        input: { ...submission, rawContract },
        contract,
        result,
      });
    }
    writeJson(response, result);
    return;
  }

  response.statusCode = 404;
  writeJson(response, { message: "route not found" });
}

function parseSubmission(body: string): TaskSubmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("request body must be JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("contractPath" in parsed) ||
    typeof parsed.contractPath !== "string" ||
    !("repositoryPath" in parsed) ||
    typeof parsed.repositoryPath !== "string"
  ) {
    throw new Error("task submission shape is invalid");
  }
  return { contractPath: parsed.contractPath, repositoryPath: parsed.repositoryPath };
}

function parseContract(rawContract: string): TaskContract {
  let input: unknown;
  try {
    input = JSON.parse(rawContract);
  } catch {
    throw new Error("task contract must be JSON");
  }
  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid task contract: ${JSON.stringify(contractIssues(parsed.error))}`);
  }
  return parsed.data;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("request body is too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
