import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import {
  createOwnedProcessLauncher,
  discardStartingOwnedExecution,
  reapOwnedExecution,
} from "./codex-execution.js";
import {
  classifyAdapterFailure,
  CodingSessionInterruption,
} from "./coding-session-interruption.js";
import {
  providerNeutralJsonValue,
  type CodingSessionAdapter,
  type CodingSessionAdapterRequest,
  type CodingSessionAdapterResult,
  type ProviderNeutralCompletedEvidence,
  type ProviderNeutralUsage,
} from "./coding-session-adapter.js";
import { safeObservationLabel } from "./coding-session-policy.js";

const STARTUP_POLL_MS = 20;
const GRACEFUL_INTERRUPT_WAIT_MS = 1_000;
const sessionInfoSchema = z.object({ id: z.string().min(1) });
const promptAdmissionSchema = z.object({ sessionID: z.string().min(1) });

function noOpGracefulInterrupt(): Promise<void> {
  return Promise.resolve();
}

/** Source-internal OpenCode V2 adapter. Its server process is owned by Usine. */
export class OpenCode2Adapter implements CodingSessionAdapter {
  readonly name = "opencode2" as const;

  async run(context: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult> {
    if (!context.executionStateDirectory)
      throw new CodingSessionInterruption(
        "startup",
        "configuration",
        "OpenCode2 execution state directory is unavailable",
      );

    let phase: "startup" | "thread" | "turn" | "output" = "startup";
    let launcher: Awaited<ReturnType<typeof createOwnedProcessLauncher>> | undefined;
    let configDirectory: string | undefined;
    let server: ReturnType<typeof spawn> | undefined;
    let launchFailed = false;
    let sessionID: string | undefined;
    let interruptRequest: Promise<void> | undefined;
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    let gracefulInterrupt = noOpGracefulInterrupt;

    try {
      const port = await availablePort();
      launcher = await createOwnedProcessLauncher(
        context.executionStateDirectory,
        context.workspace,
        context.execution,
        "opencode",
      );
      configDirectory = join(
        context.executionStateDirectory,
        "opencode-config",
        createHash("sha256")
          .update(
            `${context.execution.taskId}\0${context.execution.role}\0${context.execution.attempt}`,
          )
          .digest("hex"),
      );
      await mkdir(configDirectory, { recursive: true });
      const childEnvironment = Object.fromEntries(
        Object.entries(context.environment).filter(([key]) => !key.startsWith("OPENCODE_")),
      );
      server = spawn(
        launcher.launcherPath,
        ["serve", "--hostname=127.0.0.1", `--port=${port}`, "--pure"],
        {
          cwd: context.workspace,
          env: {
            ...childEnvironment,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(context)),
            OPENCODE_CONFIG_DIR: configDirectory,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_SHARE: "1",
            USINE_CODING_SESSION_IDENTITY_PATH: launcher.identityPath,
            USINE_CODING_SESSION_WORKSPACE: context.workspace,
          },
          stdio: "ignore",
        },
      );
      server.once("error", () => {
        launchFailed = true;
      });
      client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
      gracefulInterrupt = async (): Promise<void> => {
        if (!sessionID || !client) return;
        if (!interruptRequest) {
          interruptRequest = client.v2.session
            .interrupt({ sessionID })
            .then(() => undefined)
            .catch(() => undefined);
        }
        await Promise.race([interruptRequest, delay(GRACEFUL_INTERRUPT_WAIT_MS)]);
      };
      await waitUntilReady(client, context.signal, server);
      phase = "thread";
      context.onPhase?.("thread");
      const session = await client.v2.session.create(
        {
          agent: "usine",
          ...(modelReference(context.profile) ? { model: modelReference(context.profile) } : {}),
          location: { directory: context.workspace },
        },
        { responseStyle: "data", throwOnError: true, signal: context.signal },
      );
      const createdSessionID = sessionInfoSchema.parse(session.data).id;
      sessionID = createdSessionID;
      context.onSessionId?.(createdSessionID);
      await context.onObservation?.({ type: "thread_started" });

      const events = await client.v2.session.events(
        { sessionID: createdSessionID },
        {
          signal: context.signal,
          sseMaxRetryAttempts: 0,
        },
      );
      let finalResponse = "";
      let usage: ProviderNeutralUsage | null = null;
      let promptAdmitted = false;
      let textCompleted = false;
      let stepCompleted = false;
      let completionResolve!: () => void;
      let completionReject!: (error: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      });
      void Promise.allSettled([completion]);
      const processEvents = async (): Promise<void> => {
        try {
          for await (const rawEvent of events.stream) {
            const event = parseSessionEvent(sessionEventPayloadSchema.parse(rawEvent));
            if (eventSessionID(event) !== undefined && eventSessionID(event) !== createdSessionID)
              throw new Error("OpenCode2 event identity mismatch");
            if (
              !promptAdmitted &&
              event.type.startsWith("session.next.") &&
              event.type !== "session.next.prompt.admitted"
            )
              throw new Error("OpenCode2 event arrived before prompt admission");
            if (event.type === "session.next.prompt.admitted") {
              promptAdmitted = true;
              context.onPhase?.("turn");
              await context.onObservation?.({ type: "turn_started", turn: 1 });
            } else if (event.type === "session.next.shell.ended") {
              await context.onItemCompleted?.({
                type: "command_execution",
                id: event.data.callID,
                status: "completed",
                output: jsonField(event.data.output),
              });
            } else if (
              event.type === "session.next.tool.success" ||
              event.type === "session.next.tool.failed"
            ) {
              const evidence = toolEvidence(event, context);
              await context.onItemCompleted?.(evidence);
            } else if (event.type === "session.next.text.ended") {
              finalResponse = event.data.text;
              textCompleted = true;
              await context.onItemCompleted?.({
                type: "agent_message",
                id: event.data.textID,
                status: "completed",
                text: event.data.text,
              });
            } else if (event.type === "session.next.reasoning.ended") {
              await context.onItemCompleted?.({
                type: "reasoning",
                id: event.data.reasoningID,
                status: "completed",
                text: event.data.text,
              });
            } else if (event.type === "session.next.step.ended") {
              if (!textCompleted) {
                completionReject(
                  new CodingSessionInterruption(
                    "turn",
                    "transport",
                    "OpenCode2 completed a step without an assistant response",
                  ),
                );
                return;
              }
              stepCompleted = true;
              usage = {
                inputTokens: event.data.tokens.input,
                outputTokens: event.data.tokens.output,
              };
              context.onUsage?.(usage);
              completionResolve();
            } else if (event.type === "session.next.step.failed") {
              await context.onItemCompleted?.({
                type: "other",
                id: event.id,
                status: "failed",
              });
              throw providerFailure("turn");
            }
          }
          if (!stepCompleted)
            completionReject(
              context.signal.aborted
                ? new CodingSessionInterruption("turn", "cancellation", "coding session cancelled")
                : new CodingSessionInterruption(
                    "turn",
                    "transport",
                    "OpenCode2 event stream ended before completion",
                  ),
            );
        } catch (error) {
          completionReject(
            context.signal.aborted
              ? new CodingSessionInterruption("turn", "cancellation", "coding session cancelled")
              : error instanceof CodingSessionInterruption
                ? error
                : new CodingSessionInterruption("turn", "transport"),
          );
        }
      };
      void processEvents();

      phase = "turn";
      context.onPhase?.("turn");
      const prompt = await client.v2.session.prompt(
        {
          sessionID: createdSessionID,
          prompt: { text: context.prompt },
          delivery: "queue",
          resume: true,
        },
        { responseStyle: "data", throwOnError: true, signal: context.signal },
      );
      if (promptAdmissionSchema.parse(prompt.data).sessionID !== createdSessionID)
        throw new Error("OpenCode2 prompt identity mismatch");
      const cancellationWait = cancellation(context.signal, gracefulInterrupt);
      try {
        await Promise.race([
          Promise.all([
            client.v2.session.wait(
              { sessionID: createdSessionID },
              { responseStyle: "data", throwOnError: true, signal: context.signal },
            ),
            completion,
          ]),
          cancellationWait.promise,
        ]);
      } finally {
        cancellationWait.dispose();
      }
      await context.onObservation?.({ type: "turn_completed", turn: 1, outcome: "succeeded" });
      phase = "output";
      context.onPhase?.("output");
      return { finalResponse, usage, sessionId: createdSessionID };
    } catch (error) {
      if (error instanceof CodingSessionInterruption) throw error;
      if (context.signal.aborted) {
        await gracefulInterrupt();
        throw new CodingSessionInterruption(phase, "cancellation", "coding session cancelled");
      }
      throw new CodingSessionInterruption(
        phase,
        classifyAdapterFailure(error),
        "OpenCode2 provider interruption",
      );
    } finally {
      if (context.signal.aborted) await gracefulInterrupt();
      if (launcher) {
        try {
          if (launchFailed || !server || (server.exitCode !== null && !sessionID))
            await discardStartingOwnedExecution(context.executionStateDirectory, context.execution);
          await reapOwnedExecution(context.executionStateDirectory, {
            reference: context.execution,
            workspace: context.workspace,
          });
        } finally {
          if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
        }
      } else if (configDirectory) {
        await rm(configDirectory, { recursive: true, force: true });
      }
    }
  }
}

function opencodeConfig(context: CodingSessionAdapterRequest): Config {
  const model = modelName(context.profile);
  const config: Config = {
    model,
    default_agent: "usine",
    agent: {
      usine: {
        model,
        mode: "primary",
        ...(context.profile.developerInstructions
          ? { prompt: context.profile.developerInstructions }
          : {}),
        tools: Object.fromEntries(
          context.mcpServer?.enabledTools.map((tool) => [tool, true]) ?? [],
        ),
      },
    },
  };
  if (context.mcpServer)
    config.mcp = {
      [context.mcpServer.name]: {
        type: "remote",
        url: context.mcpServer.url,
        enabled: true,
      },
    };
  return config;
}

function modelName(profile: CodingSessionAdapterRequest["profile"]): string {
  const parts = profile.model.split("/", 2);
  if (profile.modelProvider) {
    return parts.length === 2 && parts[0] === profile.modelProvider
      ? profile.model
      : `${profile.modelProvider}/${profile.model}`;
  }
  return profile.model;
}

function modelReference(
  profile: CodingSessionAdapterRequest["profile"],
): { id: string; providerID: string } | undefined {
  if (profile.modelProvider) {
    const prefix = `${profile.modelProvider}/`;
    return {
      id: profile.model.startsWith(prefix) ? profile.model.slice(prefix.length) : profile.model,
      providerID: profile.modelProvider,
    };
  }
  const separator = profile.model.indexOf("/");
  if (separator <= 0 || separator === profile.model.length - 1) return undefined;
  return {
    providerID: profile.model.slice(0, separator),
    id: profile.model.slice(separator + 1),
  };
}

function toolEvidence(
  event: Extract<SessionEvent, { type: "session.next.tool.success" | "session.next.tool.failed" }>,
  context: CodingSessionAdapterRequest,
): ProviderNeutralCompletedEvidence {
  const tool = safeObservationLabel(event.data.tool ?? "unknown");
  const server = context.mcpServer?.enabledTools.includes(event.data.tool ?? "")
    ? context.mcpServer.name
    : "unknown";
  const base = {
    type: "mcp_tool_call" as const,
    id: event.data.callID,
    status: event.type.endsWith("failed") ? ("failed" as const) : ("completed" as const),
    server: safeObservationLabel(server),
    tool,
    arguments: jsonField(event.data.input),
  };
  if (event.type === "session.next.tool.success")
    return { ...base, output: jsonField(event.data.result) };
  return { ...base, error: jsonField(event.data.error) };
}

function eventSessionID(event: { data: unknown }): string | undefined {
  if (
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null &&
    "sessionID" in event.data
  )
    return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined;
  return undefined;
}

const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.prompt.admitted"),
    data: z.object({ sessionID: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.shell.ended"),
    data: z.object({ sessionID: z.string().min(1), callID: z.string().min(1), output: z.string() }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.tool.success"),
    data: z.object({
      sessionID: z.string().min(1),
      callID: z.string().min(1),
      tool: z.string().optional(),
      input: z.unknown().optional(),
      result: z.unknown().optional(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.tool.failed"),
    data: z.object({
      sessionID: z.string().min(1),
      callID: z.string().min(1),
      tool: z.string().optional(),
      input: z.unknown().optional(),
      error: z.unknown(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.text.ended"),
    data: z.object({ sessionID: z.string().min(1), textID: z.string().min(1), text: z.string() }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.reasoning.ended"),
    data: z.object({
      sessionID: z.string().min(1),
      reasoningID: z.string().min(1),
      text: z.string(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.step.ended"),
    data: z.object({
      sessionID: z.string().min(1),
      tokens: z.object({ input: z.number(), output: z.number() }),
    }),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("session.next.step.failed"),
    data: z.object({ sessionID: z.string().min(1), error: z.unknown() }),
  }),
]);
const sessionEventPayloadSchema = z.union([
  z.string(),
  z.object({ data: z.string() }).transform(({ data }) => data),
]);

type SessionEvent = z.infer<typeof sessionEventSchema>;

function parseSessionEvent(rawEvent: string): SessionEvent {
  try {
    return sessionEventSchema.parse(JSON.parse(rawEvent));
  } catch {
    throw new Error("OpenCode2 session event was malformed");
  }
}

function jsonField(value: unknown) {
  return providerNeutralJsonValue(value);
}

function providerFailure(phase: "turn"): CodingSessionInterruption {
  return new CodingSessionInterruption(phase, "unknown", "OpenCode2 provider reported a failure");
}

async function waitUntilReady(
  client: ReturnType<typeof createOpencodeClient>,
  signal: AbortSignal,
  process: ReturnType<typeof spawn>,
): Promise<void> {
  let onError!: () => void;
  let onExit!: () => void;
  const processFailure = new Promise<never>((_, reject) => {
    onError = () => reject(new CodingSessionInterruption("startup", "transport"));
    onExit = () => reject(new CodingSessionInterruption("startup", "transport"));
    process.once("error", onError);
    process.once("exit", onExit);
  });
  try {
    while (true) {
      if (process.exitCode !== null || process.signalCode !== null)
        throw new CodingSessionInterruption("startup", "transport");
      if (signal.aborted)
        throw new CodingSessionInterruption("startup", "cancellation", "coding session cancelled");
      try {
        await Promise.race([
          client.v2.health.get({ responseStyle: "data", throwOnError: true, signal }),
          processFailure,
        ]);
        return;
      } catch (error) {
        if (error instanceof CodingSessionInterruption) throw error;
        if (signal.aborted) throw error;
        await delay(STARTUP_POLL_MS);
      }
    }
  } finally {
    process.removeListener("error", onError);
    process.removeListener("exit", onExit);
  }
}

function cancellation(
  signal: AbortSignal,
  interrupt: () => Promise<void>,
): { promise: Promise<never>; dispose: () => void } {
  if (signal.aborted)
    return {
      promise: Promise.reject(
        new CodingSessionInterruption("turn", "cancellation", "coding session cancelled"),
      ),
      dispose: () => undefined,
    };
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => {
      void interrupt().finally(() =>
        reject(new CodingSessionInterruption("turn", "cancellation", "coding session cancelled")),
      );
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string" || !address.port)
    throw new Error("OpenCode2 server port was unavailable");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
