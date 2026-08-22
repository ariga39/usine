import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STARTING_OWNERSHIP_WAIT_MS = 500;
const EXECUTION_POLL_INTERVAL_MS = 10;

export interface ExecutionReference {
  taskId: string;
  role: "implementer" | "reviewer";
  attempt: string;
}

export interface ExecutionHandle {
  reference: ExecutionReference;
  workspace: string;
}

export type ExecutionObservation = "starting" | "running" | "stopped";

export class CodexExecutionOwnershipError extends Error {
  readonly code = "codex_execution_ownership_error" as const;

  constructor(
    message: string,
    readonly reason: "incomplete" | "mismatch",
  ) {
    super(message);
    this.name = "CodexExecutionOwnershipError";
  }
}

export interface ExecutionLifecycle {
  start(
    reference: ExecutionReference,
    stateDirectory: string,
    workspace: string,
  ): Promise<ExecutionHandle>;
  discover(stateDirectory: string, taskId: string): Promise<readonly ExecutionHandle[]>;
  observe(stateDirectory: string, handle: ExecutionHandle): Promise<ExecutionObservation>;
  interrupt(stateDirectory: string, handle: ExecutionHandle): Promise<void>;
  reap(stateDirectory: string, handle: ExecutionHandle): Promise<void>;
}

interface StartingCodexExecutionIdentity {
  version: 2;
  state: "starting";
  reference: ExecutionReference;
  workspace: string;
}

interface RunningCodexExecutionIdentity {
  version: 2;
  state: "running";
  reference: ExecutionReference;
  pid: number;
  startedAt: string;
  workspace: string;
}

type CodexExecutionIdentity = StartingCodexExecutionIdentity | RunningCodexExecutionIdentity;

export function codexExecutionIdentityPath(
  stateDirectory: string,
  reference: ExecutionReference,
): string {
  const executionId = [reference.taskId, reference.role, reference.attempt].join("\0");
  const executionHash = createHash("sha256").update(executionId).digest("hex");
  return join(stateDirectory, "codex-executions", `${executionHash}.json`);
}

export async function removeCodexExecutionIdentity(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<boolean> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, reference);
  let identity: CodexExecutionIdentity | null = null;
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isCodexExecutionIdentity(decoded) || !sameReference(decoded.reference, reference))
      return false;
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
  reference: ExecutionReference,
): Promise<{ launcherPath: string; identityPath: string }> {
  const handle = await executionLifecycle.start(reference, stateDirectory, workspace);
  const identityPath = codexExecutionIdentityPath(stateDirectory, handle.reference);
  const launcherPath = `${identityPath}.mjs`;
  await writeFile(
    launcherPath,
    String.raw`#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn("codex", [...process.argv.slice(2)], { detached: true, env: process.env, stdio: "inherit" });
const forwardSignal = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
process.once("SIGHUP", () => forwardSignal("SIGHUP"));
if (!child.pid) throw new Error("Codex process has no PID");
const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
if (!startedAt) throw new Error("Codex process has no start identity");
writeFileSync(process.env.USINE_CODEX_IDENTITY_PATH, JSON.stringify({ version: 2, state: "running", reference: ${JSON.stringify(reference)}, pid: child.pid, startedAt, workspace: process.env.USINE_CODEX_WORKSPACE }) + "\n");
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`,
    { mode: 0o755 },
  );
  return { launcherPath, identityPath };
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

export async function reapCodexExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
): Promise<void> {
  await terminateCodexExecution(stateDirectory, handle, "reap");
}

export async function stopCodexExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
): Promise<void> {
  await terminateCodexExecution(stateDirectory, handle, "interrupt");
}

async function terminateCodexExecution(
  stateDirectory: string,
  handle: ExecutionHandle,
  mode: "interrupt" | "reap",
): Promise<void> {
  const identity = await readExecutionIdentity(stateDirectory, handle.reference);
  if (!identity) return;
  if (!sameReference(identity.reference, handle.reference))
    throw new CodexExecutionOwnershipError(
      "Codex execution identity reference is mismatched",
      "mismatch",
    );
  const ownedIdentity =
    identity.state === "starting"
      ? await waitForOwnership(stateDirectory, handle.reference, identity)
      : identity;
  if (!ownedIdentity) return;
  if (ownedIdentity.state === "starting")
    throw new CodexExecutionOwnershipError(
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
  initialIdentity: StartingCodexExecutionIdentity,
): Promise<CodexExecutionIdentity | null> {
  const deadline = Date.now() + STARTING_OWNERSHIP_WAIT_MS;
  let identity: CodexExecutionIdentity = initialIdentity;
  while (identity.state === "starting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXECUTION_POLL_INTERVAL_MS));
    const nextIdentity = await readExecutionIdentity(stateDirectory, reference);
    if (!nextIdentity) return null;
    identity = nextIdentity;
  }
  return identity;
}

function sendTerminationSignal(
  identity: RunningCodexExecutionIdentity,
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
  identity: RunningCodexExecutionIdentity,
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
  const identityPath = codexExecutionIdentityPath(stateDirectory, reference);
  await Promise.all([
    unlink(identityPath).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
    unlink(`${identityPath}.mjs`).catch((error) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }),
  ]);
}

function ownershipMismatch(): CodexExecutionOwnershipError {
  return new CodexExecutionOwnershipError(
    "Codex execution identity no longer belongs to this task",
    "mismatch",
  );
}

function executionStillLive(): CodexExecutionOwnershipError {
  return new CodexExecutionOwnershipError(
    "Codex execution did not exit during termination",
    "mismatch",
  );
}

export const executionLifecycle: ExecutionLifecycle = {
  start: async (reference, stateDirectory, workspace) => {
    const identityPath = codexExecutionIdentityPath(stateDirectory, reference);
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
  interrupt: stopCodexExecution,
  reap: reapCodexExecution,
};

async function readExecutionIdentity(
  stateDirectory: string,
  reference: ExecutionReference,
): Promise<CodexExecutionIdentity | null> {
  const identityPath = codexExecutionIdentityPath(stateDirectory, reference);
  try {
    const decoded: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isCodexExecutionIdentity(decoded))
      throw new CodexExecutionOwnershipError(
        "Codex execution identity is incomplete",
        "incomplete",
      );
    if (!sameReference(decoded.reference, reference)) throw ownershipMismatch();
    return decoded;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function isCodexExecutionIdentity(value: unknown): value is CodexExecutionIdentity {
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
    if (!isCodexExecutionIdentity(decoded)) throw new Error("Codex execution identity is invalid");
    if (codexExecutionIdentityPath(stateDirectory, decoded.reference) !== identityPath)
      throw new Error("Codex execution identity path is invalid");
    identities.push({ reference: decoded.reference, workspace: decoded.workspace });
  }
  return identities;
}

function processStillBelongsToExecution(identity: RunningCodexExecutionIdentity): boolean {
  return processState(identity) === "belongs";
}

function processState(identity: RunningCodexExecutionIdentity): "belongs" | "stopped" | "mismatch" {
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
