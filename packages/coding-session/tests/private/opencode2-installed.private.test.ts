import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { OpenCode2Adapter } from "../../src/opencode2-adapter.js";
import { DarwinOpenCode2Sandbox, type OpenCode2Sandbox } from "../../src/opencode2-sandbox.js";

const enabled = process.env.USINE_PRIVATE_OPENCODE2_QUALIFICATION === "1";
const PROBE_RESPONSE = "qualification probe";

describe.skipIf(!enabled)("private installed OpenCode2 qualification", () => {
  test.each(["implementer", "reviewer"] as const)(
    "%s starts without a model request and serves only its loopback endpoint",
    async (role) => {
      const root = await mkdtemp(join(tmpdir(), "usine-opencode2-qualification-"));
      const stateDirectory = join(root, "state");
      const workspace = join(root, "workspace");
      const outsideTemporaryDirectory = join(root, "outside-tmp");
      const launchRecord = join(root, "launch-record");
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const phases: string[] = [];
      const observations: unknown[] = [];
      const sessions: string[] = [];
      const usage: unknown[] = [];
      let endpointFailure: unknown;
      const address = Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
      if (!address) throw new Error("non-loopback IPv4 qualification address was unavailable");
      let privateDirectory = "";
      await mkdir(workspace, { recursive: true });
      await mkdir(outsideTemporaryDirectory);

      const sandbox: OpenCode2Sandbox = {
        prepare: async (request) => {
          const prepared = await new DarwinOpenCode2Sandbox().prepare(request);
          privateDirectory = request.privateDirectory;
          const wrapper = join(privateDirectory, "qualification-wrapper");
          await writeFile(
            wrapper,
            [
              "#!/bin/sh",
              'printf \'%s\\n%s\\n%s\\n\' "$$" "$TMPDIR" "$*" > ' + shellQuote(launchRecord),
              "exec " +
                shellQuote(prepared.launch.command) +
                " " +
                prepared.launch.args.map(shellQuote).join(" ") +
                ' "$@"',
              "",
            ].join("\n"),
            { encoding: "utf8", mode: 0o700 },
          );
          return { ...prepared, launch: { command: wrapper, args: [] } };
        },
      };

      try {
        await assertReachableInterface(address);
        await expect(
          new OpenCode2Adapter(stateDirectory, sandbox).run({
            role,
            workspace,
            prompt: "qualification stops after health; do not create a session",
            sandbox: role === "implementer" ? "workspace-write" : "read-only",
            approvalPolicy: "never",
            profile: { model: "qualification-unused-model" },
            outputSchema: {},
            environment: { PATH: process.env.PATH ?? "", TMPDIR: outsideTemporaryDirectory },
            signal,
            onObservation: (observation) => {
              observations.push(observation);
            },
            onSessionId: (session) => {
              sessions.push(session);
            },
            onUsage: (observation) => {
              usage.push(observation);
            },
            onPhase: (phase) => {
              phases.push(phase);
              if (phase !== "thread") return;
              try {
                const record = readLaunchRecord(launchRecord);
                expect(healthStatus("127.0.0.1", record.port)).toBe(200);
                expect(healthStatus(address, record.port)).toBe(0);
              } catch (error) {
                endpointFailure = error;
              }
              controller.abort();
              throw new Error("qualification completed before session creation");
            },
          }),
        ).rejects.toMatchObject({ phase: "thread", failureClass: "cancellation" });
        if (endpointFailure !== undefined) throw endpointFailure;
        expect(phases).toEqual(["thread"]);
        expect(observations).toEqual([
          expect.objectContaining({
            type: "sandbox_verified",
            role,
            workspaceRead: "verified",
            workspaceWrite: role === "implementer" ? "verified" : "denied",
            externalRead: "denied",
            externalWrite: "denied",
            subprocess: "inherited",
          }),
        ]);
        expect(sessions).toEqual([]);
        expect(usage).toEqual([]);

        const record = readLaunchRecord(launchRecord);
        expect(record.hostname).toBe("127.0.0.1");
        expect(record.temporaryDirectory).toBe(join(privateDirectory, "tmp"));
        expect(record.temporaryDirectory).not.toBe(outsideTemporaryDirectory);
        expect(() => process.kill(record.pid, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
        await expect(reusablePort(record.port)).resolves.toBeUndefined();
        expect(
          (await readdir(stateDirectory)).some((name) => name.startsWith("opencode-private-")),
        ).toBe(false);
      } finally {
        controller.abort();
        await rm(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

function readLaunchRecord(path: string): {
  pid: number;
  port: number;
  hostname: string;
  temporaryDirectory: string;
} {
  const [pidText, temporaryDirectory = "", args = ""] = readFileSync(path, "utf8").split("\n");
  const pid = Number(pidText);
  const port = Number(args.match(/--port=(\d+)/)?.[1]);
  const hostname = args.match(/--hostname=(\S+)/)?.[1] ?? "";
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    !hostname
  )
    throw new Error("installed OpenCode2 launch record was incomplete");
  return { pid, port, hostname, temporaryDirectory };
}

async function assertReachableInterface(address: string): Promise<void> {
  const control = createServer((socket) => socket.end(PROBE_RESPONSE));
  try {
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "0.0.0.0", resolve);
    });
    const bound = control.address();
    if (!bound || typeof bound === "string") throw new Error("control listener was unavailable");
    // Run asynchronously: this positive-control server is in the test process.
    const response = await new Promise<string>((resolve) => {
      const socket = connect({ host: address, port: bound.port });
      let output = "";
      const finish = (): void => {
        socket.destroy();
        resolve(output);
      };
      socket.setTimeout(700, finish);
      socket.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      socket.once("end", finish);
      socket.once("error", finish);
    });
    expect(response).toBe(PROBE_RESPONSE);
  } finally {
    await new Promise<void>((resolve) => control.close(() => resolve()));
  }
}

function healthStatus(host: string, port: number): number {
  const script = [
    'const http=require("node:http");',
    "let done=false;const finish=code=>{if(done)return;done=true;console.log(code);process.exit(0);};",
    "const request=http.get({host:" +
      JSON.stringify(host) +
      ",port:" +
      String(port) +
      ',path:"/api/health",timeout:700},response=>{response.resume();finish(response.statusCode);});',
    'request.on("error",()=>finish(0));request.on("timeout",()=>{request.destroy();finish(0);});',
  ].join("");
  return Number(
    execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim(),
  );
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

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
