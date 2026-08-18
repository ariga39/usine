import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { CandidateWorkspace } from "../packages/runtime/src/candidate-workspace.js";

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
    });
    const first = await workspace.prepareWriter("task", 1, input.baseSha);
    await writeFile(join(first.path, "delivered.txt"), "ok\n");
    const candidate = await workspace.freeze(first, input.baseSha);
    expect(candidate.sha).toMatch(/^[0-9a-f]{40}$/);
    const second = await workspace.prepareWriter("task", 2, candidate.sha);
    await expect(workspace.freeze(first, candidate.sha)).rejects.toThrow("stale workspace fence");
    await workspace.quarantine(second);
  });
});
