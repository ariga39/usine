import {
  createHermesBridge,
  createUsineBridgeUpstream,
  type HermesBridge,
  type HermesBridgeOptions,
} from "./bridge.js";
import { startHermesBridgeMcpHttp, type HermesMcpHttpHandle } from "./mcp.js";

export * from "./bridge.js";
export * from "./mcp.js";

export interface HermesBridgeRuntimeOptions extends Omit<HermesBridgeOptions, "upstream"> {
  usineUrl: string;
  mcpHost?: string;
  mcpPort?: number;
}

export interface HermesBridgeRuntimeHandle {
  readonly bridge: HermesBridge;
  readonly mcp: HermesMcpHttpHandle;
  close(): Promise<void>;
}

export async function startHermesBridge(
  options: HermesBridgeRuntimeOptions,
): Promise<HermesBridgeRuntimeHandle> {
  const upstream = createUsineBridgeUpstream(options.usineUrl);
  const bridge = createHermesBridge({ ...options, upstream });
  const mcp = await startHermesBridgeMcpHttp({
    upstream,
    host: options.mcpHost,
    port: options.mcpPort,
  });
  void bridge.start().catch(() => undefined);
  let closePromise: Promise<void> | undefined;
  return {
    bridge,
    mcp,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await bridge.close();
        await mcp.close();
      })();
      return closePromise;
    },
  };
}
