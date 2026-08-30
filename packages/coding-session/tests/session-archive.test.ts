import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  cleanupSessionArchives,
  listSessionArchives,
  readSessionArchive,
  readSessionArchiveManifest,
  SessionArchiveWriter,
  sessionArchiveDirectory,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";

const contract = { id: "archive-task" } as TaskContract;

async function writeArchive(
  stateDirectory: string,
  attempt: string,
  options: { maxArchiveBytes?: number; maxArchives?: number } = {},
) {
  const writer = new SessionArchiveWriter(
    { stateDirectory, ...options },
    {
      taskId: contract.id,
      role: "reviewer",
      attempt,
      contract,
      prompt: "a prompt with sensitive bytes",
    },
  );
  await writer.begin();
  writer.setAdapter("sdk");
  writer.setSessionId(`thread-${attempt}`);
  writer.setProviderResult("a raw provider response", { inputTokens: 3, outputTokens: 4 });
  writer.setNormalizedOutput({ verdict: "approved" });
  writer.addCompletedItem({
    type: "mcp_tool_call",
    id: `tool-${attempt}`,
    server: "github_read",
    tool: "github_issue_get",
    arguments: { issue: 285 },
    result: { content: [{ type: "text", text: "output" }] },
    status: "completed",
  });
  return writer.finish({
    status: "completed",
    sessionId: `thread-${attempt}`,
    usage: { inputTokens: 3, outputTokens: 4 },
    failure: null,
    phase: null,
    failureClass: null,
  });
}

describe("Session Archive operator boundary", () => {
  test("truncates explicitly and keeps each archive within its configured bound", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-limit-"));
    const result = await writeArchive(stateDirectory, "1", { maxArchiveBytes: 700 });
    const archive = await readSessionArchive(stateDirectory, result.archiveId);

    expect(result.archiveStatus).toBe("truncated");
    expect(archive.captureStatus).toBe("truncated");
    expect(archive.truncated).toBe(true);
    expect(archive.byteLength).toBeLessThanOrEqual(700);
  });

  test("reports retention pruning and cleans exact IDs or one Task", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-retention-"));
    const first = await writeArchive(stateDirectory, "1", { maxArchives: 1 });
    const second = await writeArchive(stateDirectory, "2", { maxArchives: 1 });

    expect(second.warnings).toContain(`pruned:${first.archiveId}`);
    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toHaveLength(1);
    await expect(readSessionArchiveManifest(stateDirectory, first.archiveId)).rejects.toMatchObject(
      {
        code: "session_archive_not_found",
      },
    );
    await expect(
      cleanupSessionArchives(stateDirectory, { archiveId: second.archiveId }),
    ).resolves.toEqual({
      removedArchiveIds: [second.archiveId],
    });
    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test("rejects malformed, traversal, absolute, missing, corrupt, and symlink IDs with typed errors", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-safe-"));
    await expect(readSessionArchive(stateDirectory, "../outside")).rejects.toMatchObject({
      code: "session_archive_invalid_id",
    });
    await expect(readSessionArchive(stateDirectory, "/tmp/archive")).rejects.toMatchObject({
      code: "session_archive_invalid_id",
    });
    await expect(
      readSessionArchive(stateDirectory, "archive_00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({
      code: "session_archive_not_found",
    });

    await mkdir(sessionArchiveDirectory(stateDirectory), { recursive: true });
    const corruptId = "archive_11111111-1111-1111-1111-111111111111";
    await writeFile(join(sessionArchiveDirectory(stateDirectory), `${corruptId}.json`), "not json");
    await expect(readSessionArchive(stateDirectory, corruptId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });
    const symlinkId = "archive_22222222-2222-2222-2222-222222222222";
    await symlink(
      join(sessionArchiveDirectory(stateDirectory), `${corruptId}.json`),
      join(sessionArchiveDirectory(stateDirectory), `${symlinkId}.json`),
    );
    await expect(readSessionArchive(stateDirectory, symlinkId)).rejects.toMatchObject({
      code: "session_archive_unsafe_path",
    });
  });
});
