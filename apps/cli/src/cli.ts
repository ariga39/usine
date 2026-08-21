#!/usr/bin/env node

import { runCommand, usageFailure } from "./cli-failure.js";
import {
  runLegacyRepositoryInspect,
  runRegisterCommand,
  runRepositoryCommand,
} from "./repository-command.js";
import { runServerCommand } from "./server-command.js";
import {
  runLegacyTaskFollow,
  runLegacyTaskStatus,
  runSubmitCommand,
  runTaskCommand,
} from "./task-command.js";
import { serverUrlFromEnvironment } from "./server-client.js";

export async function main(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const [command, ...commandArgs] = args;
  const serverUrl = serverUrlFromEnvironment(environment);

  await runCommand("command_failed", async () => {
    switch (command) {
      case "server":
        return runServerCommand(commandArgs, environment, serverUrl);
      case "task":
        return runTaskCommand(commandArgs, serverUrl);
      case "repository":
        return runRepositoryCommand(commandArgs, serverUrl);
      case "status":
        return runLegacyTaskStatus(commandArgs, serverUrl);
      case "inspect":
        return runLegacyRepositoryInspect(commandArgs, serverUrl);
      case "register":
        return runRegisterCommand(commandArgs, serverUrl);
      case "follow":
        return runLegacyTaskFollow(commandArgs, serverUrl);
      case "submit":
        return runSubmitCommand(commandArgs, serverUrl);
      default:
        throw usageFailure("usine submit <task-contract.json>");
    }
  });
}

await main();
