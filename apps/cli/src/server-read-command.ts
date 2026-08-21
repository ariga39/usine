import { serverHealth, serverSnapshot } from "./server-client.js";
import { runCommand, usageFailure } from "./cli-failure.js";
import { optionIndex, parseBoundedLimit, parseOptions, withoutOption } from "./cli-options.js";
import { renderServerHealth, renderServerSnapshot } from "./cli-renderer.js";

export async function runServerReadCommand(args: string[], serverUrl: string): Promise<void> {
  const [operation, ...rest] = args;
  const options = parseOptions(rest);
  const usage = "usine server <health|snapshot> [--json]";

  if (operation === "health") {
    return runCommand("server_health_failed", async () => {
      if (options.values.length > 0) throw usageFailure(usage);
      process.stdout.write(renderServerHealth(await serverHealth(serverUrl), options.json));
    });
  }

  if (operation === "snapshot") {
    return runCommand("server_snapshot_failed", async () => {
      const limitIndex = optionIndex(options.values, "--limit");
      const values = limitIndex < 0 ? options.values : withoutOption(options.values, limitIndex);
      if (values.length > 0 || (limitIndex >= 0 && !options.values[limitIndex + 1]))
        throw usageFailure(usage);
      const limit =
        limitIndex < 0
          ? 100
          : parseBoundedLimit(
              options.values[limitIndex + 1],
              "usine server snapshot [--limit <count>] [--json]",
            );
      process.stdout.write(
        renderServerSnapshot(await serverSnapshot(serverUrl, limit), options.json),
      );
    });
  }

  throw usageFailure(usage);
}
