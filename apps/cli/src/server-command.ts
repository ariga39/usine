import { startUsineServer } from "@usine/runtime";
import { Cause, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { CliFailure, reportCommandFailure } from "./cli-failure.js";
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
        host: environment.USINE_SERVER_HOST?.trim() || "127.0.0.1",
        port: Number(environment.USINE_SERVER_PORT || 8787),
      }),
    ),
    (server) =>
      Effect.sync(() => {
        process.stdout.write(renderJson({ event: "server_ready", url: server.url }));
      }).pipe(Effect.andThen(Effect.never)),
    (server) =>
      Effect.promise(() => server.close()).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => {
                reportCommandFailure("server_failed", cause);
              }).pipe(Effect.andThen(Effect.fail(new CliFailure("server_failed", "server")))),
        ),
      ),
  ).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => {
            reportCommandFailure("server_failed", cause);
          }),
    ),
  );
}
