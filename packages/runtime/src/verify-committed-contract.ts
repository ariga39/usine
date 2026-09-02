import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { execa } from "execa";
import type { ResolvedTaskContract } from "@usine/task-authority";
import { remainingUntil } from "@usine/task-authority";

export interface CommittedContract {
  readonly repository: string;
  readonly rawContract: string;
}

export async function verifyCommittedContract(
  committed: CommittedContract,
  contract: Pick<ResolvedTaskContract, "baseSha">,
  deadlineEpochMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await execa(
    "git",
    ["-C", committed.repository, "cat-file", "-e", `${contract.baseSha}^{commit}`],
    {
      env: environment,
      extendEnv: false,
      timeout: remainingUntil(deadlineEpochMs),
    },
  );
  await execa(
    "git",
    ["-C", committed.repository, "merge-base", "--is-ancestor", contract.baseSha, "HEAD"],
    { env: environment, extendEnv: false, timeout: remainingUntil(deadlineEpochMs) },
  );
}

export async function readCommittedContract(
  contractPath: string,
  repositoryPath: string,
  deadlineEpochMs: number,
  environment: NodeJS.ProcessEnv,
  maxBytes: number,
): Promise<CommittedContract> {
  const repository = await realpath(repositoryPath);
  const logicalPath = join(await realpath(dirname(contractPath)), basename(contractPath));

  const relativePath = relative(repository, logicalPath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("task contract must be a committed file in the authorized repository");
  }

  const gitOptions = {
    env: environment,
    extendEnv: false,
    timeout: remainingUntil(deadlineEpochMs),
  } as const;
  await execa(
    "git",
    ["-C", repository, "ls-files", "--error-unmatch", "--", relativePath],
    gitOptions,
  );
  const treeEntry = (
    await execa(
      "git",
      [
        "-C",
        repository,
        "ls-tree",
        "--format=%(objectmode) %(objecttype) %(objectname)",
        "HEAD",
        "--",
        relativePath,
      ],
      gitOptions,
    )
  ).stdout.trim();
  const [objectMode, objectType, blobSha] = treeEntry.split(/\s+/, 3);
  if (objectType !== "blob" || !blobSha || (objectMode !== "100644" && objectMode !== "100755"))
    throw new Error("task contract must be a committed regular file");
  const objectSize = Number(
    (await execa("git", ["-C", repository, "cat-file", "-s", blobSha], gitOptions)).stdout.trim(),
  );
  if (!Number.isSafeInteger(objectSize) || objectSize > maxBytes)
    throw new Error(`task contract exceeds the ${maxBytes}-byte limit`);
  const rawContract = (
    await execa("git", ["-C", repository, "cat-file", "blob", blobSha], {
      ...gitOptions,
      maxBuffer: maxBytes,
      stripFinalNewline: false,
    })
  ).stdout;
  if (Buffer.byteLength(rawContract, "utf8") !== objectSize)
    throw new Error("committed task contract bytes could not be read exactly");

  const status = await execa(
    "git",
    ["-C", repository, "status", "--porcelain", "--", relativePath],
    gitOptions,
  );
  if (status.stdout !== "") throw new Error("task contract has uncommitted changes");
  return { repository, rawContract };
}
