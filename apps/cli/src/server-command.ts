import { createRuntimeExecutionAdapter, startUsineServer } from "@usine/runtime";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { reportCommandFailure } from "./cli-failure.js";
import { renderJson } from "./cli-renderer.js";
import { serverReadCommands } from "./server-read-command.js";

export function serverCommand(environment: NodeJS.ProcessEnv, serverUrl: string) {
  return Command.make("server", {}, () => runServerCommand(environment)).pipe(
    Command.withSubcommands(serverReadCommands(serverUrl)),
  );
}

export function runServerCommand(environment: NodeJS.ProcessEnv) {
  return Effect.acquireUseRelease(
    Effect.promise(() =>
      startUsineServer({
        environment,
        executionAdapter: createRuntimeExecutionAdapter(environment),
        host: environment.USINE_SERVER_HOST?.trim() || "127.0.0.1",
        port: Number(environment.USINE_SERVER_PORT || 8787),
      }),
    ),
    (server) =>
      Effect.sync(() => {
        process.stdout.write(renderJson({ event: "server_ready", url: server.url }));
      }).pipe(Effect.andThen(awaitServerStop)),
    (server) => Effect.promise(() => server.close()),
  ).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        reportCommandFailure("server_failed", cause);
      }),
    ),
  );
}

const awaitServerStop = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }),
);
