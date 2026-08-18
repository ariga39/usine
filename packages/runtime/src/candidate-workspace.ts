import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import type { CapabilityEnvironments } from "./runtime-policy.js";
import { remainingUntil } from "./remaining-until.js";

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
  environment: CapabilityEnvironments;
}

export class CandidateWorkspace {
  private readonly fences = new Map<string, number>();

  constructor(private readonly options: WorkspaceOptions) {}

  async prepareWriter(
    taskId: string,
    activation: number,
    baseSha: string,
  ): Promise<WriterWorkspace> {
    if (!Number.isSafeInteger(activation) || activation < 1)
      throw new Error("activation must be positive");
    const fence = activation;
    const path = resolve(
      this.options.stateDirectory,
      "workspaces",
      taskId,
      `${activation}-${fence}`,
    );
    await mkdir(dirname(path), { recursive: true });
    await this.removeWorktree(path);
    await this.git(["-C", this.options.repository, "worktree", "add", "--detach", path, baseSha]);
    this.fences.set(taskId, fence);
    return { taskId, activation, fence, path, baseSha };
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

  async freeze(workspace: WriterWorkspace, previousSha: string): Promise<FrozenCandidate> {
    if (this.fences.get(workspace.taskId) !== workspace.fence)
      throw new Error("stale workspace fence");
    const head = await this.git(["-C", workspace.path, "rev-parse", "HEAD"]);
    const status = await this.git(["-C", workspace.path, "status", "--porcelain"]);
    let candidate = head.trim();
    if (candidate === previousSha) {
      if (!status.trim()) throw new Error("implementer proposed no workspace changes");
      const config = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Usine",
        "-c",
        "user.email=usine@example.invalid",
      ];
      await this.git([...config, "-C", workspace.path, "add", "--all"]);
      await this.git([
        ...config,
        "-C",
        workspace.path,
        "commit",
        "-m",
        "Implement authorized task",
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

  private async git(args: string[]): Promise<string> {
    const result = await execa("git", args, {
      env: this.options.environment.credentialFreeGit,
      extendEnv: false,
      timeout: remainingUntil(this.options.deadlineEpochMs),
      reject: true,
    });
    return String(result.stdout);
  }
}
