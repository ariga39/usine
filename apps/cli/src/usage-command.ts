import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { UsageReportScope } from "@usine/task-authority";
import { runCommand } from "./cli-failure.js";
import { jsonFlag, naturalFlag } from "./cli-parameters.js";
import { usageReport } from "./server-client.js";
import { renderUsageReport } from "./cli-renderer.js";

export interface UsageOptions {
  readonly taskId: Option.Option<string>;
  readonly repositoryId: Option.Option<string>;
  readonly fromEpochMs: Option.Option<number>;
  readonly toEpochMs: Option.Option<number>;
  readonly json: boolean;
}

export function usageCommand(serverUrl: string) {
  return Command.make(
    "usage",
    {
      taskId: Flag.string("task-id").pipe(Flag.optional),
      repositoryId: Flag.string("repository-id").pipe(Flag.optional),
      fromEpochMs: naturalFlag("from-epoch-ms").pipe(Flag.optional),
      toEpochMs: naturalFlag("to-epoch-ms").pipe(Flag.optional),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runUsageCommand(options, serverUrl)),
  );
}

export async function runUsageCommand(options: UsageOptions, serverUrl: string): Promise<void> {
  return runCommand("usage_failed", async () => {
    const scope: UsageReportScope = {
      taskId: Option.getOrNull(options.taskId),
      repositoryId: Option.getOrNull(options.repositoryId),
      fromEpochMs: Option.getOrNull(options.fromEpochMs),
      toEpochMs: Option.getOrNull(options.toEpochMs),
    };
    process.stdout.write(renderUsageReport(await usageReport(serverUrl, scope), options.json));
  });
}
