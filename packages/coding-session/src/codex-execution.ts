import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface StartingCodexExecutionIdentity {
  version: 1;
  state: "starting";
  workspace: string;
}

interface RunningCodexExecutionIdentity {
  version: 1;
  state: "running";
  pid: number;
  startedAt: string;
  workspace: string;
}

type CodexExecutionIdentity = StartingCodexExecutionIdentity | RunningCodexExecutionIdentity;

export function codexExecutionIdentityPath(stateDirectory: string, workspace: string): string {
  const workspaceId = createHash("sha256").update(workspace).digest("hex");
  return join(stateDirectory, "codex-executions", `${workspaceId}.json`);
}

export async function removeCodexExecutionIdentity(
  stateDirectory: string,
  workspace: string,
): Promise<boolean> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, workspace);
  let identity: CodexExecutionIdentity | null = null;
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isCodexExecutionIdentity(decoded) || decoded.workspace !== workspace) return false;
    identity = decoded;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) return false;
  }
  if (identity?.state === "starting") return false;
  if (identity && processStillBelongsToExecution(identity)) return false;
  await Promise.all([
    unlink(identityPath).catch(() => undefined),
    unlink(`${identityPath}.mjs`).catch(() => undefined),
  ]);
  return true;
}

export async function createCodexLauncher(
  stateDirectory: string,
  workspace: string,
  profile: string,
): Promise<{ launcherPath: string; identityPath: string }> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, workspace);
  await mkdir(join(stateDirectory, "codex-executions"), { recursive: true });
  const launcherPath = `${identityPath}.mjs`;
  await writeFile(
    launcherPath,
    String.raw`#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync(process.env.USINE_CODEX_IDENTITY_PATH, JSON.stringify({ version: 1, state: "starting", workspace: process.env.USINE_CODEX_WORKSPACE }) + "\n");
const child = spawn("codex", ["--profile", ${JSON.stringify(profile)}, ...process.argv.slice(2)], { detached: true, env: process.env, stdio: "inherit" });
const forwardSignal = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
process.once("SIGHUP", () => forwardSignal("SIGHUP"));
if (!child.pid) throw new Error("Codex process has no PID");
const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
if (!startedAt) throw new Error("Codex process has no start identity");
writeFileSync(process.env.USINE_CODEX_IDENTITY_PATH, JSON.stringify({ version: 1, state: "running", pid: child.pid, startedAt, workspace: process.env.USINE_CODEX_WORKSPACE }) + "\n");
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
  if (identity.state === "starting") {
    throw new Error(
      "Codex execution identity was interrupted before process ownership was recorded",
    );
  }
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

export async function stopCodexExecution(
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
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (identity.workspace !== workspace) throw new Error("Codex execution identity is invalid");
  if (identity.state === "starting")
    throw new Error(
      "Codex execution identity was interrupted before process ownership was recorded",
    );
  const initialState = processState(identity);
  if (initialState === "stopped") {
    await removeCodexExecutionIdentity(stateDirectory, workspace);
    return identity.pid;
  }
  if (initialState === "mismatch")
    throw new Error("Codex execution identity no longer belongs to this task");
  try {
    process.kill(-identity.pid, "SIGTERM");
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = processState(identity);
    if (state === "stopped") {
      await removeCodexExecutionIdentity(stateDirectory, workspace);
      return identity.pid;
    }
    if (state === "mismatch")
      throw new Error("Codex execution identity no longer belongs to this task");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (processState(identity) === "belongs") {
    process.kill(-identity.pid, "SIGKILL");
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const state = processState(identity);
      if (state === "stopped") {
        await removeCodexExecutionIdentity(stateDirectory, workspace);
        return identity.pid;
      }
      if (state === "mismatch")
        throw new Error("Codex execution identity no longer belongs to this task");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Codex execution did not exit during graceful shutdown");
}

function isCodexExecutionIdentity(value: unknown): value is CodexExecutionIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "state" in value &&
    (value.state === "starting" || value.state === "running") &&
    "workspace" in value &&
    typeof value.workspace === "string" &&
    (value.state === "starting" ||
      ("pid" in value &&
        typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid) &&
        value.pid >= 2 &&
        "startedAt" in value &&
        typeof value.startedAt === "string" &&
        value.startedAt.length > 0))
  );
}

function processStillBelongsToExecution(identity: RunningCodexExecutionIdentity): boolean {
  return processState(identity) === "belongs";
}

function processState(identity: RunningCodexExecutionIdentity): "belongs" | "stopped" | "mismatch" {
  try {
    const currentStart = execFileSync("ps", ["-o", "lstart=", "-p", String(identity.pid)], {
      encoding: "utf8",
    }).trim();
    if (!currentStart) return "stopped";
    return currentStart === identity.startedAt ? "belongs" : "mismatch";
  } catch {
    return "stopped";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
