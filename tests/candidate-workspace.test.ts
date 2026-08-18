import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { CandidateWorkspace } from "../packages/runtime/src/candidate-workspace.js";
import { capabilityEnvironments } from "../packages/runtime/src/runtime-policy.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usine-candidate-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "base\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const baseSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  return { root, repository, baseSha };
}

describe("Candidate Workspace", () => {
  test("freezes only the current fenced activation and rejects stale writers", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      environment: capabilityEnvironments(process.env),
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    });
    const first = await workspace.prepareWriter("task", 1, input.baseSha);
    await writeFile(join(first.path, "delivered.txt"), "ok\n");
    const candidate = await workspace.freeze(first, input.baseSha);
    expect(candidate.sha).toMatch(/^[0-9a-f]{40}$/);
    const second = await workspace.prepareWriter("task", 2, candidate.sha);
    await expect(workspace.freeze(first, candidate.sha)).rejects.toThrow("stale workspace fence");
    await workspace.quarantine(second);
  });

  test("freezes commits with the configured author and committer identity", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      environment: capabilityEnvironments({
        ...process.env,
        GIT_AUTHOR_NAME: "ambient author",
        GIT_AUTHOR_EMAIL: "ambient-author@example.invalid",
        GIT_COMMITTER_NAME: "ambient committer",
        GIT_COMMITTER_EMAIL: "ambient-committer@example.invalid",
      }),
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    });
    const writer = await workspace.prepareWriter("identity-task", 1, input.baseSha);
    await writeFile(join(writer.path, "delivered.txt"), "ok\n");

    const candidate = await workspace.freeze(writer, input.baseSha);
    const metadata = await execa(
      "git",
      ["-C", writer.path, "show", "-s", "--format=%an%n%ae%n%cn%n%ce", candidate.sha],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    );

    expect(metadata.stdout.trim().split("\n")).toEqual([
      "Release Bot",
      "release@example.invalid",
      "Release Bot",
      "release@example.invalid",
    ]);
    await workspace.quarantine(writer);
  });
});
