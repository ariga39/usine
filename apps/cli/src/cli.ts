#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { reportCommandFailure, usageFailure } from "./cli-failure.js";
import { archiveCommand } from "./archive-command.js";
import { compatibilityRepositoryCommands, repositoryCommand } from "./repository-command.js";
import { serverCommand } from "./server-command.js";
import { compatibilityTaskCommands, taskCommand } from "./task-command.js";
import { serverUrlFromEnvironment } from "./server-client.js";
import { stateDirectoryFromEnvironment } from "@usine/runtime";

export function createCliCommand(environment: NodeJS.ProcessEnv = process.env) {
  const serverUrl = serverUrlFromEnvironment(environment);
  return Command.make("usine").pipe(
    Command.withSubcommands([
      serverCommand(environment, serverUrl),
      archiveCommand(stateDirectoryFromEnvironment(environment)),
      repositoryCommand(serverUrl),
      taskCommand(serverUrl),
      ...compatibilityRepositoryCommands(serverUrl),
      ...compatibilityTaskCommands(serverUrl),
    ]),
  );
}

function usageFailureForCliError(error: CliError.CliError) {
  const commandPath =
    error._tag === "ShowHelp"
      ? error.commandPath
      : error._tag === "UnknownSubcommand"
        ? [...(error.parent ?? ["usine"])]
        : ["usine"];
  const errors = error._tag === "ShowHelp" ? error.errors : [error];
  return usageFailure({
    commandPath,
    errors: errors.map((parserError) => ({
      tag: parserError._tag,
      message: parserError.message,
    })),
  });
}

export function main(
  args: ReadonlyArray<string> = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Command.runWith(createCliCommand(environment), {
    version: "0.1.0",
    renderErrors: false,
  })(args).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch((cause) =>
      Effect.sync(() => {
        reportCommandFailure(
          "command_failed",
          CliError.isCliError(cause) ? usageFailureForCliError(cause) : cause,
        );
      }),
    ),
  );
}

NodeRuntime.runMain(main());
