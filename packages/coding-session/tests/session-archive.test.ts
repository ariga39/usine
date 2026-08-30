import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
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
  SessionArchiveWriter,
  sessionArchiveProfileSnapshot,
  sessionArchiveDirectory,
  type SessionArchive,
} from "@usine/coding-session";
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
    const archive = completeArchive(await exportSessionArchive(stateDirectory, result.archiveId));

    expect(result.archiveStatus).toBe("truncated");
    expect(archive.captureStatus).toBe("truncated");
    expect(archive.completeness).toBe("partial");
    expect(archive.truncated).toBe(true);
    expect(archive.byteLength).toBeLessThanOrEqual(700);
  });

  test("retains the exact contract and provider evidence while excluding transport labels", async () => {
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
      aggregated_output: `command output ${runtimePath}`,
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
      server: "github_read?token=transport-secret",
      tool: "github_issue_get?token=transport-secret",
      arguments: { path: runtimePath, issue: 285 },
      result: { output: runtimePath },
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
    expect(JSON.stringify(archive)).not.toContain("transport-secret");
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
    await mkdir(sessionArchiveDirectory(stateDirectory), { recursive: true });
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
