import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execa } from "execa";

export interface WriterWorkspace {
  taskId: string;
  activation: number;
  fence: number;
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
}

function timeoutUntil(deadlineEpochMs: number): number {
  const remaining = deadlineEpochMs - Date.now() - 100;
  if (remaining <= 0) throw new Error("elapsed budget exhausted");
  return Math.max(1, remaining);
}

function credentialFreeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

export class CandidateWorkspace {
  private readonly fences = new Map<string, number>();

  constructor(private readonly options: WorkspaceOptions) {}

  async prepareWriter(taskId: string, activation: number, baseSha: string): Promise<WriterWorkspace> {
    if (!Number.isSafeInteger(activation) || activation < 1) throw new Error("activation must be positive");
    const fence = activation;
    const path = resolve(this.options.stateDirectory, "workspaces", taskId, `${activation}-${fence}`);
    await mkdir(dirname(path), { recursive: true });
    await this.removeWorktree(path);
    await this.git(["-C", this.options.repository, "worktree", "add", "--detach", path, baseSha]);
    this.fences.set(taskId, fence);
    return { taskId, activation, fence, path, baseSha };
  }

  async freeze(workspace: WriterWorkspace, previousSha: string): Promise<FrozenCandidate> {
    if (this.fences.get(workspace.taskId) !== workspace.fence) throw new Error("stale workspace fence");
    const head = await this.git(["-C", workspace.path, "rev-parse", "HEAD"]);
    const status = await this.git(["-C", workspace.path, "status", "--porcelain"]);
    let candidate = head.trim();
    if (candidate === previousSha) {
      if (!status.trim()) throw new Error("implementer proposed no workspace changes");
      const config = ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Usine", "-c", "user.email=usine@example.invalid"];
      await this.git([...config, "-C", workspace.path, "add", "--all"], true);
      await this.git([...config, "-C", workspace.path, "commit", "-m", "Implement authorized task"], true);
      candidate = (await this.git(["-C", workspace.path, "rev-parse", "HEAD"])).trim();
    }
    if (candidate === previousSha) throw new Error("candidate did not advance exact SHA");
    if ((await this.git(["-C", workspace.path, "status", "--porcelain"])).trim()) throw new Error("candidate workspace is dirty");
    await this.git(["-C", workspace.path, "merge-base", "--is-ancestor", previousSha, candidate]);
    await this.git(["-C", workspace.path, "merge-base", "--is-ancestor", workspace.baseSha, candidate]);
    return { sha: candidate, baseSha: previousSha, workspace };
  }

  async withCheckout<T>(purpose: string, sha: string, callback: (path: string) => Promise<T>): Promise<T> {
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
    const current = this.fences.get(workspace.taskId);
    if (current === workspace.fence) this.fences.delete(workspace.taskId);
  }

  private async removeWorktree(path: string): Promise<void> {
    try {
      await this.git(["-C", this.options.repository, "worktree", "remove", "--force", path]);
    } catch {
      await rm(path, { recursive: true, force: true });
    }
  }

  private async git(args: string[], credentialFree = false): Promise<string> {
    const result = await execa("git", args, {
      env: credentialFree ? credentialFreeEnvironment() : undefined,
      extendEnv: !credentialFree,
      timeout: timeoutUntil(this.options.deadlineEpochMs),
      reject: true,
    });
    return String(result.stdout);
  }
}
