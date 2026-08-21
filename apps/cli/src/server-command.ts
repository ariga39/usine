import { createRuntimeExecutionAdapter, startUsineServer } from "@usine/runtime";
import { runCommand, usageFailure } from "./cli-failure.js";
import { renderJson } from "./cli-renderer.js";
import { runServerReadCommand } from "./server-read-command.js";

export async function runServerCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  serverUrl: string,
): Promise<void> {
  if (args[0] === "health" || args[0] === "snapshot") return runServerReadCommand(args, serverUrl);
  if (args.length > 0) throw usageFailure("usine server");

  return runCommand("server_failed", async () => {
    const server = await startUsineServer({
      environment,
      executionAdapter: createRuntimeExecutionAdapter(environment),
      host: environment.USINE_SERVER_HOST?.trim() || "127.0.0.1",
      port: Number(environment.USINE_SERVER_PORT || 8787),
    });
    process.stdout.write(renderJson({ event: "server_ready", url: server.url }));
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
  });
}
