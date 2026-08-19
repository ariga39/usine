import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import type { TaskContract } from "@usine/task-authority";

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

function contract(baseSha: string, title = "Deliver the authorized outcome"): TaskContract {
  return {
    id: "outcome-task",
    repository: { path: ".", owner: "example", name: "repo" },
    baseSha,
    instructions: "Deliver the authorized outcome.",
    acceptance: ["The outcome is delivered."],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 30_000 },
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 30_000 },
    authorization: {
      source: "https://github.com/example/repo/issues/150",
      delivery: true,
    },
    delivery: {
      baseBranch: "main",
      branch: "agent/outcome-task",
      issue: 150,
      title,
      body: "The authorized outcome.",
    },
  };
}

describe("Candidate Workspace", () => {
  test("freezes only the current fenced activation and rejects stale writers", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      credentialFreeGit: credentialFreeGitEnvironment(process.env),
      gitAuthor: { name: "Test", email: "test@example.invalid" },
    });
    const first = await workspace.prepareWriter("task", 1, input.baseSha);
    await writeFile(join(first.path, "delivered.txt"), "ok\n");
    const candidate = await workspace.freeze(first, input.baseSha, contract(input.baseSha));
    expect(candidate.sha).toMatch(/^[0-9a-f]{40}$/);
    const second = await workspace.prepareWriter("task", 2, candidate.sha);
    await expect(workspace.freeze(first, candidate.sha, contract(candidate.sha))).rejects.toThrow(
      "stale workspace fence",
    );
    await workspace.quarantine(second);
  });

  test("freezes commits with the configured author and committer identity", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      credentialFreeGit: credentialFreeGitEnvironment({
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

    const candidate = await workspace.freeze(writer, input.baseSha, contract(input.baseSha));
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

  test("host-finalizes a bounded subject from the Issue identity and authorized outcome", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      credentialFreeGit: credentialFreeGitEnvironment(process.env),
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    });
    const writer = await workspace.prepareWriter("outcome-task", 1, input.baseSha);
    await writeFile(join(writer.path, "delivered.txt"), "ok\n");

    const candidate = await workspace.freeze(
      writer,
      input.baseSha,
      contract(
        input.baseSha,
        `Ship the outcome\n\u001b[31m--no-verify\u001b[0m\t${"x".repeat(400)}`,
      ),
    );
    const subject = (
      await execa("git", ["-C", writer.path, "show", "-s", "--format=%s", candidate.sha])
    ).stdout.trim();

    expect(subject).toBe(
      `#150 [outcome-task] Ship the outcome --no-verify ${"x".repeat(111)}`,
    );
    expect(subject).toHaveLength(160);
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u);
    await workspace.quarantine(writer);
  });

  test("preserves an already-clean agent commit subject", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      credentialFreeGit: credentialFreeGitEnvironment(process.env),
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    });
    const writer = await workspace.prepareWriter("outcome-task", 1, input.baseSha);
    await writeFile(join(writer.path, "delivered.txt"), "ok\n");
    await execa("git", ["-C", writer.path, "add", "--all"]);
    await execa("git", [
      "-C",
      writer.path,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "-m",
      "Agent chose this subject",
    ]);

    const candidate = await workspace.freeze(writer, input.baseSha, contract(input.baseSha));
    const subject = (
      await execa("git", ["-C", writer.path, "show", "-s", "--format=%s", candidate.sha])
    ).stdout.trim();

    expect(subject).toBe("Agent chose this subject");
    await workspace.quarantine(writer);
  });
});
