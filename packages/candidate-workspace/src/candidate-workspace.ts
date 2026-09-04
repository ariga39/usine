import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { remainingUntil, type ResolvedTaskContract } from "@usine/task-authority";

const MAX_COMMIT_SUBJECT_LENGTH = 160;
const ESCAPE_CHARACTER = String.fromCodePoint(0x1b);
const BELL_CHARACTER = String.fromCodePoint(0x07);
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\))`,
  "gu",
);

const PORTABLE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface GitAuthor {
  name: string;
  email: string;
}

export interface WriterWorkspace {
  taskId: string;
  activation: number;
  path: string;
  baseSha: string;
}

export interface FrozenCandidate {
  sha: string;
  baseSha: string;
  workspace: WriterWorkspace;
}

export interface WorkspaceOptions {
  repository: string;
  stateDirectory: string;
  deadlineEpochMs: number;
  credentialFreeGit: NodeJS.ProcessEnv;
  gitAuthor: GitAuthor;
  signal?: AbortSignal;
}

function normalizeCommitSubjectPart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function commitSubjectForTask(contract: ResolvedTaskContract): string {
  const taskId = normalizeCommitSubjectPart(contract.id) || "unknown-task";
  const outcome = normalizeCommitSubjectPart(contract.delivery.title) || "authorized outcome";
  const prefix =
    contract.delivery.issue === undefined
      ? `Campaign [${taskId}]`
      : `#${contract.delivery.issue} [${taskId}]`;
  const availableOutcomeLength = MAX_COMMIT_SUBJECT_LENGTH - prefix.length - 1;
  return `${prefix} ${outcome.slice(0, Math.max(0, availableOutcomeLength)).trimEnd()}`;
}

export function credentialFreeGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const portable: NodeJS.ProcessEnv = {};
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) portable[key] = environment[key];
  }
  return {
    ...portable,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export class CandidateWorkspace {
  constructor(private readonly options: WorkspaceOptions) {}

  async prepareWriter(
    taskId: string,
    activation: number,
    baseSha: string,
  ): Promise<WriterWorkspace> {
    if (!Number.isSafeInteger(activation) || activation < 1)
      throw new Error("activation must be positive");
    const path = resolve(
      this.options.stateDirectory,
      "workspaces",
      taskId,
      `${activation}-${activation}`,
    );
    await mkdir(dirname(path), { recursive: true });
    await this.removeWorktree(path);
    try {
      await this.git(["-C", this.options.repository, "worktree", "add", "--detach", path, baseSha]);
    } catch (error) {
      await this.removeWorktree(path);
      throw error;
    }
    return { taskId, activation, path, baseSha };
  }

  async quarantinePriorWriters(taskId: string, activation: number): Promise<void> {
    const directory = resolve(this.options.stateDirectory, "workspaces", taskId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const priorActivation = Number(entry.split("-", 1)[0]);
      if (
        Number.isSafeInteger(priorActivation) &&
        priorActivation > 0 &&
        priorActivation < activation
      ) {
        await this.removeWorktree(resolve(directory, entry));
      }
    }
  }

  async freeze(
    workspace: WriterWorkspace,
    previousSha: string,
    contract: ResolvedTaskContract,
  ): Promise<FrozenCandidate> {
    const head = await this.git(["-C", workspace.path, "rev-parse", "HEAD"]);
    const status = await this.git(["-C", workspace.path, "status", "--porcelain"]);
    let candidate = head.trim();
    if (candidate === previousSha) {
      if (!status.trim()) throw new Error("implementer proposed no workspace changes");
      const config = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        `user.name=${this.options.gitAuthor.name}`,
        "-c",
        `user.email=${this.options.gitAuthor.email}`,
      ];
      await this.git([...config, "-C", workspace.path, "add", "--all"]);
      await this.git([
        ...config,
        "-C",
        workspace.path,
        "commit",
        "-m",
        commitSubjectForTask(contract),
      ]);
      candidate = (await this.git(["-C", workspace.path, "rev-parse", "HEAD"])).trim();
    }
    if (candidate === previousSha) throw new Error("candidate did not advance exact SHA");
    if ((await this.git(["-C", workspace.path, "status", "--porcelain"])).trim())
      throw new Error("candidate workspace is dirty");
    await this.git(["-C", workspace.path, "merge-base", "--is-ancestor", previousSha, candidate]);
    await this.git([
      "-C",
      workspace.path,
      "merge-base",
      "--is-ancestor",
      workspace.baseSha,
      candidate,
    ]);
    return { sha: candidate, baseSha: previousSha, workspace };
  }

  async withCheckout<T>(
    purpose: string,
    sha: string,
    callback: (path: string) => Promise<T>,
  ): Promise<T> {
    const path = resolve(this.options.stateDirectory, "checkouts", `${purpose}-${sha}`);
    await mkdir(dirname(path), { recursive: true });
    await this.removeWorktree(path);
    await this.git(["-C", this.options.repository, "worktree", "add", "--detach", path, sha]);
    try {
      return await callback(path);
    } finally {
      await this.removeWorktree(path);
    }
  }

  async quarantine(workspace: WriterWorkspace): Promise<void> {
    await this.removeWorktree(workspace.path);
  }

  private async removeWorktree(path: string): Promise<void> {
    try {
      await this.git(["-C", this.options.repository, "worktree", "remove", "--force", path]);
    } catch {
      await rm(path, { recursive: true, force: true });
    }
  }

  private async git(args: string[]): Promise<string> {
    const result = await execa("git", args, {
      env: this.options.credentialFreeGit,
      extendEnv: false,
      timeout: remainingUntil(this.options.deadlineEpochMs),
      cancelSignal: this.options.signal,
      reject: true,
    });
    return String(result.stdout);
  }
}
