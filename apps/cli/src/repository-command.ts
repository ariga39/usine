import { readFile, realpath } from "node:fs/promises";
import { repositoryRegistrationSchema } from "@usine/task-authority";
import { inspectRepository, listRepositories, registerRepository } from "./server-client.js";
import { notFoundFailure, runCommand, usageFailure } from "./cli-failure.js";
import { optionIndex, parseBoundedLimit, parseOptions, withoutOption } from "./cli-options.js";
import { renderJson, renderRepository, renderRepositoryList } from "./cli-renderer.js";

export async function runRepositoryCommand(args: string[], serverUrl: string): Promise<void> {
  const [operation, ...rest] = args;
  const options = parseOptions(rest);

  if (operation === "list") {
    return runCommand("repository_list_failed", async () => {
      const limitIndex = optionIndex(options.values, "--limit");
      const values = limitIndex < 0 ? options.values : withoutOption(options.values, limitIndex);
      if (values.length > 0 || (limitIndex >= 0 && !options.values[limitIndex + 1]))
        throw usageFailure("usine repository list [--limit <count>] [--json]");
      const limit =
        limitIndex < 0
          ? 100
          : parseBoundedLimit(
              options.values[limitIndex + 1],
              "usine repository list [--limit <count>] [--json]",
            );
      const page = await listRepositories(serverUrl, limit);
      process.stdout.write(renderRepositoryList(page, options.json));
    });
  }

  if (operation === "get") {
    return runCommand("repository_get_failed", async () => {
      if (options.values.length !== 1)
        throw usageFailure("usine repository get <repository-id> [--json]");
      const repositoryId = options.values[0]!;
      const repository = await inspectRepository(serverUrl, repositoryId);
      if (!repository) throw notFoundFailure("repository", "repositoryId", repositoryId);
      process.stdout.write(renderRepository(repository, options.json));
    });
  }

  throw usageFailure("usine repository <list|get> ...");
}

export async function runLegacyRepositoryInspect(args: string[], serverUrl: string): Promise<void> {
  return runCommand("inspect_failed", async () => {
    if (args.length !== 1) throw usageFailure("usine inspect <repository-id>");
    const repositoryId = args[0]!;
    const repository = await inspectRepository(serverUrl, repositoryId);
    if (!repository) throw notFoundFailure("repository", "repositoryId", repositoryId);
    process.stdout.write(renderJson(repository));
  });
}

export async function runRegisterCommand(args: string[], serverUrl: string): Promise<void> {
  return runCommand(
    "register_failed",
    async () => {
      if (args.length !== 1) throw usageFailure("usine register <repository.json>");
      const input = JSON.parse(await readFile(args[0]!, "utf8")) as unknown;
      const registration = repositoryRegistrationSchema.parse(input);
      const parsed = repositoryRegistrationSchema.parse({
        ...registration,
        path: await realpath(registration.path),
      });
      const repository = await registerRepository(serverUrl, parsed);
      process.stdout.write(renderJson(repository));
    },
    "validation",
  );
}
