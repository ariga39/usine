import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  runArchiveCleanupCommand,
  runArchiveExportCommand,
  runArchiveListCommand,
  runArchiveManifestCommand,
} from "../src/archive-command.js";

async function writeArchive(
  stateDirectory: string,
  attempt: string,
  captureStatus: "stored" | "pruned" = "stored",
): Promise<string> {
  const archiveId = `archive_00000000-0000-0000-0000-00000000000${attempt}`;
  const directory = join(stateDirectory, "session-archives");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fields = { name: "cli-profile" };
  const profile = {
    ...fields,
    sha256: createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex"),
  };
  const archive =
    captureStatus === "pruned"
      ? {
          schemaVersion: 1 as const,
          archiveId,
          taskId: "cli-archive-task",
          role: "implementer" as const,
          attempt,
          createdAtEpochMs: 1,
          updatedAtEpochMs: 2,
          status: "completed" as const,
          captureStatus,
          completeness: "partial" as const,
          sessionId: "thread-cli",
          adapter: "sdk" as const,
          phase: "output" as const,
          failureClass: null,
          byteLength: 0,
          truncated: false as const,
          warnings: ["archive_pruned"],
        }
      : {
          schemaVersion: 1 as const,
          archiveId,
          taskId: "cli-archive-task",
          role: "implementer" as const,
          attempt,
          createdAtEpochMs: 1,
          updatedAtEpochMs: 2,
          status: "completed" as const,
          captureStatus,
          completeness: "complete" as const,
          sessionId: "thread-cli",
          adapter: "sdk" as const,
          phase: "output" as const,
          failureClass: null,
          failure: null,
          prompt: "sensitive prompt bytes",
          contract: {
            id: "cli-archive-task",
            authorization: { delivery: true },
            delivery: { branch: "agent/cli", issue: 285 },
          },
          profile,
          items: [],
          rawFinalResponse: null,
          normalizedOutput: null,
          usage: null,
          byteLength: 0,
          truncated: false,
          warnings: [],
        };
  for (;;) {
    const bytes = JSON.stringify(archive);
    const byteLength = Buffer.byteLength(bytes);
    if (archive.byteLength === byteLength) {
      await writeFile(join(directory, `${archiveId}.json`), bytes, {
        encoding: "utf8",
        mode: 0o600,
      });
      return archiveId;
    }
    archive.byteLength = byteLength;
  }
}

describe("Session Archive CLI", () => {
  test("keeps list and manifest metadata-only while export emits one selected archive", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-cli-archive-"));
    const archiveId = await writeArchive(stateDirectory, "1");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runArchiveListCommand(
        { taskId: "cli-archive-task", limit: 100, json: true },
        stateDirectory,
      );
      expect(String(stdout.mock.calls[0]?.[0])).not.toContain("sensitive prompt bytes");
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        archives: [{ archiveId, taskId: "cli-archive-task" }],
      });

      stdout.mockClear();
      await runArchiveManifestCommand({ archiveId, json: true }, stateDirectory);
      expect(String(stdout.mock.calls[0]?.[0])).not.toContain("sensitive prompt bytes");

      stdout.mockClear();
      await runArchiveExportCommand(archiveId, stateDirectory);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        archiveId,
        prompt: "sensitive prompt bytes",
      });
    } finally {
      stdout.mockRestore();
      process.exitCode = undefined;
    }
  });

  test("reports exact cleanup IDs", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-cli-archive-cleanup-"));
    const first = await writeArchive(stateDirectory, "1");
    const second = await writeArchive(stateDirectory, "2");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runArchiveCleanupCommand(first, undefined, stateDirectory);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({ removedArchiveIds: [first] });
      stdout.mockClear();
      await runArchiveCleanupCommand(undefined, "cli-archive-task", stateDirectory);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
        removedArchiveIds: [second],
      });
    } finally {
      stdout.mockRestore();
      process.exitCode = undefined;
    }
  });

  test("reports a pruned archive through manifest and explicit export", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-cli-archive-pruned-"));
    const first = await writeArchive(stateDirectory, "1", "pruned");
    await writeArchive(stateDirectory, "2");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runArchiveManifestCommand({ archiveId: first, json: true }, stateDirectory);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        archiveId: first,
        captureStatus: "pruned",
        completeness: "partial",
      });

      stdout.mockClear();
      await runArchiveExportCommand(first, stateDirectory);
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
        archiveId: first,
        captureStatus: "pruned",
      });
      expect(String(stdout.mock.calls[0]?.[0])).not.toContain("sensitive prompt bytes");
    } finally {
      stdout.mockRestore();
      process.exitCode = undefined;
    }
  });
});
