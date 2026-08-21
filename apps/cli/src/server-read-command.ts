import { serverHealth, serverSnapshot } from "./server-client.js";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { runCommand } from "./cli-failure.js";
import { boundedLimitFlag, jsonFlag } from "./cli-parameters.js";
import { renderServerHealth, renderServerSnapshot } from "./cli-renderer.js";

export interface ServerHealthOptions {
  readonly json: boolean;
}

export interface ServerSnapshotOptions {
  readonly limit: number;
  readonly json: boolean;
}

export function serverReadCommands(serverUrl: string) {
  const health = Command.make("health", { json: jsonFlag() }, (options) =>
    Effect.promise(() => runServerHealthCommand(options, serverUrl)),
  );

  const snapshot = Command.make(
    "snapshot",
    {
      limit: boundedLimitFlag(100),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runServerSnapshotCommand(options, serverUrl)),
  );

  return [health, snapshot] as const;
}

export async function runServerHealthCommand(
  options: ServerHealthOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("server_health_failed", async () => {
    process.stdout.write(renderServerHealth(await serverHealth(serverUrl), options.json));
  });
}

export async function runServerSnapshotCommand(
  options: ServerSnapshotOptions,
  serverUrl: string,
): Promise<void> {
  return runCommand("server_snapshot_failed", async () => {
    process.stdout.write(
      renderServerSnapshot(await serverSnapshot(serverUrl, options.limit), options.json),
    );
  });
}
