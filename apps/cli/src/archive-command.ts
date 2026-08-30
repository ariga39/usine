import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  cleanupSessionArchives,
  exportSessionArchive,
  listSessionArchives,
  readSessionArchiveManifest,
  type SessionArchiveManifest,
} from "@usine/runtime";
import { runCommand } from "./cli-failure.js";
import { boundedLimitFlag, jsonFlag } from "./cli-parameters.js";
import { renderArchiveList, renderJson } from "./cli-renderer.js";

export interface ArchiveListOptions {
  readonly taskId: string;
  readonly limit: number;
  readonly json: boolean;
}

export interface ArchiveManifestOptions {
  readonly archiveId: string;
  readonly json: boolean;
}

export function archiveCommand(stateDirectory: string) {
  const list = Command.make(
    "list",
    {
      taskId: Argument.string("task-id"),
      limit: boundedLimitFlag(100),
      json: jsonFlag(),
    },
    (options) => Effect.promise(() => runArchiveListCommand(options, stateDirectory)),
  );
  const manifest = Command.make(
    "manifest",
    { archiveId: Argument.string("archive-id"), json: jsonFlag() },
    (options) => Effect.promise(() => runArchiveManifestCommand(options, stateDirectory)),
  );
  const exportArchive = Command.make(
    "export",
    { archiveId: Argument.string("archive-id") },
    ({ archiveId }) => Effect.promise(() => runArchiveExportCommand(archiveId, stateDirectory)),
  );
  const cleanup = Command.make(
    "cleanup",
    {
      archiveId: Flag.string("archive-id").pipe(Flag.optional),
      taskId: Flag.string("task-id").pipe(Flag.optional),
    },
    (options) =>
      Effect.promise(() =>
        runArchiveCleanupCommand(
          Option.getOrUndefined(options.archiveId),
          Option.getOrUndefined(options.taskId),
          stateDirectory,
        ),
      ),
  );
  return Command.make("archive").pipe(
    Command.withSubcommands([list, manifest, exportArchive, cleanup]),
  );
}

export async function runArchiveListCommand(
  options: ArchiveListOptions,
  stateDirectory: string,
): Promise<void> {
  return runCommand("archive_list_failed", async () => {
    const manifests = await listSessionArchives(stateDirectory, options.taskId, options.limit);
    process.stdout.write(renderArchiveList(manifests, options.json));
  });
}

export async function runArchiveManifestCommand(
  options: ArchiveManifestOptions,
  stateDirectory: string,
): Promise<void> {
  return runCommand("archive_manifest_failed", async () => {
    const manifest = await readSessionArchiveManifest(stateDirectory, options.archiveId);
    process.stdout.write(renderJson(manifest));
  });
}

export async function runArchiveExportCommand(
  archiveId: string,
  stateDirectory: string,
): Promise<void> {
  return runCommand("archive_export_failed", async () => {
    const archive = await exportSessionArchive(stateDirectory, archiveId);
    process.stdout.write(renderJson(archive));
  });
}

export async function runArchiveCleanupCommand(
  archiveId: string | undefined,
  taskId: string | undefined,
  stateDirectory: string,
): Promise<void> {
  return runCommand("archive_cleanup_failed", async () => {
    if ((archiveId === undefined) === (taskId === undefined))
      throw new Error("exactly one of --archive-id or --task-id is required");
    const result = await cleanupSessionArchives(stateDirectory, { archiveId, taskId });
    process.stdout.write(renderJson(result));
  });
}

export function archiveManifestRows(manifests: readonly SessionArchiveManifest[]) {
  return manifests.map(
    ({ archiveId, taskId, role, attempt, status, captureStatus, completeness }) => ({
      archiveId,
      taskId,
      role,
      attempt,
      status,
      captureStatus,
      completeness,
    }),
  );
}
