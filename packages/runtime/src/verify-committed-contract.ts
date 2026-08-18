import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { execa } from "execa";
import type { TaskContract } from "@usine/task-authority";
import { remainingUntil } from "@usine/task-authority";

export async function verifyCommittedContract(
  contractPath: string,
  contract: TaskContract,
  deadlineEpochMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const repository = await realpath(contract.repository.path);
  const path = await realpath(contractPath);
  const relativePath = relative(repository, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("task contract must be a committed file in the authorized repository");
  }

  await execa("git", ["-C", repository, "ls-files", "--error-unmatch", relativePath], {
    env: environment,
    extendEnv: false,
    timeout: remainingUntil(deadlineEpochMs),
  });
  const status = await execa(
    "git",
    ["-C", repository, "status", "--porcelain", "--", relativePath],
    { env: environment, extendEnv: false, timeout: remainingUntil(deadlineEpochMs) },
  );
  if (status.stdout !== "") throw new Error("task contract has uncommitted changes");
  await execa("git", ["-C", repository, "cat-file", "-e", `${contract.baseSha}^{commit}`], {
    env: environment,
    extendEnv: false,
    timeout: remainingUntil(deadlineEpochMs),
  });
  await execa("git", ["-C", repository, "merge-base", "--is-ancestor", contract.baseSha, "HEAD"], {
    env: environment,
    extendEnv: false,
    timeout: remainingUntil(deadlineEpochMs),
  });
  return repository;
}
