import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HermesBridgeUpstream } from "./bridge.js";

const maxBodyBytes = 65_536;
const maxLimit = 100;

export const hermesBridgeToolNames = [
  "usine_server_snapshot",
  "usine_task_list",
  "usine_task_get",
  "usine_task_history",
  "usine_task_submit",
  "usine_task_retry",
] as const;

export type HermesBridgeToolName = (typeof hermesBridgeToolNames)[number];

export interface HermesMcpHttpOptions {
  upstream: HermesBridgeUpstream;
  host?: string;
  port?: number;
}

export interface HermesMcpHttpHandle {
  readonly url: string;
  close(): Promise<void>;
}

export function createHermesBridgeMcpServer(upstream: HermesBridgeUpstream): McpServer {
  const server = new McpServer(
    { name: "usine-hermes-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "usine_server_snapshot",
    {
      description: "Read the bounded current Usine server snapshot.",
      inputSchema: { limit: z.number().int().min(1).max(maxLimit).optional() },
    },
    async ({ limit }) => callSafely(() => upstream.serverSnapshot(limit)),
  );
  server.registerTool(
    "usine_task_list",
    {
      description:
        "Read the bounded current Task list window; it is not exhaustive historical discovery.",
      inputSchema: { limit: z.number().int().min(1).max(maxLimit).optional() },
    },
    async ({ limit }) => callSafely(() => upstream.listTasks(limit)),
  );
  server.registerTool(
    "usine_task_get",
    {
      description: "Read one current public Task resource by identifier.",
      inputSchema: { taskId: z.string().min(1) },
    },
    async ({ taskId }) => callSafely(() => upstream.getTask(taskId)),
  );
  server.registerTool(
    "usine_task_history",
    {
      description: "Read bounded durable history for one Task after a sequence.",
      inputSchema: {
        taskId: z.string().min(1),
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ taskId, after, limit }) =>
      callSafely(() => upstream.taskHistory(taskId, after, limit)),
  );
  server.registerTool(
    "usine_task_submit",
    {
      description: "Submit an existing committed Task Contract to Usine.",
      inputSchema: {
        contractPath: z.string().min(1),
        repositoryId: z.string().min(1).optional(),
      },
    },
    async ({ contractPath, repositoryId }) =>
      callSafely(() => upstream.submitTask({ contractPath, repositoryId })),
  );
  server.registerTool(
    "usine_task_retry",
    {
      description: "Request the existing explicit retry mutation for one waiting Task.",
      inputSchema: { taskId: z.string().min(1) },
    },
    async ({ taskId }) => callSafely(() => upstream.retryTask(taskId)),
  );
  return server;
}

export async function startHermesBridgeMcpHttp(
  options: HermesMcpHttpOptions,
): Promise<HermesMcpHttpHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("Hermes MCP host must be loopback");
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();
  const http = createServer(async (request, response) => {
    if (request.url?.split("?", 1)[0] !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const sessionId = request.headers["mcp-session-id"];
      const body = request.method === "POST" ? await requestBody(request) : undefined;
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        if (!isInitializeRequest(body)) {
          response.statusCode = 400;
          response.end("MCP session is unavailable");
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createHermesBridgeMcpServer(options.upstream);
        session = { transport, server };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        if (transport.sessionId) sessions.set(transport.sessionId, session);
        return;
      }
      await session.transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("MCP request failed");
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, host, resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Hermes MCP host did not bind");
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${address.port}/mcp`,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const { server } of sessions.values()) await server.close();
        await new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
      })();
      return closePromise;
    },
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

async function callSafely<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    const value = await operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch {
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Usine operation unavailable" }],
    };
  }
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > maxBodyBytes) throw new Error("MCP request is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
