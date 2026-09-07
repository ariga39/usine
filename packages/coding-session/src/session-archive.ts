import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  ProviderNeutralCompletedEvidence,
  ProviderNeutralUsage,
} from "./coding-session-adapter.js";

const archiveIdPattern = /^archive_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const durableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARCHIVE_DIRECTORY = "session-archives";
const DEFAULT_MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 100;
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVES = 1000;
const MAX_TOMBSTONES = MAX_ARCHIVES;
const MAX_MANAGED_ARCHIVES = MAX_ARCHIVES + MAX_TOMBSTONES;
const archivePruneLocks = new Map<string, Promise<void>>();

const archiveStatusSchema = z.enum(["completed", "failed", "cancelled"]);
const archiveCaptureStatusSchema = z.enum(["stored", "truncated", "failed", "pruned"]);
const failureClassSchema = z
  .enum([
    "transport",
    "transient_transport",
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

const profileSnapshotFieldsSchema = z
  .object({
    name: z.string(),
    model: z.string().optional(),
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    modelProvider: z.string().optional(),
    modelReasoningSummary: z.string().optional(),
    modelVerbosity: z.string().optional(),
    personality: z.string().optional(),
    serviceTier: z.string().optional(),
    developerInstructions: z.string().optional(),
  })
  .strict();

const profileSnapshotSchema = profileSnapshotFieldsSchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const sessionArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveId: z.string().regex(archiveIdPattern),
    taskId: z.string().regex(durableIdPattern),
    role: z.enum(["implementer", "reviewer", "assessor"]),
    attempt: z.string().regex(durableIdPattern),
    createdAtEpochMs: z.number().int(),
    updatedAtEpochMs: z.number().int(),
    status: archiveStatusSchema,
    captureStatus: archiveCaptureStatusSchema,
    completeness: z.enum(["complete", "partial"]),
    sessionId: z.string().nullable(),
    adapter: z.enum(["sdk", "app-server", "opencode2"]).nullable(),
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
        cachedInputTokens: z.number().int().nonnegative().optional(),
        uncachedInputTokens: z.number().int().nonnegative().optional(),
        cacheWriteInputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        reasoningOutputTokens: z.number().int().nonnegative().optional(),
      })
      .nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

const sessionArchiveTombstoneSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveId: z.string().regex(archiveIdPattern),
    taskId: z.string().regex(durableIdPattern),
    role: z.enum(["implementer", "reviewer", "assessor"]),
    attempt: z.string().regex(durableIdPattern),
    createdAtEpochMs: z.number().int(),
    updatedAtEpochMs: z.number().int(),
    status: archiveStatusSchema,
    captureStatus: z.literal("pruned"),
    completeness: z.literal("partial"),
    sessionId: z.string().nullable(),
    adapter: z.enum(["sdk", "app-server", "opencode2"]).nullable(),
    phase: z.enum(["startup", "thread", "turn", "output"]).nullable(),
    failureClass: failureClassSchema,
    byteLength: z.number().int().nonnegative(),
    truncated: z.literal(false),
    warnings: z.array(z.string()),
  })
  .strict();

type CompleteSessionArchive = z.infer<typeof sessionArchiveSchema>;
export type SessionArchive = CompleteSessionArchive | z.infer<typeof sessionArchiveTombstoneSchema>;
export type SessionArchiveTombstone = z.infer<typeof sessionArchiveTombstoneSchema>;
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
  completeness: "complete" | "partial";
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
  role: "implementer" | "reviewer" | "assessor";
  attempt: string;
  contract: unknown;
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
  private record: CompleteSessionArchive;
  private writeFailure: string | null = null;
  private providerCompleted = false;
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
      completeness: "partial",
      sessionId: null,
      adapter: null,
      phase: "startup",
      failureClass: null,
      failure: null,
      prompt: input.prompt,
      contract: cloneJsonValue(input.contract),
      profile: profileSnapshot("unknown", {}),
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
    this.record.profile = profileSnapshot(profile.name, profile);
    void this.schedulePersist();
  }

  setAdapter(adapter: "sdk" | "app-server" | "opencode2"): void {
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

  addCompletedItem(item: ProviderNeutralCompletedEvidence): void {
    this.record.items.push(item);
    void this.schedulePersist();
  }

  setUsage(usage: ProviderNeutralUsage | null): void {
    this.record.usage = usage;
    void this.schedulePersist();
  }

  setProviderResult(rawFinalResponse: string, usage: CompleteSessionArchive["usage"]): void {
    this.record.rawFinalResponse = rawFinalResponse;
    this.record.usage = usage;
    this.providerCompleted = true;
    void this.schedulePersist();
  }

  setNormalizedOutput(output: unknown): void {
    const cloned = cloneJsonValue(output);
    if (cloned === undefined) {
      this.record.normalizedOutput = null;
      this.warnings.add("normalized_output_unavailable");
    } else {
      this.record.normalizedOutput = cloned;
    }
    void this.schedulePersist();
  }

  async finish(input: {
    status: SessionArchiveStatus;
    sessionId: string | null;
    usage: CompleteSessionArchive["usage"];
    failure: string | null;
    phase: SessionArchive["phase"];
    failureClass: SessionArchive["failureClass"];
  }): Promise<{
    archiveId: string;
    archiveStatus: SessionArchiveCaptureStatus;
    completeness: "complete" | "partial";
    warnings: string[];
  }> {
    this.record.status = input.status;
    this.record.sessionId = input.sessionId ?? this.record.sessionId;
    this.record.usage = input.usage ?? this.record.usage;
    this.record.failure = input.failure;
    this.record.phase = input.phase ?? this.record.phase;
    this.record.failureClass = input.failureClass;
    this.record.completeness = this.providerCompleted ? "complete" : "partial";
    await this.schedulePersist();
    await this.prune();
    return {
      archiveId: this.archiveId,
      archiveStatus: this.writeFailure ? "failed" : this.record.captureStatus,
      completeness: this.record.completeness,
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
      const directory = await ensureArchiveDirectory(this.options.stateDirectory, true);
      this.record.updatedAtEpochMs = Date.now();
      const encoded = encodeBoundedRecord(this.record, this.maxArchiveBytes, this.warnings);
      if (Buffer.byteLength(encoded.bytes) > this.maxArchiveBytes)
        throw new Error("session archive byte bound is too small for its metadata");
      this.record = encoded.record;
      const path = join(directory, `${this.archiveId}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encoded.bytes, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
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
          const directory = await ensureArchiveDirectory(this.options.stateDirectory, false);
          const entries = await readdir(directory, { withFileTypes: true });
          const records = await Promise.all(
            entries
              .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
              .map((entry) =>
                managedArchive(this.options.stateDirectory, entry.name.slice(0, -5), entry.name),
              ),
          );
          const live = records
            .filter((record) => record.archive?.captureStatus !== "pruned")
            .toSorted((left, right) => left.createdAt - right.createdAt);
          const tombstones = records
            .filter((record) => record.archive?.captureStatus === "pruned")
            .toSorted((left, right) => left.createdAt - right.createdAt);
          let liveCount = live.length;
          for (const record of live) {
            if (liveCount <= this.maxArchives) break;
            if (record.archiveId === this.archiveId) continue;
            if (record.archive && record.archive.captureStatus !== "pruned") {
              try {
                const tombstone = prunedTombstone(record.archive);
                await writeArchiveSnapshot(
                  this.options.stateDirectory,
                  record.archiveId,
                  tombstone,
                  this.maxArchiveBytes,
                );
                tombstones.push({
                  ...record,
                  createdAt: tombstone.updatedAtEpochMs,
                  archive: tombstone,
                });
                liveCount -= 1;
                this.warnings.add(`pruned:${record.archiveId}`);
              } catch {
                this.warnings.add(`prune_failed:${record.archiveId}`);
              }
            } else {
              try {
                await unlink(record.path);
                liveCount -= 1;
                this.warnings.add(`corrupt_pruned:${record.archiveId}`);
              } catch {
                this.warnings.add(`prune_failed:${record.archiveId}`);
              }
            }
          }
          for (const record of tombstones.toSorted(
            (left, right) => left.createdAt - right.createdAt,
          )) {
            if (tombstones.length <= Math.min(this.maxArchives, MAX_TOMBSTONES)) break;
            try {
              await unlink(record.path);
              tombstones.splice(tombstones.indexOf(record), 1);
              this.warnings.add(`tombstone_pruned:${record.archiveId}`);
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

interface ManagedArchive {
  archiveId: string;
  path: string;
  createdAt: number;
  archive?: SessionArchive;
}

async function managedArchive(
  stateDirectory: string,
  archiveId: string,
  fileName: string,
): Promise<ManagedArchive> {
  const path = join(sessionArchiveDirectory(stateDirectory), fileName);
  let createdAt = 0;
  try {
    createdAt = (await lstat(path)).mtimeMs;
  } catch {
    // The retention pass is best effort; a concurrent removal is handled below.
  }
  try {
    const archive = await readSessionArchive(stateDirectory, archiveId);
    return {
      archiveId,
      path,
      createdAt:
        archive.captureStatus === "pruned" ? archive.updatedAtEpochMs : archive.createdAtEpochMs,
      archive,
    };
  } catch {
    return { archiveId, path, createdAt };
  }
}

function prunedTombstone(archive: CompleteSessionArchive): SessionArchiveTombstone {
  return {
    schemaVersion: 1,
    archiveId: archive.archiveId,
    taskId: archive.taskId,
    role: archive.role,
    attempt: archive.attempt,
    createdAtEpochMs: archive.createdAtEpochMs,
    updatedAtEpochMs: Date.now(),
    status: archive.status,
    captureStatus: "pruned",
    completeness: "partial",
    sessionId: archive.sessionId,
    adapter: archive.adapter,
    phase: archive.phase,
    failureClass: archive.failureClass,
    byteLength: 0,
    truncated: false,
    warnings: ["archive_pruned"],
  };
}

async function writeArchiveSnapshot(
  stateDirectory: string,
  archiveId: string,
  record: SessionArchiveTombstone,
  maxBytes: number,
): Promise<void> {
  const encoded = serializeWithByteLength(record);
  if (Buffer.byteLength(encoded.bytes) > maxBytes)
    throw new Error("session archive tombstone exceeds byte bound");
  const directory = await ensureArchiveDirectory(stateDirectory, true);
  const path = join(directory, `${archiveId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded.bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readSessionArchive(
  stateDirectory: string,
  archiveId: string,
): Promise<SessionArchive> {
  const fileName = archivePathName(archiveId);
  const directory = await ensureArchiveDirectory(stateDirectory, false).catch((error) => {
    if (error instanceof SessionArchiveError && error.code === "session_archive_not_found")
      throw new SessionArchiveError(
        "session_archive_not_found",
        "session archive not found",
        archiveId,
      );
    throw error;
  });
  const path = join(directory, `${fileName}.json`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
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
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !isPrivateMode(stat.mode))
      throw new SessionArchiveError(
        "session_archive_unsafe_path",
        "session archive is not a private regular file",
        archiveId,
      );
    if (stat.size > MAX_ARCHIVE_BYTES)
      throw new SessionArchiveError(
        "session_archive_corrupt",
        "session archive exceeds the hard byte bound",
        archiveId,
      );
    const bytes = await handle.readFile();
    if (bytes.length > MAX_ARCHIVE_BYTES)
      throw new SessionArchiveError(
        "session_archive_corrupt",
        "session archive exceeds the hard byte bound",
        archiveId,
      );
    const archive = sessionArchiveSchema
      .or(sessionArchiveTombstoneSchema)
      .parse(JSON.parse(bytes.toString("utf8")));
    if (archive.archiveId !== archiveId || archive.byteLength !== bytes.length)
      throw new SessionArchiveError(
        "session_archive_corrupt",
        "session archive identity or byte length is invalid",
        archiveId,
      );
    if ("profile" in archive && archive.profile.sha256 !== profileChecksum(archive.profile))
      throw new SessionArchiveError(
        "session_archive_corrupt",
        "session archive profile checksum is invalid",
        archiveId,
      );
    return archive;
  } catch (error) {
    if (error instanceof SessionArchiveError) throw error;
    throw new SessionArchiveError(
      "session_archive_corrupt",
      "session archive is corrupt",
      archiveId,
    );
  } finally {
    await handle.close();
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
  let directory: string;
  try {
    directory = await ensureArchiveDirectory(stateDirectory, false);
  } catch (error) {
    if (error instanceof SessionArchiveError && error.code === "session_archive_not_found")
      return [];
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: SessionArchiveManifest[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const archiveId = entry.name.slice(0, -5);
    try {
      const manifest = await readSessionArchiveManifest(stateDirectory, archiveId);
      if (taskId === undefined || manifest.taskId === taskId) manifests.push(manifest);
    } catch (error) {
      if (
        error instanceof SessionArchiveError &&
        [
          "session_archive_corrupt",
          "session_archive_unsafe_path",
          "session_archive_invalid_id",
        ].includes(error.code)
      )
        continue;
      throw error;
    }
  }
  return manifests
    .toSorted((left, right) => right.createdAtEpochMs - left.createdAtEpochMs)
    .slice(0, Math.min(Math.max(1, Math.trunc(limit)), MAX_MANAGED_ARCHIVES));
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
    ids = (await listSessionArchives(stateDirectory, selection.taskId, MAX_MANAGED_ARCHIVES)).map(
      (manifest) => manifest.archiveId,
    );
  }
  for (const archiveId of ids) await unlink(archivePath(stateDirectory, archiveId));
  return { removedArchiveIds: ids };
}

export const exportSessionArchive = readSessionArchive;

function archivePath(stateDirectory: string, archiveId: string): string {
  return join(sessionArchiveDirectory(stateDirectory), `${archivePathName(archiveId)}.json`);
}

function archivePathName(archiveId: string): string {
  if (!isSessionArchiveId(archiveId))
    throw new SessionArchiveError(
      "session_archive_invalid_id",
      "archive ID is malformed",
      archiveId,
    );
  return archiveId;
}

async function ensureArchiveDirectory(stateDirectory: string, create: boolean): Promise<string> {
  const directory = sessionArchiveDirectory(stateDirectory);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw new SessionArchiveError(
        "session_archive_not_found",
        "session archive directory not found",
      );
    throw new SessionArchiveError(
      "session_archive_unsafe_path",
      "session archive directory cannot be inspected",
    );
  }
  if (!stat.isDirectory() || !isPrivateMode(stat.mode))
    throw new SessionArchiveError(
      "session_archive_unsafe_path",
      "session archive directory is not private",
    );
  if (create) await chmod(directory, 0o700);
  return directory;
}

function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
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
    completeness,
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
    completeness,
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
  record: CompleteSessionArchive,
  maxBytes: number,
  warnings: Set<string>,
): { record: CompleteSessionArchive; bytes: string } {
  let candidate = { ...record, warnings: [...new Set([...record.warnings, ...warnings])] };
  let encoded = serializeWithByteLength(candidate);
  if (Buffer.byteLength(encoded.bytes) <= maxBytes) return encoded;
  warnings.add("archive_truncated");
  candidate = {
    ...candidate,
    captureStatus: "truncated",
    completeness: "partial",
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
      profile: profileSnapshot(candidate.profile.name, {}),
    };
    encoded = serializeWithByteLength(candidate);
  }
  return encoded;
}

function serializeWithByteLength<T extends { byteLength: number }>(
  record: T,
): {
  record: T;
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

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function profileSnapshot(
  profile: string,
  selection: Record<string, unknown>,
): SessionArchiveProfileSnapshot {
  const result: Record<string, string> = { name: profile };
  for (const [source, target] of [
    ["model", "model"],
    ["modelReasoningEffort", "modelReasoningEffort"],
    ["developerInstructions", "developerInstructions"],
    ["modelProvider", "modelProvider"],
    ["modelReasoningSummary", "modelReasoningSummary"],
    ["modelVerbosity", "modelVerbosity"],
    ["personality", "personality"],
    ["serviceTier", "serviceTier"],
    ["model_provider", "modelProvider"],
    ["model_reasoning_summary", "modelReasoningSummary"],
    ["model_verbosity", "modelVerbosity"],
    ["personality", "personality"],
    ["service_tier", "serviceTier"],
    ["developer_instructions", "developerInstructions"],
  ] as const) {
    if (typeof selection[source] === "string") {
      result[target] = selection[source];
    }
  }
  const fields = profileSnapshotFieldsSchema.parse(result);
  return {
    ...fields,
    sha256: profileChecksum(fields),
  };
}

function profileChecksum(
  profile: SessionArchiveProfileSnapshot | z.infer<typeof profileSnapshotFieldsSchema>,
): string {
  const { sha256: _sha256, ...fields } = profile as SessionArchiveProfileSnapshot;
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
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

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
