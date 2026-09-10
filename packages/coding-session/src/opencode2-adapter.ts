import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { mergeProviderNeutralUsage } from "@usine/task-authority";
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
import {
  DarwinOpenCode2Sandbox,
  OpenCode2SandboxUnavailableError,
  type OpenCode2Sandbox,
} from "./opencode2-sandbox.js";

const STARTUP_POLL_MS = 20;
const STARTUP_HEALTH_ATTEMPT_TIMEOUT_MS = 1_000;
const GRACEFUL_INTERRUPT_WAIT_MS = 1_000;
const CHILD_CLOSE_WAIT_MS = 1_000;
const STARTUP_STDERR_LIMIT = 16 * 1024;
const sessionInfoSchema = z.object({ id: z.string().min(1) });
const promptAdmissionSchema = z.object({ sessionID: z.string().min(1) });
const PERMISSION_REPLY_TIMEOUT_MS = 1_000;

class OpenCode2ProtocolError extends Error {}
class OpenCode2CallbackError extends Error {
  constructor(readonly cause: unknown) {
    super("OpenCode2 callback failed");
    this.name = "OpenCode2CallbackError";
  }
}

function protocolViolation(message: string): never {
  throw new OpenCode2ProtocolError(message);
}

function parseProtocol<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    return protocolViolation("OpenCode2 event was invalid");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function invokeOpenCode2Callback<TArgs extends readonly unknown[]>(
  callback: ((...args: TArgs) => Promise<void> | void) | undefined,
  ...args: TArgs
): Promise<void> {
  try {
    await callback?.(...args);
  } catch (error) {
    throw new OpenCode2CallbackError(error);
  }
}

function noOpGracefulInterrupt(): Promise<void> {
  return Promise.resolve();
}

/** Source-internal OpenCode V2 adapter. Its server process is owned by Usine. */
export class OpenCode2Adapter implements CodingSessionAdapter {
  readonly name = "opencode2" as const;

  constructor(
    private readonly stateDirectory: string | undefined,
    private readonly sandbox: OpenCode2Sandbox = new DarwinOpenCode2Sandbox(),
  ) {}

  async run(context: CodingSessionAdapterRequest): Promise<CodingSessionAdapterResult> {
    if (!this.stateDirectory)
      throw new CodingSessionInterruption(
        "startup",
        "configuration",
        "OpenCode2 execution state directory is unavailable",
      );

    let phase: "startup" | "thread" | "turn" | "output" = "startup";
    let privateDirectory: string | undefined;
    let configDirectory: string | undefined;
    let server: ReturnType<typeof spawn> | undefined;
    let childSettled: Promise<void> | undefined;
    let sessionID: string | undefined;
    let interruptRequest: Promise<void> | undefined;
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    let gracefulInterrupt = noOpGracefulInterrupt;
    let primaryFailure: unknown;
    let result: CodingSessionAdapterResult | undefined;
    let cleanupFailure: unknown;
    let startupStderr = "";
    let startupStderrTruncated = false;
    let stderrClosed: Promise<void> | undefined;
    let stderrStream: Readable | undefined;

    try {
      const port = await availablePort();
      await mkdir(this.stateDirectory, { recursive: true });
      privateDirectory = await mkdtemp(join(this.stateDirectory, "opencode-private-"));
      configDirectory = join(privateDirectory, "config");
      await Promise.all([
        mkdir(configDirectory, { recursive: true }),
        mkdir(join(privateDirectory, "home"), { recursive: true }),
        mkdir(join(privateDirectory, "xdg-config"), { recursive: true }),
        mkdir(join(privateDirectory, "xdg-data"), { recursive: true }),
        mkdir(join(privateDirectory, "xdg-state"), { recursive: true }),
        mkdir(join(privateDirectory, "xdg-cache"), { recursive: true }),
        mkdir(join(privateDirectory, "tmp"), { recursive: true }),
      ]);
      const sandbox = await this.sandbox.prepare({
        workspace: context.workspace,
        privateDirectory,
        role: context.role,
        environment: context.environment,
        signal: context.signal,
      });
      await context.onObservation?.({ type: "sandbox_verified", ...sandbox.evidence });
      const childEnvironment = Object.fromEntries(
        Object.entries(context.environment).filter(([key]) => !key.startsWith("OPENCODE_")),
      );
      server = spawn(
        sandbox.launch.command,
        [...sandbox.launch.args, "serve", "--hostname=127.0.0.1", `--port=${port}`, "--pure"],
        {
          cwd: context.workspace,
          env: {
            ...childEnvironment,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(context)),
            OPENCODE_CONFIG_DIR: configDirectory,
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_SHARE: "1",
            HOME: join(privateDirectory, "home"),
            XDG_CONFIG_HOME: join(privateDirectory, "xdg-config"),
            XDG_DATA_HOME: join(privateDirectory, "xdg-data"),
            XDG_STATE_HOME: join(privateDirectory, "xdg-state"),
            XDG_CACHE_HOME: join(privateDirectory, "xdg-cache"),
            TMPDIR: join(privateDirectory, "tmp"),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      const stderr = server.stderr;
      if (stderr) {
        stderrStream = stderr;
        stderr.setEncoding("utf8");
        stderrClosed = new Promise<void>((resolve) => stderr.once("end", resolve));
        stderr.on("data", (chunk: string) => {
          if (startupStderrTruncated) return;
          const remaining = STARTUP_STDERR_LIMIT - startupStderr.length;
          if (remaining <= 0) {
            startupStderrTruncated = true;
            return;
          }
          startupStderr += chunk.slice(0, remaining);
          if (chunk.length > remaining) startupStderrTruncated = true;
        });
      }
      server.once("error", () => undefined);
      childSettled = childSettlement(server);
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
      const globalEvents = await client.v2.event.subscribe({
        signal: context.signal,
        sseMaxRetryAttempts: 0,
      });
      let finalResponse = "";
      let usage: ProviderNeutralUsage | null = null;
      let actualModel: { model: string; provider: string } | undefined;
      let promptAdmitted = false;
      let currentStepID: string | undefined;
      let currentStepHasText = false;
      let terminalStepCompleted = false;
      const toolCalls = new Map<string, { tool: string; input: unknown }>();
      let completionResolve!: () => void;
      let completionReject!: (error: Error) => void;
      let completionSettled = false;
      const completion = new Promise<void>((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      });
      const complete = (): void => {
        if (completionSettled) return;
        completionSettled = true;
        completionResolve();
      };
      const fail = (error: Error): void => {
        if (completionSettled) return;
        completionSettled = true;
        completionReject(error);
      };
      const processGlobalEvents = async (): Promise<void> => {
        try {
          for await (const rawEvent of globalEvents.stream) {
            const event = parseGlobalEvent(rawEvent);
            if (event.type !== "permission.v2.asked") continue;
            if (event.properties.sessionID !== createdSessionID) continue;
            try {
              await bounded(
                client!.v2.session.permission.reply(
                  {
                    sessionID: createdSessionID,
                    requestID: event.properties.id,
                    reply: "reject",
                    message: "Usine does not approve OpenCode2 permission requests",
                  },
                  { responseStyle: "data", throwOnError: true, signal: context.signal },
                ),
                PERMISSION_REPLY_TIMEOUT_MS,
              );
            } catch {
              fail(
                new CodingSessionInterruption(
                  "turn",
                  "authority",
                  "OpenCode2 permission request could not be rejected",
                ),
              );
              return;
            }
            fail(
              new CodingSessionInterruption(
                "turn",
                "authority",
                "OpenCode2 permission request was rejected",
              ),
            );
            return;
          }
          fail(
            new CodingSessionInterruption(
              promptAdmitted ? "turn" : "thread",
              promptAdmitted ? "transient_transport" : "transport",
              "OpenCode2 permission stream ended",
            ),
          );
        } catch {
          fail(
            context.signal.aborted
              ? new CodingSessionInterruption("turn", "cancellation", "coding session cancelled")
              : new CodingSessionInterruption(
                  promptAdmitted ? "turn" : "thread",
                  promptAdmitted ? "transient_transport" : "transport",
                  "OpenCode2 permission stream failed",
                ),
          );
        }
      };
      void processGlobalEvents();
      const completionOutcome = completion.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({
          error: error instanceof Error ? error : new Error(String(error)),
          ok: false as const,
        }),
      );
      const processEvents = async (): Promise<void> => {
        try {
          for await (const rawEvent of events.stream) {
            const event = parseSessionEvent(rawEvent);
            if (event.data.sessionID !== createdSessionID)
              protocolViolation("OpenCode2 event identity mismatch");
            if (!promptAdmitted && event.type !== "session.next.prompt.admitted")
              protocolViolation("OpenCode2 event arrived before prompt admission");
            if (event.type === "session.next.prompt.admitted") {
              const data = parseProtocol(() => promptAdmittedDataSchema.parse(event.data));
              promptAdmitted = true;
              await invokeOpenCode2Callback(context.onPhase, "turn");
              await invokeOpenCode2Callback(context.onObservation, {
                type: "turn_started",
                turn: 1,
              });
              if (data.sessionID !== createdSessionID)
                protocolViolation("OpenCode2 event identity mismatch");
            } else if (event.type === "session.next.shell.ended") {
              const data = parseProtocol(() => shellEndedDataSchema.parse(event.data));
              await invokeOpenCode2Callback(context.onItemCompleted, {
                type: "command_execution",
                id: data.callID,
                status: "completed",
                output: jsonField(data.output),
              });
            } else if (
              event.type === "session.next.tool.success" ||
              event.type === "session.next.tool.failed"
            ) {
              const data = parseProtocol(() => toolCompletionDataSchema.parse(event.data));
              const identity = toolCalls.get(data.callID);
              if (!identity) protocolViolation("OpenCode2 tool completion had no preceding call");
              const evidence = toolEvidence(event.type, data, identity, context);
              await invokeOpenCode2Callback(context.onItemCompleted, evidence);
            } else if (event.type === "session.next.tool.called") {
              const data = parseProtocol(() => toolCalledDataSchema.parse(event.data));
              toolCalls.set(data.callID, { input: data.input, tool: data.tool });
            } else if (event.type === "session.next.text.ended") {
              const data = parseProtocol(() => textEndedDataSchema.parse(event.data));
              if (currentStepID !== data.assistantMessageID)
                protocolViolation("OpenCode2 text ended outside its step");
              finalResponse = data.text;
              currentStepHasText = true;
              await invokeOpenCode2Callback(context.onItemCompleted, {
                type: "agent_message",
                id: data.textID,
                status: "completed",
                text: data.text,
              });
            } else if (event.type === "session.next.reasoning.ended") {
              const data = parseProtocol(() => reasoningEndedDataSchema.parse(event.data));
              await invokeOpenCode2Callback(context.onItemCompleted, {
                type: "reasoning",
                id: data.reasoningID,
                status: "completed",
                text: data.text,
              });
            } else if (event.type === "session.next.step.started") {
              const data = parseProtocol(() => stepStartedDataSchema.parse(event.data));
              currentStepID = data.assistantMessageID;
              currentStepHasText = false;
              if (data.model)
                actualModel = { model: data.model.id, provider: data.model.providerID };
            } else if (event.type === "session.next.step.ended") {
              const data = parseProtocol(() => stepEndedDataSchema.parse(event.data));
              if (currentStepID !== data.assistantMessageID)
                protocolViolation("OpenCode2 step ended outside its step");
              if (data.finish === "stop" && !currentStepHasText) {
                fail(
                  new CodingSessionInterruption(
                    "turn",
                    "transport",
                    "OpenCode2 completed the terminal step without an assistant response",
                  ),
                );
                return;
              }
              const uncachedInputTokens = data.tokens.input;
              const cachedInputTokens = data.tokens.cache?.read;
              const cacheWriteInputTokens = data.tokens.cache?.write;
              const stepUsage: ProviderNeutralUsage = {
                ...(cachedInputTokens === undefined || cacheWriteInputTokens === undefined
                  ? {}
                  : {
                      inputTokens: uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens,
                    }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                uncachedInputTokens,
                ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
                outputTokens: data.tokens.output + (data.tokens.reasoning ?? 0),
                ...(data.tokens.reasoning === undefined
                  ? {}
                  : { reasoningOutputTokens: data.tokens.reasoning }),
              };
              usage = mergeProviderNeutralUsage(usage, stepUsage);
              await invokeOpenCode2Callback(context.onUsage, {
                usage: stepUsage,
                semantics: "delta",
                ...(actualModel ? { actualModel } : {}),
              });
              if (data.finish === "stop") {
                terminalStepCompleted = true;
                complete();
              }
            } else if (event.type === "session.next.step.failed") {
              const data = parseProtocol(() => stepFailedDataSchema.parse(event.data));
              await invokeOpenCode2Callback(context.onItemCompleted, {
                type: "other",
                id: event.id,
                status: "failed",
              });
              if (data.sessionID !== createdSessionID)
                protocolViolation("OpenCode2 event identity mismatch");
              fail(providerFailure("turn"));
              return;
            }
          }
          if (!terminalStepCompleted)
            fail(
              context.signal.aborted
                ? new CodingSessionInterruption("turn", "cancellation", "coding session cancelled")
                : new CodingSessionInterruption(
                    promptAdmitted ? "turn" : "thread",
                    promptAdmitted ? "transient_transport" : "transport",
                    "OpenCode2 event stream ended before completion",
                  ),
            );
        } catch (error) {
          if (context.signal.aborted)
            fail(new CodingSessionInterruption("turn", "cancellation", "coding session cancelled"));
          else if (error instanceof OpenCode2CallbackError) fail(asError(error.cause));
          else if (error instanceof OpenCode2ProtocolError)
            fail(new CodingSessionInterruption("turn", "transport", error.message));
          else if (error instanceof CodingSessionInterruption) fail(error);
          else
            fail(
              new CodingSessionInterruption(
                promptAdmitted ? "turn" : "thread",
                promptAdmitted ? "transient_transport" : "transport",
              ),
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
      const promptAdmission = parseProtocol(() => promptAdmissionSchema.parse(prompt.data));
      if (promptAdmission.sessionID !== createdSessionID)
        protocolViolation("OpenCode2 prompt identity mismatch");
      const cancellationWait = cancellation(context.signal, gracefulInterrupt);
      try {
        const waitForIdle = client.v2.session.wait(
          { sessionID: createdSessionID },
          { responseStyle: "data", throwOnError: true, signal: context.signal },
        );
        const completionResult = completionOutcome.then((outcome) => {
          if (!outcome.ok) throw outcome.error;
          return outcome;
        });
        await Promise.race([
          Promise.all([waitForIdle, completionResult]),
          cancellationWait.promise,
        ]);
      } finally {
        cancellationWait.dispose();
      }
      await context.onObservation?.({ type: "turn_completed", turn: 1, outcome: "succeeded" });
      phase = "output";
      context.onPhase?.("output");
      result = { finalResponse, usage, sessionId: createdSessionID, actualModel };
    } catch (error) {
      if (error instanceof CodingSessionInterruption) {
        primaryFailure = error;
      } else if (error instanceof OpenCode2SandboxUnavailableError) {
        primaryFailure = new CodingSessionInterruption("startup", "configuration", error.message);
      } else if (error instanceof OpenCode2ProtocolError) {
        primaryFailure = new CodingSessionInterruption(phase, "transport", error.message);
      } else if (context.signal.aborted) {
        await gracefulInterrupt();
        primaryFailure = new CodingSessionInterruption(
          phase,
          "cancellation",
          "coding session cancelled",
        );
      } else {
        primaryFailure = new CodingSessionInterruption(
          phase,
          classifyAdapterFailure(error),
          "OpenCode2 provider interruption",
        );
      }
    } finally {
      try {
        if (context.signal.aborted) await gracefulInterrupt();
        if (server && childSettled) await settleChild(server, childSettled);
        if (stderrClosed) {
          await waitForChildSettlement(stderrClosed, CHILD_CLOSE_WAIT_MS);
          stderrStream?.destroy();
        }
      } catch (error) {
        cleanupFailure = error;
      }
      if (phase === "startup" && startupStderr) {
        try {
          await context.onItemCompleted?.({
            type: "command_execution",
            id: "opencode2-startup-stderr",
            status: "failed",
            command: "opencode serve",
            output: startupStderr + (startupStderrTruncated ? "\n[truncated]" : ""),
          });
        } catch {
          // Private diagnostics never replace the provider result.
        }
      }
      try {
        if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (result === undefined) throw new Error("OpenCode2 session did not produce a result");
    return result;
  }
}

export function opencodeConfig(context: CodingSessionAdapterRequest): Config {
  const model = modelName(context.profile);
  const config: Config = {
    model,
    default_agent: "usine",
    permission: {
      "*": "deny",
      read: "allow",
      edit: context.role === "implementer" ? "allow" : "deny",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      task: "deny",
      external_directory: "deny",
      todowrite: "deny",
      question: "deny",
      webfetch: "deny",
      websearch: "deny",
      lsp: "deny",
      doom_loop: "deny",
      skill: "deny",
    },
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
  eventType: "session.next.tool.success" | "session.next.tool.failed",
  data: ToolCompletionData,
  identity: { tool: string; input: unknown },
  context: CodingSessionAdapterRequest,
): ProviderNeutralCompletedEvidence {
  const tool = safeObservationLabel(identity.tool);
  const server = context.mcpServer?.enabledTools.includes(identity.tool)
    ? context.mcpServer.name
    : "unknown";
  const base = {
    type: "mcp_tool_call" as const,
    id: data.callID,
    status: eventType.endsWith("failed") ? ("failed" as const) : ("completed" as const),
    server: safeObservationLabel(server),
    tool,
    arguments: jsonField(identity.input),
  };
  if (eventType === "session.next.tool.success") return { ...base, output: jsonField(data.result) };
  return { ...base, error: jsonField(data.error) };
}

const sessionEventTypes = [
  "session.next.agent.switched",
  "session.next.model.switched",
  "session.next.moved",
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.context.updated",
  "session.next.synthetic",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.reasoning.started",
  "session.next.reasoning.ended",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.ended",
  "session.next.revert.staged",
  "session.next.revert.cleared",
  "session.next.revert.committed",
] as const;
const sessionEventDataSchema = z.object({ sessionID: z.string().min(1) }).passthrough();
const sessionEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(sessionEventTypes),
  data: sessionEventDataSchema,
});
const promptAdmittedDataSchema = sessionEventDataSchema;
const shellEndedDataSchema = sessionEventDataSchema.extend({
  callID: z.string().min(1),
  output: z.string(),
});
const toolCalledDataSchema = sessionEventDataSchema.extend({
  callID: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
});
const toolCompletionDataSchema = sessionEventDataSchema.extend({
  callID: z.string().min(1),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const textEndedDataSchema = sessionEventDataSchema.extend({
  assistantMessageID: z.string().min(1),
  textID: z.string().min(1),
  text: z.string(),
});
const reasoningEndedDataSchema = sessionEventDataSchema.extend({
  reasoningID: z.string().min(1),
  text: z.string(),
});
const stepStartedDataSchema = sessionEventDataSchema.extend({
  assistantMessageID: z.string().min(1),
  model: z.object({ providerID: z.string().min(1), id: z.string().min(1) }).optional(),
});
const stepEndedDataSchema = sessionEventDataSchema.extend({
  assistantMessageID: z.string().min(1),
  finish: z.string().min(1),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative().optional(),
    cache: z
      .object({
        read: z.number().int().nonnegative().optional(),
        write: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
});
const stepFailedDataSchema = sessionEventDataSchema.extend({ error: z.unknown() });
const sessionEventPayloadSchema = z.union([
  z.string().min(1),
  z.object({ data: z.string().min(1) }).transform(({ data }) => data),
]);

type SessionEvent = z.infer<typeof sessionEventSchema>;
type ToolCompletionData = z.infer<typeof toolCompletionDataSchema>;

function parseSessionEvent(rawEvent: unknown): SessionEvent {
  return parseProtocol(() => {
    const payload = sessionEventPayloadSchema.parse(rawEvent);
    return sessionEventSchema.parse(JSON.parse(payload));
  });
}

const globalPermissionEventSchema = z.object({
  type: z.literal("permission.v2.asked"),
  properties: z.object({ id: z.string().min(1), sessionID: z.string().min(1) }),
});

function parseGlobalEvent(
  rawEvent: unknown,
): z.infer<typeof globalPermissionEventSchema> | { readonly type: "other" } {
  try {
    const first = typeof rawEvent === "string" ? JSON.parse(rawEvent) : rawEvent;
    const value = typeof first === "string" ? JSON.parse(first) : first;
    const parsed = globalPermissionEventSchema.safeParse(value);
    return parsed.success ? parsed.data : { type: "other" };
  } catch {
    return { type: "other" };
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
        const healthSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(STARTUP_HEALTH_ATTEMPT_TIMEOUT_MS),
        ]);
        await Promise.race([
          client.v2.health.get({
            responseStyle: "data",
            throwOnError: true,
            signal: healthSignal,
          }),
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

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return await Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new CodingSessionInterruption(
        "turn",
        "timeout",
        "OpenCode2 permission reply timed out",
      );
    }),
  ]);
}

function childSettlement(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", settle);
    child.once("close", settle);
  });
}

async function settleChild(child: ChildProcess, childSettled: Promise<void>): Promise<void> {
  if (await waitForChildSettlement(childSettled, 0)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited between the settlement check and the signal.
  }
  if (await waitForChildSettlement(childSettled, CHILD_CLOSE_WAIT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the bounded waits.
  }
  if (!(await waitForChildSettlement(childSettled, CHILD_CLOSE_WAIT_MS)))
    throw new Error("OpenCode2 server child did not settle after SIGKILL");
}

function waitForChildSettlement(childSettled: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void childSettled.then(() => finish(true));
  });
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
