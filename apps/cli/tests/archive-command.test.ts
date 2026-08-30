import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { SessionArchiveWriter } from "../../../packages/coding-session/src/session-archive.js";
import {
  runArchiveCleanupCommand,
  runArchiveExportCommand,
  runArchiveListCommand,
  runArchiveManifestCommand,
} from "../src/archive-command.js";
import type { TaskContract } from "@usine/task-authority";

async function writeArchive(
  stateDirectory: string,
  attempt: string,
  maxArchives?: number,
): Promise<string> {
  const writer = new SessionArchiveWriter(
    { stateDirectory, ...(maxArchives === undefined ? {} : { maxArchives }) },
    {
      taskId: "cli-archive-task",
      role: "implementer",
      attempt,
      contract: { id: "cli-archive-task" } as TaskContract,
      prompt: "sensitive prompt bytes",
    },
  );
  await writer.begin();
  return (
    await writer.finish({
      status: "completed",
      sessionId: "thread-cli",
      usage: null,
      failure: null,
      phase: "output",
      failureClass: null,
    })
  ).archiveId;
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
    const first = await writeArchive(stateDirectory, "1", 1);
    await writeArchive(stateDirectory, "2", 1);
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
