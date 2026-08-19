import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa, type ResultPromise } from "execa";
import { describe, expect, test } from "vite-plus/test";

const fixtureExecutable = String.raw`#!/usr/bin/env node
import { access, appendFile, writeFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};

const activation = Number(required("USINE_ACTIVATION"));
const workspace = required("USINE_WORKSPACE");
const childRecord = required("USINE_CHILD_RECORD");
const releasePath = required("USINE_RELEASE_PATH");
const stalePath = required("USINE_STALE_PATH");

await appendFile(
  childRecord,
  JSON.stringify({ activation, pid: process.pid, parentPid: process.ppid }) + "\n",
);
await writeFile(workspace + "/activation-" + activation + "-before-loss", process.pid + "\n");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fixture-" + activation }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");

if (activation === 1) {
  while (true) {
    try {
      await access(releasePath);
      await writeFile(
        stalePath,
        JSON.stringify({ activation, pid: process.pid, parentPidAfterLoss: process.ppid }) + "\n",
      );
      await appendFile(
        childRecord,
        JSON.stringify({ activation, pid: process.pid, staleWrite: true }) + "\n",
      );
      setInterval(() => undefined, 1_000);
      await new Promise(() => undefined);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

process.stdout.write(
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      id: "message-" + activation,
      text: "activation-" + activation,
    },
  }) + "\n",
);
process.stdout.write(
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
  }) + "\n",
);
`;

const coordinatorScript = String.raw`import { pathToFileURL } from "node:url";
import { appendFile, mkdir, writeFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};

const { Codex } = await import(pathToFileURL(required("USINE_CODEX_SDK_ENTRY")).href);
const activation = Number(required("USINE_ACTIVATION"));
const workspace = required("USINE_WORKSPACE");
await mkdir(workspace, { recursive: true });
await appendFile(
  required("USINE_COORDINATOR_RECORD"),
  JSON.stringify({ activation, pid: process.pid }) + "\n",
);

const codex = new Codex({
  codexPathOverride: required("USINE_FIXTURE_PATH"),
  env: {
    CI: "true",
    CODEX_HOME: required("USINE_CODEX_HOME"),
    PATH: required("USINE_PATH"),
    USINE_ACTIVATION: String(activation),
    USINE_CHILD_RECORD: required("USINE_CHILD_RECORD"),
    USINE_RELEASE_PATH: required("USINE_RELEASE_PATH"),
    USINE_STALE_PATH: required("USINE_STALE_PATH"),
    USINE_WORKSPACE: workspace,
  },
});
const thread = codex.startThread({
  model: "characterization-model",
  sandboxMode: "workspace-write",
  workingDirectory: workspace,
});
const result = await thread.run("activation-" + activation);
await writeFile(
  required("USINE_RESULT_PATH"),
  JSON.stringify({ activation, threadId: thread.id, finalResponse: result.finalResponse }) + "\n",
);
`;

interface Fixture {
  root: string;
  oldWorkspace: string;
  newWorkspace: string;
  fixturePath: string;
  coordinatorPath: string;
  codexSdkEntry: string;
  coordinatorRecord: string;
  childRecord: string;
  releasePath: string;
  stalePath: string;
  firstResultPath: string;
  secondResultPath: string;
}

interface Coordinator {
  process: ResultPromise;
  done: boolean;
}

async function waitForFile(path: string, predicate: (content: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const content = await readFile(path, "utf8");
      if (predicate(content)) return content;
    } catch {
      // The process has not recorded this observation yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function records(content: string): Array<Record<string, unknown>> {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopAndReap(pids: Iterable<number>): Promise<void> {
  const recorded = [...new Set(pids)].filter((pid) => pid > 1 && pid !== process.pid);
  for (const pid of recorded) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (recorded.every((pid) => !processIsAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture process did not exit: ${recorded.join(", ")}`);
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "usine-codex-child-characterization-"));
  const oldWorkspace = join(root, "activation-1-workspace");
  const newWorkspace = join(root, "activation-2-workspace");
  const fixturePath = join(root, "local-codex-fixture.mjs");
  const coordinatorPath = join(root, "persistent-server.mjs");
  const codexSdkEntry = join(
    process.cwd(),
    "packages/coding-session/node_modules/@openai/codex-sdk/dist/index.js",
  );
  const coordinatorRecord = join(root, "coordinator-record.jsonl");
  const childRecord = join(root, "child-record.jsonl");
  const releasePath = join(root, "release-stale-child");
  const stalePath = join(oldWorkspace, "activation-1-stale-after-loss");
  const firstResultPath = join(root, "activation-1-result.json");
  const secondResultPath = join(root, "activation-2-result.json");
  await writeFile(fixturePath, fixtureExecutable, { mode: 0o755 });
  await chmod(fixturePath, 0o755);
  await writeFile(coordinatorPath, coordinatorScript);
  await writeFile(coordinatorRecord, "");
  await writeFile(childRecord, "");
  return {
    root,
    oldWorkspace,
    newWorkspace,
    fixturePath,
    coordinatorPath,
    codexSdkEntry,
    coordinatorRecord,
    childRecord,
    releasePath,
    stalePath,
    firstResultPath,
    secondResultPath,
  };
}

function startCoordinator(fixture: Fixture, activation: number): Coordinator {
  const workspace = activation === 1 ? fixture.oldWorkspace : fixture.newWorkspace;
  const resultPath = activation === 1 ? fixture.firstResultPath : fixture.secondResultPath;
  const child = execa(process.execPath, [fixture.coordinatorPath], {
    env: {
      ...process.env,
      USINE_ACTIVATION: String(activation),
      USINE_CHILD_RECORD: fixture.childRecord,
      USINE_CODEX_HOME: join(fixture.root, `codex-home-${activation}`),
      USINE_CODEX_SDK_ENTRY: fixture.codexSdkEntry,
      USINE_COORDINATOR_RECORD: fixture.coordinatorRecord,
      USINE_FIXTURE_PATH: fixture.fixturePath,
      USINE_PATH: process.env.PATH ?? "",
      USINE_RELEASE_PATH: fixture.releasePath,
      USINE_RESULT_PATH: resultPath,
      USINE_STALE_PATH: fixture.stalePath,
      USINE_WORKSPACE: workspace,
    },
    reject: false,
  });
  return { process: child, done: false };
}

describe("Codex child ownership after coordinator loss", () => {
  test("characterizes activation-1 child writes after SIGKILL and activation-2 recovery", async () => {
    const fixture = await createFixture();
    const recordedPids = new Set<number>();
    let first: Coordinator | undefined;
    let second: Coordinator | undefined;
    try {
      first = startCoordinator(fixture, 1);
      const firstCoordinator = JSON.parse(
        await waitForFile(fixture.coordinatorRecord, (content) =>
          content.includes('"activation":1'),
        ),
      ) as { activation: number; pid: number };
      const firstChild = records(
        await waitForFile(fixture.childRecord, (content) => content.includes('"activation":1')),
      ).find((record) => record.activation === 1) as {
        activation: number;
        pid: number;
        parentPid: number;
      };
      if (!firstChild) throw new Error("activation-1 child identity was not recorded");
      recordedPids.add(firstCoordinator.pid);
      recordedPids.add(firstChild.pid);

      expect(firstCoordinator.activation).toBe(1);
      expect(firstChild.parentPid).toBe(firstCoordinator.pid);
      expect(
        await readFile(join(fixture.oldWorkspace, "activation-1-before-loss"), "utf8"),
      ).toContain(String(firstChild.pid));
      expect(await readFile(fixture.stalePath, "utf8").catch(() => null)).toBeNull();

      first.process.kill("SIGKILL");
      const firstExit = await first.process;
      first.done = true;
      expect(firstExit.signal).toBe("SIGKILL");
      expect(processIsAlive(firstChild.pid)).toBe(true);

      second = startCoordinator(fixture, 2);
      await waitForFile(fixture.coordinatorRecord, (content) => content.includes('"activation":2'));
      const secondChild = records(
        await waitForFile(fixture.childRecord, (content) => content.includes('"activation":2')),
      ).find((record) => record.activation === 2) as { activation: number; pid: number };
      if (!secondChild) throw new Error("activation-2 child identity was not recorded");
      recordedPids.add(secondChild.pid);
      await writeFile(fixture.releasePath, "coordinator was SIGKILLed\n");

      const staleWrite = JSON.parse(
        await waitForFile(fixture.stalePath, (content) => content.length > 0),
      ) as {
        activation: number;
        pid: number;
      };
      const secondResult = JSON.parse(
        await waitForFile(fixture.secondResultPath, (content) => content.length > 0),
      ) as { activation: number; threadId: string; finalResponse: string };
      const secondExit = await second.process;
      second.done = true;

      expect(staleWrite).toMatchObject({ activation: 1, pid: firstChild.pid });
      expect(secondResult).toMatchObject({
        activation: 2,
        threadId: "fixture-2",
        finalResponse: "activation-2",
      });
      expect(secondExit.exitCode).toBe(0);
      expect(
        await readFile(join(fixture.newWorkspace, "activation-2-before-loss"), "utf8"),
      ).toContain(String(secondChild.pid));
      expect(
        await readFile(join(fixture.oldWorkspace, "activation-1-before-loss"), "utf8"),
      ).toContain(String(firstChild.pid));
      expect(processIsAlive(firstChild.pid)).toBe(true);
      expect(
        records(await readFile(fixture.childRecord, "utf8")).some(
          (record) => record.activation === 1 && record.staleWrite === true,
        ),
      ).toBe(true);
    } finally {
      if (first && !first.done) {
        first.process.kill("SIGKILL");
      }
      if (second && !second.done) {
        second.process.kill("SIGKILL");
      }
      for (const recordPath of [fixture.coordinatorRecord, fixture.childRecord]) {
        try {
          for (const record of records(await readFile(recordPath, "utf8"))) {
            if (typeof record.pid === "number") recordedPids.add(record.pid);
          }
        } catch {
          // A process may have been killed while its identity record was being written.
        }
      }
      await stopAndReap(recordedPids);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);
});
