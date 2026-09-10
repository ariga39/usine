import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OpenCode2Adapter } from "../../src/opencode2-adapter.js";
import {
  DarwinOpenCode2Sandbox,
  sandboxProfile,
  type OpenCode2Sandbox,
} from "../../src/opencode2-sandbox.js";

const enabled = process.env.USINE_PRIVATE_OPENCODE2_QUALIFICATION === "1";
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

describe.skipIf(!enabled)("private installed OpenCode2 qualification", () => {
  test.each(["implementer", "reviewer"] as const)(
    "%s starts without a model request and remains loopback-only for inbound traffic",
    async (role) => {
      const root = await mkdtemp(join(tmpdir(), "usine-opencode2-qualification-"));
      const stateDirectory = join(root, "state");
      const workspace = join(root, "workspace");
      const launchRecord = join(root, "launch-record");
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const phases: string[] = [];
      const observations: unknown[] = [];
      const usage: unknown[] = [];
      let qualification: { wildcardBindAllowed: boolean; nonLoopbackBytes: number } | undefined;
      let probeFailure: unknown;
      await mkdir(workspace, { recursive: true });

      const sandbox: OpenCode2Sandbox = {
        prepare: async (request) => {
          const prepared = await new DarwinOpenCode2Sandbox().prepare(request);
          const wrapper = join(request.privateDirectory, "qualification-wrapper");
          const wrapperScript = [
            "#!/bin/sh",
            'printf \'%s %s\\n\' "$$" "$*" > ' + shellQuote(launchRecord),
            "exec " +
              shellQuote(prepared.launch.command) +
              " " +
              prepared.launch.args.map(shellQuote).join(" ") +
              ' "$@"',
            "",
          ].join("\n");
          await writeFile(wrapper, wrapperScript, { encoding: "utf8", mode: 0o700 });
          await chmod(wrapper, 0o700);
          return { ...prepared, launch: { command: wrapper, args: [] } };
        },
      };

      try {
        const run = new OpenCode2Adapter(stateDirectory, sandbox).run({
          role,
          workspace,
          prompt: "qualification stops after health; do not create a session",
          sandbox: role === "implementer" ? "workspace-write" : "read-only",
          approvalPolicy: "never",
          profile: { model: "qualification-unused-model" },
          outputSchema: {},
          environment: { PATH: process.env.PATH ?? "" },
          signal,
          onObservation: (observation) => {
            observations.push(observation);
          },
          onUsage: (observation) => {
            usage.push(observation);
          },
          onPhase: (phase) => {
            phases.push(phase);
            if (phase !== "thread") return;
            try {
              const record = readLaunchRecord(launchRecord);
              qualification = {
                wildcardBindAllowed: wildcardBindAllowed(
                  sandboxProfile({
                    workspace,
                    privateDirectory: requestPrivateDirectory(stateDirectory),
                    opencodeExecutable: process.execPath,
                    role,
                  }),
                ),
                nonLoopbackBytes: nonLoopbackBytes(record.port),
              };
            } catch (error) {
              probeFailure = error;
            } finally {
              controller.abort();
            }
          },
        });
        await expect(run).rejects.toMatchObject({
          phase: "thread",
          failureClass: "cancellation",
        });
        if (probeFailure !== undefined) throw probeFailure;
        expect(qualification).toEqual({
          wildcardBindAllowed: true,
          nonLoopbackBytes: 0,
        });
        expect(phases).toEqual(["thread"]);
        expect(observations).toEqual([expect.objectContaining({ type: "sandbox_verified", role })]);
        expect(observations).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "thread_started" })]),
        );
        expect(usage).toEqual([]);

        const record = readLaunchRecord(launchRecord);
        expect(record.hostname).toBe("127.0.0.1");
        expect(() => process.kill(record.pid, 0)).toThrow();
        await expect(reusablePort(record.port)).resolves.toBeUndefined();
        await expect(readdir(stateDirectory)).resolves.not.toContain(
          expect.stringContaining("opencode-private-"),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

function readLaunchRecord(path: string): { pid: number; port: number; hostname: string } {
  const record = readFileSync(path, "utf8");
  const pid = Number(record.match(/^(\d+)/)?.[1]);
  const port = Number(record.match(/--port=(\d+)/)?.[1]);
  const hostname = record.match(/--hostname=([^ ]+)/)?.[1] ?? "";
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(port) || !hostname)
    throw new Error("installed OpenCode2 launch record was incomplete");
  return { pid, port, hostname };
}

function wildcardBindAllowed(profile: string): boolean {
  const script =
    'const s=require("node:net").createServer();s.once("error",()=>process.exit(0));s.listen(0,"0.0.0.0",()=>process.exit(11));';
  const result = spawnSync(SANDBOX_EXECUTABLE, ["-p", profile, process.execPath, "-e", script], {
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 11 && result.status !== 0)
    throw new Error("wildcard bind qualification probe did not complete");
  return result.status === 11;
}

function nonLoopbackBytes(port: number): number {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new Error("non-loopback IPv4 qualification address was unavailable");
  const script = [
    'const net=require("node:net");',
    "let bytes=0;",
    "let finished=false;",
    "const finish=()=>{if(finished)return;finished=true;console.log(bytes);process.exit(0);};",
    "const socket=net.createConnection({host:" +
      JSON.stringify(address) +
      ",port:" +
      String(port) +
      ",timeout:700});",
    "socket.on('data',(chunk)=>{bytes+=chunk.length;});",
    "socket.on('error',finish);",
    "socket.on('timeout',finish);",
    "socket.on('close',finish);",
    "setTimeout(finish,1000);",
  ].join("");
  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  const bytes = Number(output.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error("non-loopback inbound qualification probe was invalid");
  return bytes;
}

function reusablePort(port: number): Promise<void> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

function requestPrivateDirectory(stateDirectory: string): string {
  const privateDirectory = readdirSync(stateDirectory).find((entry) =>
    entry.startsWith("opencode-private-"),
  );
  if (!privateDirectory) throw new Error("installed OpenCode2 private directory was unavailable");
  return join(stateDirectory, privateDirectory);
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
