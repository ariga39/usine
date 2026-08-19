import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { Effect, Fiber, FiberMap } from "effect";
import { contractIssues, taskContractSchema, type TaskContract } from "@usine/task-authority";
import { admitTask, executeAdmittedTask, lookupTaskStatus, type RuntimePolicy } from "./runtime.js";

export interface TaskSubmission {
  contractPath: string;
  repositoryPath: string;
  rawContract: string;
  contract: TaskContract;
}

export interface UsineServerOptions {
  policy: RuntimePolicy;
  host?: string;
  port?: number;
}

export interface RunningUsineServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startUsineServer(options: UsineServerOptions): Promise<RunningUsineServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  await mkdir(options.policy.stateDirectory, { recursive: true });

  let resolveReady: (server: RunningUsineServer) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<RunningUsineServer>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const runTask = yield* FiberMap.makeRuntime<never, string>();
      let launchTask: (submission: TaskSubmission) => void = () => undefined;
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            listen(host, port, async (request, response) => {
              await handleRequest(request, response, options.policy, (submission) => {
                launchTask(submission);
              });
            }),
          catch: (cause) => new Error(`server failed to listen: ${String(cause)}`),
        }),
        (value) =>
          Effect.tryPromise({
            try: () => close(value),
            catch: (cause) => new Error(`server failed to close: ${String(cause)}`),
          }).pipe(Effect.ignore),
      );

      launchTask = (submission) => {
        runTask(
          submission.contract.id,
          Effect.tryPromise({
            try: () =>
              executeAdmittedTask(
                submission.contractPath,
                submission.repositoryPath,
                submission.rawContract,
                submission.contract,
                options.policy,
              ),
            catch: (cause) => cause,
          }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          ),
          { onlyIfMissing: true },
        );
      };

      const running: RunningUsineServer = {
        host,
        port: server.addressPort,
        url: `http://${host}:${server.addressPort}`,
        close: async () => undefined,
      };
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
  const running = await ready.catch((error) => {
    throw error;
  });
  return {
    ...running,
    close: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
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
  policy: RuntimePolicy,
  launch: (submission: TaskSubmission) => void,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const taskId = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/)?.[1];
  if (request.method === "GET" && taskId) {
    const result = await lookupTaskStatus(policy.stateDirectory, decodeURIComponent(taskId));
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
    const result = await admitTask(
      submission.contractPath,
      submission.repositoryPath,
      submission.rawContract,
      submission.contract,
      policy,
    );
    if (!policy.stopAfterAdmitted && result.state !== "reviewed_pr" && result.state !== "blocked") {
      launch(submission);
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
    typeof parsed.repositoryPath !== "string" ||
    !("rawContract" in parsed) ||
    typeof parsed.rawContract !== "string" ||
    !("contract" in parsed)
  ) {
    throw new Error("task submission shape is invalid");
  }
  const contract = taskContractSchema.safeParse(parsed.contract);
  if (!contract.success) {
    throw new Error(`invalid task contract: ${JSON.stringify(contractIssues(contract.error))}`);
  }
  return {
    contractPath: parsed.contractPath,
    repositoryPath: parsed.repositoryPath,
    rawContract: parsed.rawContract,
    contract: contract.data,
  };
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
