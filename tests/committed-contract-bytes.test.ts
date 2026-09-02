import { mkdir, mkdtemp, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  admitTask,
  lookupTaskExecution,
  readTaskContract,
  registerRepository as registerRuntimeRepository,
  runtimePolicyFromEnvironment,
} from "@usine/runtime";
import type { RepositorySnapshot, TaskContract } from "@usine/task-authority";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

describe("committed Task Contract admission", () => {
  test("does not follow a replaced contract leaf during public admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-committed-contract-leaf-race-"));
    const repositoryPath = join(root, "repository");
    const stateDirectory = join(root, "state");
    const contractPath = join(repositoryPath, "task.json");
    const alternateContractPath = join(repositoryPath, "alternate-task.json");
    await mkdir(repositoryPath);
    await execa("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
    await execa("git", ["config", "user.name", "Test"], { cwd: repositoryPath });
    await execa("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repositoryPath,
    });
    await writeFile(join(repositoryPath, "README.md"), "committed contract leaf race\n");
    await execa("git", ["add", "."], { cwd: repositoryPath });
    await execa("git", ["commit", "-m", "base"], { cwd: repositoryPath });
    const baseSha = await git(repositoryPath, "rev-parse", "HEAD");
    const taskId = "committed-contract-leaf-race";
    const committedContract: TaskContract = {
      id: taskId,
      repositoryId: taskId,
      baseSha,
      instructions: "Use only the committed task blob.",
      acceptance: ["The logical contract leaf remains bound."],
      nonGoals: [],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      authorization: {
        source: "https://github.com/example/committed-contract-leaf-race/issues/332",
        delivery: true,
      },
      delivery: {
        branch: "agent/committed-contract-leaf-race",
        issue: 332,
        title: "Committed contract leaf",
        body: "Committed contract leaf",
      },
    };
    const committedRawContract = JSON.stringify(committedContract);
    const alternateRawContract = JSON.stringify({
      ...committedContract,
      instructions: "A different committed blob must not be selected.",
    } satisfies TaskContract);
    await writeFile(contractPath, committedRawContract);
    await writeFile(alternateContractPath, alternateRawContract);
    await execa("git", ["add", "task.json", "alternate-task.json"], { cwd: repositoryPath });
    await execa("git", ["commit", "-m", "authorize task"], { cwd: repositoryPath });

    const provisionalRawContract = JSON.stringify({
      ...committedContract,
      instructions: "Working-tree bytes are provisional only.",
    } satisfies TaskContract);
    await writeFile(contractPath, provisionalRawContract);
    const provisional = await readTaskContract(contractPath);
    const repository: RepositorySnapshot = {
      id: taskId,
      path: await realpath(repositoryPath),
      owner: "example",
      name: "committed-contract-leaf-race",
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    };
    const environment: NodeJS.ProcessEnv = {
      USINE_STATE_DIR: stateDirectory,
      USINE_FORGE_PROFILE_DEFAULT_APP_SLUG: "committed-contract-leaf-app",
      USINE_FORGE_PROFILE_DEFAULT_TEST_TOKEN: "committed-contract-leaf-token",
      USINE_FORGE_PROFILE_DEFAULT_API_URL: "http://127.0.0.1:1",
      USINE_FORGE_PROFILE_DEFAULT_REPOSITORY: "example/committed-contract-leaf-race",
    };
    await registerRuntimeRepository(stateDirectory, repository);

    await unlink(contractPath);
    await symlink("alternate-task.json", contractPath);
    try {
      await expect(
        admitTask(
          contractPath,
          provisional.contract,
          runtimePolicyFromEnvironment(environment, repository),
        ),
      ).rejects.toThrow("uncommitted changes");
      await expect(lookupTaskExecution(stateDirectory, taskId)).resolves.toBeNull();
    } finally {
      await unlink(contractPath).catch(() => undefined);
      await writeFile(contractPath, provisionalRawContract);
    }
  }, 30_000);
});
