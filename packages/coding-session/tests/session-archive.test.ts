import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  cleanupSessionArchives,
  exportSessionArchive,
  listSessionArchives,
  readSessionArchive,
  readSessionArchiveManifest,
  type SessionArchive,
} from "@usine/coding-session";
import {
  SessionArchiveWriter,
  sessionArchiveDirectory,
  sessionArchiveProfileSnapshot,
} from "../src/session-archive.js";
import type { TaskContract } from "@usine/task-authority";

const contract = {
  id: "archive-task",
  repositoryId: "archive-repository",
  baseSha: "a".repeat(40),
  instructions: "capture the authorized session evidence",
  acceptance: ["the archive is retrievable"],
  nonGoals: [],
  budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 30_000 },
  authorization: {
    source: "https://github.com/example/archive-repository/issues/285",
    delivery: true,
  },
  delivery: {
    branch: "agent/archive-task",
    issue: 285,
    title: "archive task",
    body: "archive task",
  },
} satisfies TaskContract;

function completeArchive(archive: SessionArchive) {
  if (!("items" in archive)) throw new Error("expected a complete archive");
  return archive;
}

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
    output: { content: [{ type: "text", text: "output" }] },
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
  test("keeps mutable capture internals out of the package API", async () => {
    const publicApi = (await import("@usine/coding-session")) as Record<string, unknown>;
    expect(publicApi).not.toHaveProperty("SessionArchiveWriter");
    expect(publicApi).not.toHaveProperty("sessionArchiveProfileSnapshot");
    expect(publicApi).not.toHaveProperty("sessionArchiveDirectory");
  });

  test("keeps provider maps and catalogs out of the whitelist snapshot", () => {
    const profile = sessionArchiveProfileSnapshot("reviewer", {
      model: "reviewer-model",
      model_providers: { private: { base_url: "https://private.example.test" } },
      model_catalog_json: '{"endpoint":"https://private.example.test"}',
    });
    expect(profile).not.toHaveProperty("modelProviders");
    expect(profile).not.toHaveProperty("modelCatalogJson");
  });

  async function rewriteArchive(
    stateDirectory: string,
    archiveId: string,
    mutate: (archive: Record<string, any>) => void,
  ): Promise<void> {
    const path = join(sessionArchiveDirectory(stateDirectory), `${archiveId}.json`);
    const archive = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
    mutate(archive);
    archive.byteLength = 0;
    for (;;) {
      const bytes = JSON.stringify(archive);
      const byteLength = Buffer.byteLength(bytes);
      if (archive.byteLength === byteLength) {
        await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
        return;
      }
      archive.byteLength = byteLength;
    }
  }

  test("truncates explicitly and keeps each archive within its configured bound", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-limit-"));
    const result = await writeArchive(stateDirectory, "1", { maxArchiveBytes: 700 });
    const archive = completeArchive(await exportSessionArchive(stateDirectory, result.archiveId));

    expect(result.archiveStatus).toBe("truncated");
    expect(archive.captureStatus).toBe("truncated");
    expect(archive.completeness).toBe("partial");
    expect(archive.truncated).toBe(true);
    expect(archive.byteLength).toBeLessThanOrEqual(700);
  });

  test("keeps a finalized provider usage snapshot after a later session failure", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-usage-"));
    const writer = new SessionArchiveWriter(
      { stateDirectory },
      {
        taskId: contract.id,
        role: "reviewer",
        attempt: "final-usage",
        contract,
        prompt: "review",
      },
    );
    await writer.begin();
    writer.setUsage({ inputTokens: 12, outputTokens: 8 }, "partial");
    writer.setProviderResult("final response", { inputTokens: 20, outputTokens: 9 }, "complete");
    const result = await writer.finish({
      status: "failed",
      sessionId: "thread-final-usage",
      usage: { inputTokens: 12, outputTokens: 8 },
      usageCompleteness: "partial",
      failure: "stream failed after provider completion",
      phase: "output",
      failureClass: "transport",
    });

    await expect(exportSessionArchive(stateDirectory, result.archiveId)).resolves.toMatchObject({
      status: "failed",
      completeness: "complete",
      usage: { inputTokens: 20, outputTokens: 9 },
      usageCompleteness: "complete",
    });
    await expect(
      readSessionArchiveManifest(stateDirectory, result.archiveId),
    ).resolves.toMatchObject({
      usageCompleteness: "complete",
    });
  });

  test("retains neutral evidence and sanitized profile facts", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-evidence-"));
    const runtimePath = resolve(tmpdir(), `usine-runtime-path-${Date.now()}`);
    const writer = new SessionArchiveWriter(
      { stateDirectory },
      {
        taskId: contract.id,
        role: "reviewer",
        attempt: "1",
        contract,
        prompt: `review ${runtimePath}`,
      },
    );
    await writer.begin();
    const profile = sessionArchiveProfileSnapshot("reviewer", {
      model: "reviewer-model",
      modelReasoningEffort: "high",
      model_provider: "openai",
      developer_instructions: "review independently",
      api_key: "profile-credential-sentinel",
      base_url: "https://profile.example.test",
    });
    expect(profile.sha256).toBe("3675052f50dbc93465495e22591079f96a7b6f6cdb388570db66aa055eda3a4e");
    writer.setProfile(profile);
    writer.setProviderResult("raw provider response", { inputTokens: 1, outputTokens: 2 });
    writer.addCompletedItem({
      type: "command_execution",
      id: "command-1",
      command: `cat ${runtimePath}`,
      output: `command output ${runtimePath}`,
      status: "completed",
    });
    writer.addCompletedItem({
      type: "file_change",
      id: "file-1",
      changes: [{ path: runtimePath, diff: `diff ${runtimePath}` }],
      status: "completed",
    });
    writer.addCompletedItem({
      type: "mcp_tool_call",
      id: "tool-1",
      server: "github_read",
      tool: "github_issue_get",
      arguments: { path: runtimePath, issue: 285 },
      output: { output: runtimePath },
      status: "completed",
    });
    writer.addCompletedItem({
      type: "reasoning",
      id: "reasoning-1",
      text: `reasoning ${runtimePath}`,
      status: "completed",
    });
    const result = await writer.finish({
      status: "completed",
      sessionId: "thread-evidence",
      usage: { inputTokens: 1, outputTokens: 2 },
      failure: null,
      phase: "output",
      failureClass: null,
    });

    const archive = completeArchive(await exportSessionArchive(stateDirectory, result.archiveId));
    expect(archive).toMatchObject({
      prompt: `review ${runtimePath}`,
      contract: {
        authorization: { source: contract.authorization.source, delivery: true },
        delivery: { branch: contract.delivery.branch, issue: 285 },
      },
      profile: {
        name: "reviewer",
        model: "reviewer-model",
        modelReasoningEffort: "high",
        modelProvider: "openai",
        developerInstructions: "review independently",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      completeness: "complete",
    });
    expect(JSON.stringify(archive)).toContain(runtimePath);
    expect(archive.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command_execution",
          command: `cat ${runtimePath}`,
          output: `command output ${runtimePath}`,
        }),
        expect.objectContaining({
          type: "file_change",
          changes: [{ path: runtimePath, diff: `diff ${runtimePath}` }],
        }),
        expect.objectContaining({
          type: "mcp_tool_call",
          arguments: { path: runtimePath, issue: 285 },
          output: { output: runtimePath },
        }),
        expect.objectContaining({ type: "reasoning", text: `reasoning ${runtimePath}` }),
      ]),
    );
    expect(JSON.stringify(archive)).not.toContain("profile-credential-sentinel");
    expect(JSON.stringify(archive)).not.toContain("profile.example.test");
  });

  test("reports retention pruning and cleans exact IDs or one Task", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-retention-"));
    const first = await writeArchive(stateDirectory, "1", { maxArchives: 1 });
    const second = await writeArchive(stateDirectory, "2", { maxArchives: 1 });

    expect(second.warnings).toContain(`pruned:${first.archiveId}`);
    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toHaveLength(2);
    await expect(
      readSessionArchiveManifest(stateDirectory, first.archiveId),
    ).resolves.toMatchObject({
      captureStatus: "pruned",
      completeness: "partial",
    });
    await expect(readSessionArchive(stateDirectory, first.archiveId)).resolves.toMatchObject({
      archiveId: first.archiveId,
      captureStatus: "pruned",
      completeness: "partial",
    });
    await expect(
      cleanupSessionArchives(stateDirectory, { archiveId: second.archiveId }),
    ).resolves.toEqual({
      removedArchiveIds: [second.archiveId],
    });
    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toHaveLength(1);
    await expect(cleanupSessionArchives(stateDirectory, { taskId: contract.id })).resolves.toEqual({
      removedArchiveIds: [first.archiveId],
    });
    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toEqual([]);
  });

  test("prunes a corrupt valid-ID entry without allowing managed files to grow", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-corrupt-"));
    await mkdir(sessionArchiveDirectory(stateDirectory), { recursive: true, mode: 0o700 });
    const corruptId = "archive_33333333-3333-3333-3333-333333333333";
    await writeFile(join(sessionArchiveDirectory(stateDirectory), `${corruptId}.json`), "corrupt");
    const first = await writeArchive(stateDirectory, "1", { maxArchives: 1 });
    await writeArchive(stateDirectory, "2", { maxArchives: 1 });

    expect(first.warnings).toContain(`corrupt_pruned:${corruptId}`);
    await expect(readSessionArchiveManifest(stateDirectory, corruptId)).rejects.toMatchObject({
      code: "session_archive_not_found",
    });
    await expect(
      readSessionArchiveManifest(stateDirectory, first.archiveId),
    ).resolves.toMatchObject({
      captureStatus: "pruned",
    });
    const files = (await readdir(sessionArchiveDirectory(stateDirectory))).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(2);
  });

  test("keeps archive storage private regardless of process umask", async () => {
    const previousUmask = process.umask(0);
    try {
      const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-permissions-"));
      const result = await writeArchive(stateDirectory, "1");
      const directoryMode = (await stat(sessionArchiveDirectory(stateDirectory))).mode & 0o777;
      const fileMode =
        (await stat(join(sessionArchiveDirectory(stateDirectory), `${result.archiveId}.json`)))
          .mode & 0o777;
      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("rejects tampered identity, profile checksum, declared length, and hard-bound files", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-integrity-"));
    const identity = await writeArchive(stateDirectory, "1");
    await rewriteArchive(stateDirectory, identity.archiveId, (archive) => {
      archive.archiveId = "archive_ffffffff-ffff-ffff-ffff-ffffffffffff";
    });
    await expect(readSessionArchive(stateDirectory, identity.archiveId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });

    const profile = await writeArchive(stateDirectory, "2");
    await rewriteArchive(stateDirectory, profile.archiveId, (archive) => {
      archive.profile.model = "tampered-model";
    });
    await expect(readSessionArchive(stateDirectory, profile.archiveId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });

    const length = await writeArchive(stateDirectory, "3");
    const lengthPath = join(sessionArchiveDirectory(stateDirectory), `${length.archiveId}.json`);
    const lengthArchive = JSON.parse(await readFile(lengthPath, "utf8")) as Record<string, unknown>;
    lengthArchive.byteLength = Number(lengthArchive.byteLength) + 1;
    await writeFile(lengthPath, JSON.stringify(lengthArchive), { encoding: "utf8", mode: 0o600 });
    await expect(readSessionArchive(stateDirectory, length.archiveId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });

    const oversized = await writeArchive(stateDirectory, "4");
    await writeFile(
      join(sessionArchiveDirectory(stateDirectory), `${oversized.archiveId}.json`),
      Buffer.alloc(10 * 1024 * 1024 + 1),
      { mode: 0o600 },
    );
    await expect(readSessionArchive(stateDirectory, oversized.archiveId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });
  });

  test("skips one corrupt archive while listing and cleaning valid Task archives", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-list-corrupt-"));
    const valid = await writeArchive(stateDirectory, "1");
    const corruptId = "archive_44444444-4444-4444-4444-444444444444";
    await writeFile(join(sessionArchiveDirectory(stateDirectory), `${corruptId}.json`), "corrupt", {
      mode: 0o600,
    });

    await expect(listSessionArchives(stateDirectory, contract.id)).resolves.toEqual([
      expect.objectContaining({ archiveId: valid.archiveId }),
    ]);
    await expect(cleanupSessionArchives(stateDirectory, { taskId: contract.id })).resolves.toEqual({
      removedArchiveIds: [valid.archiveId],
    });
    await expect(readSessionArchive(stateDirectory, corruptId)).rejects.toMatchObject({
      code: "session_archive_corrupt",
    });
  });

  test("rejects malformed, traversal, absolute, missing, corrupt, and symlink IDs with typed errors", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "usine-session-archive-safe-"));
    await expect(readSessionArchive(stateDirectory, "../outside")).rejects.toMatchObject({
      code: "session_archive_invalid_id",
    });
    const absoluteId = resolve(tmpdir(), "archive");
    await expect(readSessionArchive(stateDirectory, absoluteId)).rejects.toMatchObject({
      code: "session_archive_invalid_id",
    });
    await expect(
      readSessionArchive(stateDirectory, "archive_00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({
      code: "session_archive_not_found",
    });

    await mkdir(sessionArchiveDirectory(stateDirectory), { recursive: true, mode: 0o700 });
    const corruptId = "archive_11111111-1111-1111-1111-111111111111";
    await writeFile(
      join(sessionArchiveDirectory(stateDirectory), `${corruptId}.json`),
      "not json",
      {
        mode: 0o600,
      },
    );
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

    const unsafeDirectoryState = await mkdtemp(join(tmpdir(), "usine-session-archive-unsafe-dir-"));
    await symlink(tmpdir(), sessionArchiveDirectory(unsafeDirectoryState));
    await expect(listSessionArchives(unsafeDirectoryState)).rejects.toMatchObject({
      code: "session_archive_unsafe_path",
    });

    const unsafeFileState = await mkdtemp(join(tmpdir(), "usine-session-archive-unsafe-file-"));
    const unsafeFile = await writeArchive(unsafeFileState, "1");
    await chmod(
      join(sessionArchiveDirectory(unsafeFileState), `${unsafeFile.archiveId}.json`),
      0o644,
    );
    await expect(readSessionArchive(unsafeFileState, unsafeFile.archiveId)).rejects.toMatchObject({
      code: "session_archive_unsafe_path",
    });
  });
});
