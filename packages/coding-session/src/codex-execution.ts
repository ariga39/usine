import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutionHandle,
  ExecutionLifecycle,
  ExecutionReference,
} from "./coding-session-types.js";

const STARTING_OWNERSHIP_WAIT_MS = 2_000;
const EXECUTION_POLL_INTERVAL_MS = 10;

export class ExecutionOwnershipError extends Error {
  readonly code = "codex_execution_ownership_error" as const;

  constructor(
    message: string,
    readonly reason: "incomplete" | "mismatch",
  ) {
    super(message);
    this.name = "CodexExecutionOwnershipError";
  }
}

interface StartingExecutionIdentity {
  version: 2;
  state: "starting";
  reference: ExecutionReference;
  workspace: string;
}

interface RunningExecutionIdentity {
  version: 2;
  state: "running";
  reference: ExecutionReference;
  pid: number;
  startedAt: string;
  workspace: string;
}

type ExecutionIdentity = StartingExecutionIdentity | RunningExecutionIdentity;

export function executionIdentityPath(
  stateDirectory: string,
  reference: ExecutionReference,
): string {
  const executionId = [reference.taskId, reference.role, reference.attempt].join("\0");
  const executionHash = createHash("sha256").update(executionId).digest("hex");
  return join(stateDirectory, "codex-executions", `${executionHash}.json`);
}

export async function removeOwnedExecutionIdentity(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<boolean> {
  const identityPath = executionIdentityPath(stateDirectory, reference);
  let identity: ExecutionIdentity | null = null;
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isExecutionIdentity(decoded) || !sameReference(decoded.reference, reference)) return false;
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

export async function createOwnedProcessLauncher(
  stateDirectory: string,
  workspace: string,
  reference: ExecutionReference,
  executable: string,
): Promise<{ launcherPath: string; identityPath: string }> {
  const handle = await executionLifecycle.start(reference, stateDirectory, workspace);
  const identityPath = executionIdentityPath(stateDirectory, handle.reference);
  const launcherPath = `${identityPath}.mjs`;
  try {
    await writeFile(
      launcherPath,
      String.raw`#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(${JSON.stringify(executable)}, [...process.argv.slice(2)], { detached: true, env: process.env, stdio: "inherit" });
const forwardSignal = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
process.once("SIGHUP", () => forwardSignal("SIGHUP"));
if (!child.pid) throw new Error("Codex process has no PID");
const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
if (!startedAt) throw new Error("Codex process has no start identity");
const identityPath = process.env.USINE_CODING_SESSION_IDENTITY_PATH ?? process.env.USINE_CODEX_IDENTITY_PATH;
const executionWorkspace = process.env.USINE_CODING_SESSION_WORKSPACE ?? process.env.USINE_CODEX_WORKSPACE;
if (!identityPath || !executionWorkspace) throw new Error("owned process identity configuration is missing");
writeFileSync(identityPath, JSON.stringify({ version: 2, state: "running", reference: ${JSON.stringify(reference)}, pid: child.pid, startedAt, workspace: executionWorkspace }) + "\n");
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`,
      { mode: 0o755 },
    );
  } catch (error) {
    await discardStartingOwnedExecution(stateDirectory, reference);
    throw error;
  }
  return { launcherPath, identityPath };
}

/** Remove an identity whose launcher failed before recording a child PID. */
export async function discardStartingOwnedExecution(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<boolean> {
  const identityPath = executionIdentityPath(stateDirectory, reference);
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (
      !isExecutionIdentity(decoded) ||
      decoded.state !== "starting" ||
      !sameReference(decoded.reference, reference)
    )
      return false;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    return false;
  }
  await Promise.all([
    unlink(identityPath).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
    unlink(`${identityPath}.mjs`).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
  ]);
  return true;
}

export function createCodexLauncher(
  stateDirectory: string,
  workspace: string,
  reference: ExecutionReference,
): Promise<{ launcherPath: string; identityPath: string }> {
  return createOwnedProcessLauncher(stateDirectory, workspace, reference, "codex");
}

export async function discoverOwnedExecutions(
  stateDirectory: string,
  taskId: string,
): Promise<readonly ExecutionHandle[]> {
  return executionLifecycle.discover(stateDirectory, taskId);
}

export async function listExecutionTaskIds(stateDirectory: string): Promise<string[]> {
  return [
    ...new Set(
      (await discoverExecutionHandles(stateDirectory)).map(({ reference }) => reference.taskId),
    ),
  ];
}

export async function reapOwnedExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
): Promise<void> {
  await terminateOwnedExecution(stateDirectory, handle, "reap");
}

export async function stopOwnedExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
): Promise<void> {
  await terminateOwnedExecution(stateDirectory, handle, "interrupt");
}

async function terminateOwnedExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
  mode: "interrupt" | "reap",
): Promise<void> {
  const identity = await readExecutionIdentity(stateDirectory, handle.reference);
  if (!identity) return;
  if (!sameReference(identity.reference, handle.reference))
    throw new ExecutionOwnershipError(
      "Codex execution identity reference is mismatched",
      "mismatch",
    );
  const ownedIdentity =
    identity.state === "starting"
      ? await waitForOwnership(stateDirectory, handle.reference, identity)
      : identity;
  if (!ownedIdentity) return;
  if (ownedIdentity.state === "starting")
    throw new ExecutionOwnershipError(
      "Codex execution identity was interrupted before process ownership was recorded",
      "incomplete",
    );
  let state = processState(ownedIdentity);
  if (state === "stopped") return cleanStoppedExecution(stateDirectory, handle.reference);
  if (state === "mismatch") throw ownershipMismatch();

  state = sendTerminationSignal(ownedIdentity, mode === "interrupt" ? "SIGTERM" : "SIGKILL");
  if (state === "stopped") return cleanStoppedExecution(stateDirectory, handle.reference);
  state = await waitForTermination(ownedIdentity);
  if (state === "stopped") return cleanStoppedExecution(stateDirectory, handle.reference);
  if (state === "mismatch") throw ownershipMismatch();
  if (mode === "reap") throw executionStillLive();

  state = sendTerminationSignal(ownedIdentity, "SIGKILL");
  if (state === "stopped") return cleanStoppedExecution(stateDirectory, handle.reference);
  state = await waitForTermination(ownedIdentity);
  if (state === "stopped") return cleanStoppedExecution(stateDirectory, handle.reference);
  if (state === "mismatch") throw ownershipMismatch();
  throw executionStillLive();
}

async function waitForOwnership(
  stateDirectory: string,
  reference: ExecutionReference,
  initialIdentity: StartingExecutionIdentity,
): Promise<ExecutionIdentity | null> {
  const deadline = Date.now() + STARTING_OWNERSHIP_WAIT_MS;
  let identity: ExecutionIdentity = initialIdentity;
  while (identity.state === "starting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXECUTION_POLL_INTERVAL_MS));
    const nextIdentity = await readExecutionIdentity(stateDirectory, reference);
    if (!nextIdentity) return null;
    identity = nextIdentity;
  }
  return identity;
}

function sendTerminationSignal(
  identity: RunningExecutionIdentity,
  signal: NodeJS.Signals,
): "belongs" | "stopped" {
  try {
    process.kill(-identity.pid, signal);
    return "belongs";
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return "stopped";
    throw error;
  }
}

async function waitForTermination(
  identity: RunningExecutionIdentity,
): Promise<"belongs" | "stopped" | "mismatch"> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = processState(identity);
    if (state === "stopped" || state === "mismatch") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return processState(identity);
}

async function cleanStoppedExecution(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<void> {
  const identityPath = executionIdentityPath(stateDirectory, reference);
  await Promise.all([
    unlink(identityPath).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
    unlink(`${identityPath}.mjs`).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
  ]);
}

function ownershipMismatch(): ExecutionOwnershipError {
  return new ExecutionOwnershipError(
    "Codex execution identity no longer belongs to this task",
    "mismatch",
  );
}

function executionStillLive(): ExecutionOwnershipError {
  return new ExecutionOwnershipError("Codex execution did not exit during termination", "mismatch");
}

export const executionLifecycle: ExecutionLifecycle = {
  start: async (reference, stateDirectory, workspace) => {
    const identityPath = executionIdentityPath(stateDirectory, reference);
    await mkdir(join(stateDirectory, "codex-executions"), { recursive: true });
    await writeFile(
      identityPath,
      JSON.stringify({ version: 2, state: "starting", reference, workspace }) + "\n",
    );
    return { reference, workspace };
  },
  discover: async (stateDirectory, taskId) =>
    (await discoverExecutionHandles(stateDirectory)).filter(
      ({ reference }) => reference.taskId === taskId,
    ),
  observe: async (stateDirectory, handle) => {
    const identity = await readExecutionIdentity(stateDirectory, handle.reference);
    if (!identity) return "stopped";
    if (!sameReference(identity.reference, handle.reference)) throw ownershipMismatch();
    if (identity.state === "starting") return "starting";
    const state = processState(identity);
    if (state === "mismatch") throw ownershipMismatch();
    return state === "belongs" ? "running" : "stopped";
  },
  interrupt: stopOwnedExecution,
  reap: reapOwnedExecution,
};

async function readExecutionIdentity(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<ExecutionIdentity | null> {
  const identityPath = executionIdentityPath(stateDirectory, reference);
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isExecutionIdentity(decoded))
      throw new ExecutionOwnershipError("Codex execution identity is incomplete", "incomplete");
    if (!sameReference(decoded.reference, reference)) throw ownershipMismatch();
    return decoded;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function isExecutionIdentity(value: unknown): value is ExecutionIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 2 &&
    "state" in value &&
    (value.state === "starting" || value.state === "running") &&
    "reference" in value &&
    isExecutionReference(value.reference) &&
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

function isExecutionReference(value: unknown): value is ExecutionReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    "role" in value &&
    (value.role === "implementer" || value.role === "reviewer") &&
    "attempt" in value &&
    typeof value.attempt === "string" &&
    value.attempt.length > 0
  );
}

async function discoverExecutionHandles(stateDirectory: string): Promise<ExecutionHandle[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(stateDirectory, "codex-executions"), { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const identityFiles = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      const identityName = entry.name.slice(0, -".mjs".length);
      if (!identityFiles.has(identityName))
        throw new Error("Codex execution launcher has no durable identity");
    }
  }
  const identities: ExecutionHandle[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const identityPath = join(stateDirectory, "codex-executions", entry.name);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(identityPath, "utf8"));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!isExecutionIdentity(decoded)) throw new Error("Codex execution identity is invalid");
    if (executionIdentityPath(stateDirectory, decoded.reference) !== identityPath)
      throw new Error("Codex execution identity path is invalid");
    identities.push({ reference: decoded.reference, workspace: decoded.workspace });
  }
  return identities;
}

function processStillBelongsToExecution(identity: RunningExecutionIdentity): boolean {
  return processState(identity) === "belongs";
}

function processState(identity: RunningExecutionIdentity): "belongs" | "stopped" | "mismatch" {
  let currentStart = "";
  try {
    currentStart = execFileSync("ps", ["-o", "lstart=", "-p", String(identity.pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    // The leader may have exited while its process group is still alive.
  }
  if (currentStart && currentStart !== identity.startedAt) return "mismatch";
  return processGroupState(identity.pid);
}

function processGroupState(pid: number): "belongs" | "stopped" {
  try {
    const output = execFileSync("ps", ["-o", "pid=,stat=", "-g", String(pid)], {
      encoding: "utf8",
    });
    const states = output
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2)[1])
      .filter((state): state is string => state !== undefined);
    if (states.length > 0)
      return states.some((state) => !/^[ZX]/.test(state)) ? "belongs" : "stopped";
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1)
      return "stopped";
    // Fall back to the process-group signal probe when ps cannot enumerate the group.
  }
  try {
    process.kill(-pid, 0);
    return "belongs";
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return "belongs";
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
  return "stopped";
}

function sameReference(left: ExecutionReference, right: ExecutionReference): boolean {
  return left.taskId === right.taskId && left.role === right.role && left.attempt === right.attempt;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// Compatibility names for existing Codex callers. The implementation above is
// provider-neutral; these aliases preserve the established public package API.
export const codexExecutionIdentityPath = executionIdentityPath;
export const removeCodexExecutionIdentity = removeOwnedExecutionIdentity;
export const reapCodexExecution = reapOwnedExecution;
export const stopCodexExecution = stopOwnedExecution;
export { ExecutionOwnershipError as CodexExecutionOwnershipError };
export type {
  ExecutionHandle,
  ExecutionLifecycle,
  ExecutionObservation,
  ExecutionReference,
} from "./coding-session-types.js";
