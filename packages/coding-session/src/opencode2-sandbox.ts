import { constants } from "node:fs";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, normalize, resolve } from "node:path";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_TERMINATION_GRACE_MS = 250;
const PROBE_REAP_WAIT_MS = 250;

export interface OpenCode2SandboxRequest {
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly role: "implementer" | "reviewer";
  readonly environment: Record<string, string>;
  readonly signal: AbortSignal;
}

export interface OpenCode2SandboxLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface OpenCode2SandboxEvidence {
  readonly host: "darwin-seatbelt";
  readonly role: "implementer" | "reviewer";
  readonly workspaceRead: "verified";
  readonly workspaceWrite: "verified" | "denied";
  readonly externalRead: "denied";
  readonly externalWrite: "denied";
  readonly subprocess: "inherited";
}

export interface OpenCode2Sandbox {
  prepare(request: OpenCode2SandboxRequest): Promise<{
    readonly launch: OpenCode2SandboxLaunch;
    readonly evidence: OpenCode2SandboxEvidence;
  }>;
}

export class OpenCode2SandboxUnavailableError extends Error {
  readonly code = "opencode2_sandbox_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "OpenCode2SandboxUnavailableError";
  }
}

/** The only supported OpenCode2 host boundary. */
export class DarwinOpenCode2Sandbox implements OpenCode2Sandbox {
  async prepare(request: OpenCode2SandboxRequest): Promise<{
    readonly launch: OpenCode2SandboxLaunch;
    readonly evidence: OpenCode2SandboxEvidence;
  }> {
    if (process.platform !== "darwin")
      throw new OpenCode2SandboxUnavailableError(
        "OpenCode2 requires a macOS seatbelt host; activation is disabled on this host",
      );
    if (request.signal.aborted)
      throw new OpenCode2SandboxUnavailableError("OpenCode2 sandbox preflight was cancelled");
    try {
      await access(SANDBOX_EXECUTABLE);
    } catch {
      throw new OpenCode2SandboxUnavailableError(
        "OpenCode2 requires /usr/bin/sandbox-exec; activation is disabled on this host",
      );
    }

    const workspace = resolve(request.workspace);
    const privateDirectory = resolve(request.privateDirectory);
    const opencodeExecutable = await resolveExecutable(request.environment.PATH);
    const probeDirectory = join(dirname(privateDirectory), ".sandbox-probe");
    const outsidePath = join(probeDirectory, "outside");
    const workspaceProbe = join(workspace, ".usine-opencode2-sandbox-probe");
    await mkdir(probeDirectory, { recursive: true });
    await writeFile(outsidePath, "outside", { encoding: "utf8", flag: "w", mode: 0o600 });
    await writeFile(workspaceProbe, "workspace", { encoding: "utf8", flag: "w", mode: 0o600 });
    try {
      const profile = sandboxProfile({
        workspace,
        privateDirectory,
        opencodeExecutable,
        role: request.role,
      });
      const probe = await runProbe({
        profile,
        role: request.role,
        workspaceProbe,
        outsidePath,
        privateDirectory,
        signal: request.signal,
      });
      if (!probe.ok)
        throw new OpenCode2SandboxUnavailableError(
          `OpenCode2 sandbox preflight failed (${probe.reason}); activation is disabled`,
        );
      return {
        launch: { command: SANDBOX_EXECUTABLE, args: ["-p", profile, opencodeExecutable] },
        evidence: {
          host: "darwin-seatbelt",
          role: request.role,
          workspaceRead: "verified",
          workspaceWrite: request.role === "implementer" ? "verified" : "denied",
          externalRead: "denied",
          externalWrite: "denied",
          subprocess: "inherited",
        },
      };
    } finally {
      await Promise.all([
        rm(workspaceProbe, { force: true }),
        rm(probeDirectory, { recursive: true, force: true }),
      ]);
    }
  }
}

export function sandboxProfile(input: {
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly opencodeExecutable: string;
  readonly role: "implementer" | "reviewer";
}): string {
  const workspace = resolve(input.workspace);
  const privateDirectory = resolve(input.privateDirectory);
  const opencodeExecutable = resolve(input.opencodeExecutable);
  const nodeExecutable = resolve(process.execPath);
  const nodeDirectory = dirname(nodeExecutable);
  const opencodeDirectory = dirname(opencodeExecutable);
  const writableWorkspace =
    input.role === "implementer" ? `(allow file-write* ${subpath(workspace)})` : "";
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-exec process-fork process-signal)",
    "(allow network-outbound)",
    `(allow file-read* file-map-executable ${subpath(nodeDirectory)})`,
    `(allow file-read* file-map-executable ${subpath(opencodeDirectory)})`,
    `(allow file-read* file-map-executable ${subpath(privateDirectory)})`,
    `(allow file-read* file-map-executable ${subpath(workspace)})`,
    `(allow file-write* ${subpath(privateDirectory)})`,
    writableWorkspace,
  ]
    .filter(Boolean)
    .join(" ");
}

type ProbeChildFactory = (command: string, args: readonly string[]) => ChildProcess;

export async function runProbe(
  input: {
    readonly profile: string;
    readonly role: "implementer" | "reviewer";
    readonly workspaceProbe: string;
    readonly outsidePath: string;
    readonly privateDirectory: string;
    readonly signal: AbortSignal;
  },
  spawnProbe: ProbeChildFactory = (command, args) => spawn(command, args, { stdio: "ignore" }),
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const childCode = `require("node:fs").writeFileSync(${JSON.stringify(input.outsidePath)}, "child")`;
  const shellOutsideCode = `printf shell > ${shellQuote(input.outsidePath)}`;
  const shellWorkspaceCode = `printf shell > ${shellQuote(input.workspaceProbe)}`;
  const script = `
const fs = require("node:fs");
const cp = require("node:child_process");
const attempt = (fn) => { try { fn(); return "allowed"; } catch (error) { return error && error.code ? error.code : "failed"; } };
const result = {
  workspaceRead: attempt(() => fs.readFileSync(${JSON.stringify(input.workspaceProbe)})),
  workspaceWrite: attempt(() => fs.writeFileSync(${JSON.stringify(input.workspaceProbe)}, "workspace")),
  externalRead: attempt(() => fs.readFileSync(${JSON.stringify(input.outsidePath)})),
  externalWrite: attempt(() => fs.writeFileSync(${JSON.stringify(input.outsidePath)}, "external")),
  privateWrite: attempt(() => fs.writeFileSync(${JSON.stringify(join(input.privateDirectory, "probe"))}, "private")),
  shellWorkspaceWrite: attempt(() => cp.execFileSync("/bin/sh", ["-c", ${JSON.stringify(shellWorkspaceCode)}])),
  shellExternalWrite: attempt(() => cp.execFileSync("/bin/sh", ["-c", ${JSON.stringify(shellOutsideCode)}])),
  childExternalWrite: attempt(() => cp.execFileSync(process.execPath, ["-e", ${JSON.stringify(childCode)}])),
};
if (result.workspaceRead !== "allowed") process.exit(20);
if (${String(input.role === "implementer")} ? result.workspaceWrite !== "allowed" : result.workspaceWrite === "allowed") process.exit(21);
if (${String(input.role === "implementer")} ? result.shellWorkspaceWrite !== "allowed" : result.shellWorkspaceWrite === "allowed") process.exit(22);
if (result.externalRead === "allowed" || result.externalWrite === "allowed" || result.shellExternalWrite === "allowed" || result.childExternalWrite === "allowed") process.exit(23);
if (result.privateWrite !== "allowed") process.exit(24);
`;
  const child = spawnProbe(SANDBOX_EXECUTABLE, [
    "-p",
    input.profile,
    process.execPath,
    "-e",
    script,
  ]);
  return await new Promise((resolveResult) => {
    let settled = false;
    let terminationReason: "cancellation" | "timeout" | undefined;
    let childError: string | undefined;
    let resolveClose!: () => void;
    const close = new Promise<void>((resolveCloseResult) => {
      resolveClose = resolveCloseResult;
    });
    const finish = (
      result: { readonly ok: true } | { readonly ok: false; readonly reason: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const waitForClose = async (milliseconds: number): Promise<boolean> =>
      await Promise.race([
        close.then(() => true),
        new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), milliseconds)),
      ]);
    const terminate = async (reason: "cancellation" | "timeout"): Promise<void> => {
      if (terminationReason) return;
      terminationReason = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event remains the reaping observation.
      }
      if (await waitForClose(PROBE_TERMINATION_GRACE_MS)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // A concurrently exiting child is handled by the close event below.
      }
      if (await waitForClose(PROBE_REAP_WAIT_MS)) return;
      finish({ ok: false, reason: `${reason}; probe child did not close` });
    };
    const onAbort = () => {
      void terminate("cancellation");
    };
    const timer = setTimeout(() => {
      void terminate("timeout");
    }, PROBE_TIMEOUT_MS);
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      childError = error.message;
    });
    child.once("close", (code, signal) => {
      resolveClose();
      if (terminationReason) {
        finish({ ok: false, reason: terminationReason });
      } else if (childError) {
        finish({ ok: false, reason: childError });
      } else {
        finish(
          code === 0
            ? { ok: true }
            : { ok: false, reason: `probe exited ${code ?? "null"}/${signal ?? "null"}` },
        );
      }
    });
    if (input.signal.aborted) void terminate("cancellation");
  });
}

function subpath(path: string): string {
  return `(subpath "${sbplString(normalize(path))}")`;
}

function sbplString(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function resolveExecutable(pathValue: string | undefined): Promise<string> {
  const candidates = (pathValue ?? "")
    .split(":")
    .filter(Boolean)
    .map((directory) => join(directory, "opencode"));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      await access(canonical, constants.X_OK);
      return canonical;
    } catch {
      // Continue through the explicit worker PATH.
    }
  }
  throw new OpenCode2SandboxUnavailableError(
    "OpenCode2 executable is not on the explicit worker PATH; activation is disabled",
  );
}
