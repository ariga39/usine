import { readFile, realpath } from "node:fs/promises";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { repositoryRegistrationSchema } from "@usine/task-authority";
import { inspectRepository, listRepositories, registerRepository } from "./server-client.js";
import { notFoundFailure, runCommand } from "./cli-failure.js";
import { boundedLimitFlag, jsonFlag } from "./cli-parameters.js";
import { renderJson, renderRepository, renderRepositoryList } from "./cli-renderer.js";

export interface RepositoryListOptions {
  readonly limit: number;
  readonly json: boolean;
}

export interface RepositoryGetOptions {
  readonly repositoryId: string;
  readonly json: boolean;
}

export function repositoryCommand(serverUrl: string) {
  const list = Command.make(
    "list",
    {
      limit: boundedLimitFlag(100),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runRepositoryListCommand(options, serverUrl)),
  );

  const get = Command.make(
    "get",
    {
      repositoryId: Argument.string("repository-id"),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runRepositoryGetCommand(options, serverUrl)),
  );

  return Command.make("repository").pipe(Command.withSubcommands([list, get]));
}

export function compatibilityRepositoryCommands(serverUrl: string) {
  const inspect = Command.make(
    "inspect",
    { repositoryId: Argument.string("repository-id") },
    ({ repositoryId }) => Effect.promise(() => runLegacyRepositoryInspect(repositoryId, serverUrl)),
  );

  const register = Command.make(
    "register",
    { registrationPath: Argument.string("repository.json") },
    ({ registrationPath }) => Effect.promise(() => runRegisterCommand(registrationPath, serverUrl)),
  );

  return [inspect, register] as const;
}

export async function runRepositoryListCommand(
  options: RepositoryListOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("repository_list_failed", async () => {
    const page = await listRepositories(serverUrl, options.limit);
    process.stdout.write(renderRepositoryList(page, options.json));
  });
}

export async function runRepositoryGetCommand(
  options: RepositoryGetOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("repository_get_failed", async () => {
    const repository = await inspectRepository(serverUrl, options.repositoryId);
    if (!repository) throw notFoundFailure("repository", "repositoryId", options.repositoryId);
    process.stdout.write(renderRepository(repository, options.json));
  });
}

export async function runLegacyRepositoryInspect(
  repositoryId: string,
  serverUrl: string,
): Promise<void> {
  return runCommand("inspect_failed", async () => {
    const repository = await inspectRepository(serverUrl, repositoryId);
    if (!repository) throw notFoundFailure("repository", "repositoryId", repositoryId);
    process.stdout.write(renderJson(repository));
  });
}

export async function runRegisterCommand(
  registrationPath: string,
  serverUrl: string,
): Promise<void> {
  return runCommand(
    "register_failed",
    async () => {
      const input = JSON.parse(await readFile(registrationPath, "utf8")) as unknown;
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
