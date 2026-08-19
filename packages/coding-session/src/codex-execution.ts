import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CodexExecutionIdentity {
  version: 1;
  pid: number;
  startedAt: string;
  workspace: string;
}

export function codexExecutionIdentityPath(stateDirectory: string, workspace: string): string {
  const workspaceId = createHash("sha256").update(workspace).digest("hex");
  return join(stateDirectory, "codex-executions", `${workspaceId}.json`);
}

export async function removeCodexExecutionIdentity(
  stateDirectory: string,
  workspace: string,
): Promise<void> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, workspace);
  await Promise.all([
    unlink(identityPath).catch(() => undefined),
    unlink(`${identityPath}.mjs`).catch(() => undefined),
  ]);
}

export async function createCodexLauncher(
  stateDirectory: string,
  workspace: string,
): Promise<{ launcherPath: string; identityPath: string }> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, workspace);
  await mkdir(join(stateDirectory, "codex-executions"), { recursive: true });
  const launcherPath = `${identityPath}.mjs`;
  await writeFile(
    launcherPath,
    String.raw`#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn("codex", process.argv.slice(2), { detached: true, env: process.env, stdio: "inherit" });
if (!child.pid) throw new Error("Codex process has no PID");
const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
if (!startedAt) throw new Error("Codex process has no start identity");
writeFileSync(process.env.USINE_CODEX_IDENTITY_PATH, JSON.stringify({ version: 1, pid: child.pid, startedAt, workspace: process.env.USINE_CODEX_WORKSPACE }) + "\n");
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`,
    { mode: 0o755 },
  );
  return { launcherPath, identityPath };
}

export async function reapCodexExecution(
  stateDirectory: string,
  workspace: string,
): Promise<number | null> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, workspace);
  let identity: CodexExecutionIdentity;
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isCodexExecutionIdentity(decoded)) throw new Error("Codex execution identity is invalid");
    identity = decoded;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await unlink(`${identityPath}.mjs`).catch(() => undefined);
      return null;
    }
    throw error;
  }
  if (identity.workspace !== workspace) throw new Error("Codex execution identity is invalid");
  let currentStart: string;
  try {
    currentStart = execFileSync("ps", ["-o", "lstart=", "-p", String(identity.pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    await removeCodexExecutionIdentity(stateDirectory, workspace);
    return identity.pid;
  }
  if (currentStart !== identity.startedAt)
    throw new Error("Codex execution identity no longer belongs to this task");
  process.kill(-identity.pid, "SIGKILL");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) {
        await removeCodexExecutionIdentity(stateDirectory, workspace);
        return identity.pid;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Codex execution did not exit during recovery");
}

function isCodexExecutionIdentity(value: unknown): value is CodexExecutionIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid >= 2 &&
    "startedAt" in value &&
    typeof value.startedAt === "string" &&
    value.startedAt.length > 0 &&
    "workspace" in value &&
    typeof value.workspace === "string"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
