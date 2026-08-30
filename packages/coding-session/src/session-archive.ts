import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskContract } from "@usine/task-authority";
import { z } from "zod";

const archiveIdPattern = /^archive_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const durableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARCHIVE_DIRECTORY = "session-archives";
const DEFAULT_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 100;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVES = 1000;
const archivePruneLocks = new Map<string, Promise<void>>();

const profileSnapshotSchema = z
  .object({
    name: z.string(),
    model: z.string().optional(),
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    modelProvider: z.string().optional(),
    modelReasoningSummary: z.string().optional(),
    modelVerbosity: z.string().optional(),
    personality: z.string().optional(),
    serviceTier: z.string().optional(),
  })
  .strict();

const archiveStatusSchema = z.enum(["completed", "failed", "cancelled"]);
const archiveCaptureStatusSchema = z.enum(["stored", "truncated", "failed"]);
const failureClassSchema = z
  .enum([
    "transport",
    "network",
    "rate_limit",
    "timeout",
    "cancellation",
    "configuration",
    "authority",
    "unknown",
  ])
  .nullable();
const archiveItemSchema = z.record(z.string(), z.unknown());

export const sessionArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveId: z.string().regex(archiveIdPattern),
    taskId: z.string().regex(durableIdPattern),
    role: z.enum(["implementer", "reviewer"]),
    attempt: z.string().regex(durableIdPattern),
    createdAtEpochMs: z.number().int(),
    updatedAtEpochMs: z.number().int(),
    status: archiveStatusSchema,
    captureStatus: archiveCaptureStatusSchema,
    sessionId: z.string().nullable(),
    adapter: z.enum(["sdk", "app-server"]).nullable(),
    phase: z.enum(["startup", "thread", "turn", "output"]).nullable(),
    failureClass: failureClassSchema,
    failure: z.string().nullable(),
    prompt: z.string(),
    contract: z.unknown(),
    profile: profileSnapshotSchema,
    items: z.array(archiveItemSchema),
    rawFinalResponse: z.string().nullable(),
    normalizedOutput: z.unknown(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
      })
      .nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

export type SessionArchive = z.infer<typeof sessionArchiveSchema>;
export type SessionArchiveStatus = z.infer<typeof archiveStatusSchema>;
export type SessionArchiveCaptureStatus = z.infer<typeof archiveCaptureStatusSchema>;
export type SessionArchiveProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

export interface SessionArchiveManifest {
  schemaVersion: 1;
  archiveId: string;
  taskId: string;
  role: SessionArchive["role"];
  attempt: string;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  status: SessionArchiveStatus;
  captureStatus: SessionArchiveCaptureStatus;
  sessionId: string | null;
  adapter: SessionArchive["adapter"];
  phase: SessionArchive["phase"];
  failureClass: SessionArchive["failureClass"];
  byteLength: number;
  truncated: boolean;
  warnings: string[];
}

export interface SessionArchiveOptions {
  stateDirectory: string;
  maxArchiveBytes?: number;
  maxArchives?: number;
}

export type SessionArchiveFailureCode =
  | "session_archive_invalid_id"
  | "session_archive_not_found"
  | "session_archive_unsafe_path"
  | "session_archive_corrupt"
  | "session_archive_write_failed";

export class SessionArchiveError extends Error {
  readonly name = "SessionArchiveError";

  constructor(
    readonly code: SessionArchiveFailureCode,
    message: string,
    readonly archiveId?: string,
  ) {
    super(message);
  }
}

export interface SessionArchiveRecordInput {
  taskId: string;
  role: "implementer" | "reviewer";
  attempt: string;
  contract: TaskContract;
  prompt: string;
}

export function isSessionArchiveId(value: string): boolean {
  return archiveIdPattern.test(value);
}

export function sessionArchiveDirectory(stateDirectory: string): string {
  return join(stateDirectory, ARCHIVE_DIRECTORY);
}

export class SessionArchiveWriter {
  readonly archiveId = `archive_${randomUUID()}`;
  private readonly maxArchiveBytes: number;
  private readonly maxArchives: number;
  private record: SessionArchive;
  private writeFailure: string | null = null;
  private readonly warnings = new Set<string>();
  private persistence = Promise.resolve();

  constructor(
    private readonly options: SessionArchiveOptions,
    input: SessionArchiveRecordInput,
  ) {
    this.maxArchiveBytes = finitePositiveLimit(
      options.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      MAX_ARCHIVE_BYTES,
    );
    this.maxArchives = finitePositiveLimit(options.maxArchives, DEFAULT_MAX_ARCHIVES, MAX_ARCHIVES);
    const now = Date.now();
    this.record = {
      schemaVersion: 1,
      archiveId: this.archiveId,
      taskId: input.taskId,
      role: input.role,
      attempt: input.attempt,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      status: "failed",
      captureStatus: "stored",
      sessionId: null,
      adapter: null,
      phase: "startup",
      failureClass: null,
      failure: null,
      prompt: input.prompt,
      contract: sanitizeJsonValue(input.contract),
      profile: { name: "unknown" },
      items: [],
      rawFinalResponse: null,
      normalizedOutput: null,
      usage: null,
      byteLength: 0,
      truncated: false,
      warnings: [],
    };
  }

  async begin(): Promise<void> {
    await this.schedulePersist();
  }

  setProfile(profile: SessionArchiveProfileSnapshot): void {
    this.record.profile = profile;
    void this.schedulePersist();
  }

  setAdapter(adapter: "sdk" | "app-server"): void {
    this.record.adapter = adapter;
    void this.schedulePersist();
  }

  setSessionId(sessionId: string | null): void {
    this.record.sessionId = sessionId;
    void this.schedulePersist();
  }

  setPhase(phase: SessionArchive["phase"]): void {
    this.record.phase = phase;
    void this.schedulePersist();
  }

  addCompletedItem(item: unknown): void {
    const sanitized = sanitizeCompletedItem(item);
    if (sanitized) this.record.items.push(sanitized);
    if (
      isRecord(item) &&
      typeof item.text === "string" &&
      (item.type === "agent_message" || item.type === "agentMessage")
    )
      this.record.rawFinalResponse = item.text;
    void this.schedulePersist();
  }

  setUsage(usage: SessionArchive["usage"]): void {
    this.record.usage = usage;
    void this.schedulePersist();
  }

  setProviderResult(rawFinalResponse: string, usage: SessionArchive["usage"]): void {
    this.record.rawFinalResponse = rawFinalResponse;
    this.record.usage = usage;
    void this.schedulePersist();
  }

  setNormalizedOutput(output: unknown): void {
    this.record.normalizedOutput = sanitizeJsonValue(output);
    void this.schedulePersist();
  }

  async finish(input: {
    status: SessionArchiveStatus;
    sessionId: string | null;
    usage: SessionArchive["usage"];
    failure: string | null;
    phase: SessionArchive["phase"];
    failureClass: SessionArchive["failureClass"];
  }): Promise<{
    archiveId: string;
    archiveStatus: SessionArchiveCaptureStatus;
    warnings: string[];
  }> {
    this.record.status = input.status;
    this.record.sessionId = input.sessionId ?? this.record.sessionId;
    this.record.usage = input.usage ?? this.record.usage;
    this.record.failure = input.failure;
    this.record.phase = input.phase ?? this.record.phase;
    this.record.failureClass = input.failureClass;
    await this.schedulePersist();
    await this.prune();
    return {
      archiveId: this.archiveId,
      archiveStatus: this.writeFailure ? "failed" : this.record.captureStatus,
      warnings: [...this.warnings],
    };
  }

  private schedulePersist(): Promise<void> {
    this.persistence = this.persistence.then(() => this.persistNow());
    return this.persistence;
  }

  private async persistNow(): Promise<void> {
    if (this.writeFailure) return;
    try {
      await mkdir(sessionArchiveDirectory(this.options.stateDirectory), { recursive: true });
      this.record.updatedAtEpochMs = Date.now();
      const encoded = encodeBoundedRecord(this.record, this.maxArchiveBytes, this.warnings);
      if (Buffer.byteLength(encoded.bytes) > this.maxArchiveBytes)
        throw new Error("session archive byte bound is too small for its metadata");
      this.record = encoded.record;
      const path = archivePath(this.options.stateDirectory, this.archiveId);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encoded.bytes, { encoding: "utf8", flag: "wx" });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    } catch (error) {
      this.writeFailure = error instanceof Error ? error.message : "archive write failed";
      this.warnings.add("archive_write_failed");
    }
  }

  private async prune(): Promise<void> {
    const lockKey = sessionArchiveDirectory(this.options.stateDirectory);
    const previous = archivePruneLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    archivePruneLocks.set(lockKey, current);
    await previous;
    try {
      if (!this.writeFailure) {
        try {
          const entries = await readdir(sessionArchiveDirectory(this.options.stateDirectory), {
            withFileTypes: true,
          });
          const files = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => entry.name.slice(0, -5));
          const records = await Promise.all(
            files.map(async (archiveId) => ({
              archiveId,
              createdAt: (await readSessionArchive(this.options.stateDirectory, archiveId))
                .createdAtEpochMs,
            })),
          );
          const orderedRecords = records.toSorted(
            (left, right) => left.createdAt - right.createdAt,
          );
          let remaining = records.length;
          for (const record of orderedRecords) {
            if (remaining <= this.maxArchives) break;
            if (record.archiveId === this.archiveId) continue;
            try {
              await unlink(archivePath(this.options.stateDirectory, record.archiveId));
              remaining -= 1;
              this.warnings.add(`pruned:${record.archiveId}`);
            } catch {
              this.warnings.add(`prune_failed:${record.archiveId}`);
            }
          }
        } catch {
          this.warnings.add("prune_failed");
        }
      }
    } finally {
      await this.schedulePersist();
      release();
      if (archivePruneLocks.get(lockKey) === current) archivePruneLocks.delete(lockKey);
    }
  }
}

export async function readSessionArchive(
  stateDirectory: string,
  archiveId: string,
): Promise<SessionArchive> {
  const path = archivePath(stateDirectory, archiveId);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw new SessionArchiveError(
        "session_archive_not_found",
        "session archive not found",
        archiveId,
      );
    throw new SessionArchiveError(
      "session_archive_unsafe_path",
      "session archive cannot be inspected",
      archiveId,
    );
  }
  if (!stat.isFile())
    throw new SessionArchiveError(
      "session_archive_unsafe_path",
      "session archive is not a regular file",
      archiveId,
    );
  try {
    return sessionArchiveSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new SessionArchiveError(
      "session_archive_corrupt",
      "session archive is corrupt",
      archiveId,
    );
  }
}

export async function readSessionArchiveManifest(
  stateDirectory: string,
  archiveId: string,
): Promise<SessionArchiveManifest> {
  const archive = await readSessionArchive(stateDirectory, archiveId);
  return manifestFromArchive(archive);
}

export async function listSessionArchives(
  stateDirectory: string,
  taskId?: string,
  limit = 200,
): Promise<SessionArchiveManifest[]> {
  if (taskId !== undefined) assertDurableId(taskId, "task ID");
  const directory = sessionArchiveDirectory(stateDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const manifests: SessionArchiveManifest[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const archiveId = entry.name.slice(0, -5);
    const manifest = await readSessionArchiveManifest(stateDirectory, archiveId);
    if (taskId === undefined || manifest.taskId === taskId) manifests.push(manifest);
  }
  return manifests
    .toSorted((left, right) => right.createdAtEpochMs - left.createdAtEpochMs)
    .slice(0, Math.min(Math.max(1, Math.trunc(limit)), MAX_ARCHIVES));
}

export interface SessionArchiveCleanupSelection {
  archiveId?: string;
  taskId?: string;
}

export async function cleanupSessionArchives(
  stateDirectory: string,
  selection: SessionArchiveCleanupSelection,
): Promise<{ removedArchiveIds: string[] }> {
  if ((selection.archiveId === undefined) === (selection.taskId === undefined))
    throw new SessionArchiveError(
      "session_archive_invalid_id",
      "archive ID or Task ID is required",
    );
  let ids: string[];
  if (selection.archiveId !== undefined) {
    await readSessionArchiveManifest(stateDirectory, selection.archiveId);
    ids = [selection.archiveId];
  } else {
    ids = (await listSessionArchives(stateDirectory, selection.taskId, MAX_ARCHIVES)).map(
      (manifest) => manifest.archiveId,
    );
  }
  for (const archiveId of ids) await unlink(archivePath(stateDirectory, archiveId));
  return { removedArchiveIds: ids };
}

export const listArchivesForTask = listSessionArchives;
export const getArchiveManifest = readSessionArchiveManifest;
export const exportSessionArchive = readSessionArchive;
export const cleanupArchives = cleanupSessionArchives;

function archivePath(stateDirectory: string, archiveId: string): string {
  if (!isSessionArchiveId(archiveId))
    throw new SessionArchiveError(
      "session_archive_invalid_id",
      "archive ID is malformed",
      archiveId,
    );
  return join(sessionArchiveDirectory(stateDirectory), `${archiveId}.json`);
}

function manifestFromArchive(archive: SessionArchive): SessionArchiveManifest {
  const {
    schemaVersion,
    archiveId,
    taskId,
    role,
    attempt,
    createdAtEpochMs,
    updatedAtEpochMs,
    status,
    captureStatus,
    sessionId,
    adapter,
    phase,
    failureClass,
    byteLength,
    truncated,
    warnings,
  } = archive;
  return {
    schemaVersion,
    archiveId,
    taskId,
    role,
    attempt,
    createdAtEpochMs,
    updatedAtEpochMs,
    status,
    captureStatus,
    sessionId,
    adapter,
    phase,
    failureClass,
    byteLength,
    truncated,
    warnings: [...warnings],
  };
}

function encodeBoundedRecord(
  record: SessionArchive,
  maxBytes: number,
  warnings: Set<string>,
): { record: SessionArchive; bytes: string } {
  let candidate = { ...record, warnings: [...new Set([...record.warnings, ...warnings])] };
  let encoded = serializeWithByteLength(candidate);
  if (Buffer.byteLength(encoded.bytes) <= maxBytes) return encoded;
  warnings.add("archive_truncated");
  candidate = {
    ...candidate,
    captureStatus: "truncated",
    truncated: true,
    warnings: [...new Set([...candidate.warnings, "archive_truncated"])],
    items: [],
    rawFinalResponse: null,
    normalizedOutput: null,
    prompt: "<truncated>",
    contract: { truncated: true },
  };
  encoded = serializeWithByteLength(candidate);
  if (Buffer.byteLength(encoded.bytes) > maxBytes) {
    candidate = {
      ...candidate,
      warnings: ["archive_truncated"],
      failure: candidate.failure ? "<truncated>" : null,
      profile: { name: candidate.profile.name },
    };
    encoded = serializeWithByteLength(candidate);
  }
  return encoded;
}

function serializeWithByteLength(record: SessionArchive): {
  record: SessionArchive;
  bytes: string;
} {
  let candidate = { ...record, byteLength: 0 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const bytes = JSON.stringify(candidate);
    const byteLength = Buffer.byteLength(bytes);
    if (candidate.byteLength === byteLength) return { record: candidate, bytes };
    candidate = { ...candidate, byteLength };
  }
  const bytes = JSON.stringify(candidate);
  return { record: candidate, bytes };
}

function sanitizeCompletedItem(value: unknown): z.infer<typeof archiveItemSchema> | null {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string")
    return null;
  const status = typeof value.status === "string" ? value.status : undefined;
  const base = { type: value.type, id: value.id, ...(status ? { status } : {}) };
  switch (value.type) {
    case "command_execution":
    case "commandExecution":
      return {
        ...base,
        output:
          typeof value.aggregated_output === "string"
            ? redactPath(value.aggregated_output)
            : typeof value.aggregatedOutput === "string"
              ? redactPath(value.aggregatedOutput)
              : "",
        ...(typeof value.exit_code === "number"
          ? { exitCode: value.exit_code }
          : typeof value.exitCode === "number"
            ? { exitCode: value.exitCode }
            : {}),
      };
    case "file_change":
    case "fileChange":
      return { ...base, changeCount: Array.isArray(value.changes) ? value.changes.length : 0 };
    case "mcp_tool_call":
    case "mcpToolCall":
      return {
        ...base,
        server: safeLabel(value.server),
        tool: safeLabel(value.tool),
        ...(Object.hasOwn(value, "arguments")
          ? { arguments: sanitizeJsonValue(value.arguments) }
          : {}),
        ...(Object.hasOwn(value, "result") ? { output: sanitizeJsonValue(value.result) } : {}),
        ...(Object.hasOwn(value, "error") ? { error: sanitizeJsonValue(value.error) } : {}),
      };
    case "agent_message":
    case "agentMessage":
    case "reasoning":
      return {
        ...base,
        ...(typeof value.text === "string" ? { text: redactPath(value.text) } : {}),
      };
    case "web_search":
    case "webSearch":
      return { ...base, ...(typeof value.query === "string" ? { query: value.query } : {}) };
    default:
      return base;
  }
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!isRecord(value)) return typeof value === "string" ? redactPath(value) : value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      /^(argv|args|command|cwd|path|workspace|workspace_path|working_directory|environment|env|url|mcp_url|headers|token|access_token|api_key|secret|secrets|credential|credentials|private_key|privatekey|authorization)$/i.test(
        key,
      )
    ) {
      if (key === "args" && typeof nested === "object")
        result.arguments = sanitizeJsonValue(nested);
      continue;
    }
    result[key] = sanitizeJsonValue(nested);
  }
  return result;
}

function redactPath(value: string): string {
  return value.replace(/(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:\\)[^\s"']+/g, "<path>");
}

function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value)
    ? value
    : "unknown";
}

function profileSnapshot(
  profile: string,
  selection: Record<string, unknown>,
): SessionArchiveProfileSnapshot {
  const result: SessionArchiveProfileSnapshot = { name: profile };
  for (const [source, target] of [
    ["model", "model"],
    ["modelReasoningEffort", "modelReasoningEffort"],
    ["model_provider", "modelProvider"],
    ["model_reasoning_summary", "modelReasoningSummary"],
    ["model_verbosity", "modelVerbosity"],
    ["personality", "personality"],
    ["service_tier", "serviceTier"],
  ] as const) {
    if (typeof selection[source] === "string") {
      const safe = safeProfileValue(selection[source]);
      if (safe) (result as Record<string, unknown>)[target] = safe;
    }
  }
  return result;
}

function safeProfileValue(value: string): string | undefined {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    /(?:https?:\/\/|[\\/]\.|token|secret|credential|private[ _-]?key)/i.test(normalized)
  )
    return undefined;
  return normalized;
}

export function sessionArchiveProfileSnapshot(
  profile: string,
  selection: Record<string, unknown>,
): SessionArchiveProfileSnapshot {
  return profileSnapshot(profile, selection);
}

function assertDurableId(value: string, label: string): void {
  if (!durableIdPattern.test(value))
    throw new SessionArchiveError("session_archive_invalid_id", `${label} is malformed`, value);
}

function finitePositiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
