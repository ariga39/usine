import { startHermesBridge } from "./index.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runHermesBridge(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const handle = await startHermesBridge({
    usineUrl: required(environment, "USINE_SERVER_URL"),
    webhookUrl: required(environment, "HERMES_WEBHOOK_URL"),
    webhookSecret: required(environment, "HERMES_WEBHOOK_SECRET"),
    mcpHost: environment.HERMES_BRIDGE_HOST?.trim() || "127.0.0.1",
    mcpPort: parsePort(environment.HERMES_BRIDGE_PORT),
  });
  const shutdown = async (): Promise<void> => {
    await handle.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => undefined);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("HERMES_BRIDGE_PORT is invalid");
  return port;
}

if (import.meta.main) {
  runHermesBridge().catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : "Hermes bridge failed\n");
    process.exitCode = 1;
  });
}
