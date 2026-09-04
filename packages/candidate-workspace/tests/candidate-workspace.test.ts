import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { CandidateWorkspace, credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import type { ResolvedTaskContract } from "@usine/task-authority";

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

function contract(baseSha: string, title = "Deliver the authorized outcome"): ResolvedTaskContract {
  return {
    id: "outcome-task",
    repositoryId: "repo",
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

function campaignContract(
  baseSha: string,
  title = "Deliver the campaign outcome",
): ResolvedTaskContract {
  const standalone = contract(baseSha, title);
  const { issue: _issue, ...delivery } = standalone.delivery;
  return {
    ...standalone,
    authorization: {
      source: "campaign:campaign-367",
      delivery: true,
    },
    delivery,
    campaign: {
      campaignId: "campaign-367-v1",
      goalId: "campaign-367",
      goalVersion: 1,
      outcomeId: "outcome-one",
    },
  };
}

function isUnsafeSubjectCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f)
  );
}

describe("Candidate Workspace", () => {
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

    expect(subject).toBe(`#150 [outcome-task] Ship the outcome --no-verify ${"x".repeat(111)}`);
    expect(subject).toHaveLength(160);
    expect(Array.from(subject).some(isUnsafeSubjectCodePoint)).toBe(false);
    await workspace.quarantine(writer);
  });

  test("host-finalizes an issue-less Campaign subject through the same leaf", async () => {
    const input = await fixture();
    const workspace = new CandidateWorkspace({
      repository: input.repository,
      stateDirectory: join(input.root, "state"),
      deadlineEpochMs: Date.now() + 30_000,
      credentialFreeGit: credentialFreeGitEnvironment(process.env),
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    });
    const writer = await workspace.prepareWriter("campaign-task", 1, input.baseSha);
    await writeFile(join(writer.path, "delivered.txt"), "ok\n");

    const candidate = await workspace.freeze(
      writer,
      input.baseSha,
      campaignContract(input.baseSha),
    );
    const subject = (
      await execa("git", ["-C", writer.path, "show", "-s", "--format=%s", candidate.sha])
    ).stdout.trim();

    expect(subject).toBe("Campaign [outcome-task] Deliver the campaign outcome");
    expect(subject).not.toContain("undefined");
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
