import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { forgeReadinessFromEnvironment } from "@usine/runtime";
import { repositoryRegistrationSchema } from "@usine/task-authority";
import { CliFailure, runCommand } from "./cli-failure.js";
import { jsonFlag } from "./cli-parameters.js";
import { renderForgeReadiness } from "./cli-renderer.js";

export interface ForgeReadinessOptions {
  readonly registrationPath: string;
  readonly json: boolean;
}

export function forgeCommand(environment: NodeJS.ProcessEnv) {
  const readiness = Command.make(
    "readiness",
    {
      registrationPath: Argument.string("repository.json"),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runForgeReadinessCommand(options, environment)),
  );
  return Command.make("forge").pipe(Command.withSubcommands([readiness]));
}

export async function runForgeReadinessCommand(
  options: ForgeReadinessOptions,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return runCommand("forge_readiness_failed", async () => {
    const registration = await readRegistration(options.registrationPath);
    const result = await forgeReadinessFromEnvironment(environment, registration);
    if (!result.ready) {
      throw new CliFailure("forge_not_ready", "validation", {
        code: result.code,
        expected: result.expected,
        observed: result.observed,
        action: result.action,
        ...(result.permission === undefined ? {} : { permission: result.permission }),
      });
    }
    process.stdout.write(renderForgeReadiness(result, options.json));
  });
}

async function readRegistration(registrationPath: string) {
  try {
    const input = JSON.parse(await readFile(registrationPath, "utf8")) as unknown;
    return repositoryRegistrationSchema.parse(input);
  } catch {
    throw new CliFailure("invalid_repository_registration", "validation", {
      issues: [{ path: "", message: "registration input is unreadable or invalid" }],
    });
  }
}
