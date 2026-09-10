#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultTargetRoot = resolve(checkoutRoot, "../usine-462-fictional-target");
const projectCheck = "node --test";

const BASE_FILES = {
  ".gitignore": ".tasks/\nevaluations/462/report.json\n",
  "package.json":
    '{\n  "name": "fictional-semantic-target",\n  "private": true,\n  "type": "module"\n}\n',
  "src/summary.js": `export function summarize(items) {
  return { title: "Inventory", count: items.length };
}
`,
  "src/host-api.js": `export function showDialog(message) {
  return { kind: "dialog", message };
}
`,
  "src/renderer-api.js": `export function renderLabel(value) {
  return String(value);
}
`,
  "src/main.js": `import { showDialog } from "./host-api.js";

export function notifyMainProcess(message) {
  return showDialog(message);
}
`,
  "types/host-api.d.ts": `export { showDialog } from "../src/host-api.js";
`,
  "test/comparison.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summary.js";

const baseOutput = { title: "Inventory", count: 2 };
const candidateOutput = summarize(["one", "two"]);
const removed = Object.keys(baseOutput).filter((key) => !(key in candidateOutput));
console.log(JSON.stringify({ comparison: { baseOutput, candidateOutput, removed } }));

test("keeps the public summary title", () => {
  assert.equal(candidateOutput.title, "Inventory");
});
`,
  "test/host-api-double.js": `export { showDialog } from "../src/host-api.js";
export const apiSource = "host-api";
`,
  "test/host-api.test.js": `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as realHostApi from "../src/host-api.js";
import * as hostDouble from "./host-api-double.js";

const declaration = await readFile(new URL("../types/host-api.d.ts", import.meta.url), "utf8");
const declarationSource = declaration.match(/from "(.*)"/)?.[1] ?? "missing";
console.log(JSON.stringify({
  realHostApiExports: Object.keys(realHostApi).sort(),
  declarationSource,
  doubleApiSource: hostDouble.apiSource,
  doubleExports: Object.keys(hostDouble).sort(),
}));

test("local host declarations and doubles expose a dialog", () => {
  assert.equal(typeof realHostApi.showDialog, "function");
  assert.equal(typeof hostDouble.showDialog, "function");
  assert.match(declaration, /showDialog/);
});
`,
  "test/control.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summary.js";

test("preserves the default summary title", () => {
  assert.equal(summarize(["one", "two"]).title, "Inventory");
});
`,
};

const CONTROL_FILES = {
  "src/summary.js": `export function summarize(items, title = "Inventory") {
  return { title, count: items.length };
}
`,
  "test/control.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summary.js";

test("adds an optional title without changing the existing fields", () => {
  assert.deepEqual(summarize(["one", "two"]), { title: "Inventory", count: 2 });
  assert.deepEqual(summarize(["one", "two"], "Stock"), { title: "Stock", count: 2 });
});
`,
};

const HOST_FILES = {
  "src/main.js": `import { showDialog } from "./renderer-api.js";

export function notifyMainProcess(message) {
  return showDialog(message);
}
`,
  "types/host-api.d.ts": `export { showDialog } from "../src/renderer-api.js";
`,
  "src/renderer-api.d.ts": `export declare function renderLabel(value: unknown): string;
export declare function showDialog(message: string): { kind: "dialog"; message: string };
`,
  "test/host-api-double.js": `export function showDialog(message) {
  return { kind: "dialog", message };
}
export const apiSource = "renderer-api";
`,
};

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fail(`${name} needs a value`));
}

function fail(message) {
  throw new Error(message);
}

async function git(targetRoot, ...args) {
  return (await execFile("git", args, { cwd: targetRoot })).stdout.trim();
}

async function commit(targetRoot, message, epoch) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Issue 462 Fixture Generator",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Issue 462 Fixture Generator",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: epoch,
    GIT_COMMITTER_DATE: epoch,
  };
  await execFile("git", ["add", "."], { cwd: targetRoot });
  await execFile("git", ["commit", "--no-gpg-sign", "-m", message], { cwd: targetRoot, env });
  return git(targetRoot, "rev-parse", "HEAD");
}

async function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function ensureEmptyOrAbsent(root) {
  try {
    const entries = await readdir(root);
    if (entries.length > 0) fail(`target root is not empty: ${root}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true });
  }
}

async function check(targetRoot, sha) {
  const result = await execFile(process.execPath, ["--test"], {
    cwd: targetRoot,
    env: process.env,
  });
  return {
    sha,
    status: "passed",
    command: projectCheck,
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function main() {
  const targetRoot = resolve(argument("--target-root", defaultTargetRoot));
  const corpusRoot = join(targetRoot, "evaluations/462");
  const registrationPath = join(targetRoot, ".tasks/462-registration.json");
  const baselineProfile = argument("--baseline-profile", "baseline-reviewer");
  const candidateProfile = argument("--candidate-profile", "candidate-reviewer");

  await ensureEmptyOrAbsent(targetRoot);
  await mkdir(corpusRoot, { recursive: true });
  await writeTree(targetRoot, BASE_FILES);
  await execFile("git", ["init", "--initial-branch=main"], { cwd: targetRoot });
  const baseSha = await commit(
    targetRoot,
    "fixture: establish fictional target",
    "2000-01-01T00:00:00Z",
  );

  const candidates = {};
  const candidateSpecs = [
    {
      id: "case-a",
      message: "fixture: update summary output",
      files: {},
      epoch: "2000-01-01T00:00:01Z",
    },
    {
      id: "case-b",
      message: "fixture: update application behavior",
      files: HOST_FILES,
      epoch: "2000-01-01T00:00:02Z",
    },
    {
      id: "case-c",
      message: "fixture: extend summary behavior",
      files: CONTROL_FILES,
      epoch: "2000-01-01T00:00:03Z",
    },
  ];

  for (const { id, message, files, epoch } of candidateSpecs) {
    await git(targetRoot, "switch", "--create", `candidate-${id}`, baseSha);
    if (id === "case-a") {
      await writeTree(targetRoot, {
        "src/summary.js": `export function summarize(items) {
  return { title: "Inventory" };
}
`,
      });
    } else {
      await writeTree(targetRoot, files);
    }
    candidates[id] = await commit(targetRoot, message, epoch);
    await git(targetRoot, "switch", "main");
  }

  const checks = {};
  for (const [id, sha] of Object.entries(candidates)) {
    await git(targetRoot, "switch", `candidate-${id}`);
    checks[id] = await check(targetRoot, sha);
  }
  await git(targetRoot, "switch", "main");

  const contractBase = {
    repositoryId: "usine-462-fictional-target",
    baseSha,
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 900_000 },
    authorization: { source: "https://github.com/ariga39/usine/issues/462", delivery: true },
    delivery: {
      branch: "agent/462-semantic-review",
      issue: 462,
      title: "Review fictional semantic cases",
      body: "Evaluation-only frozen fictional target.",
    },
    nonGoals: ["No production change, delivery, or merge is authorized."],
  };
  const contracts = {
    "case-a": {
      ...contractBase,
      id: "issue-462-case-a",
      instructions: "Review the frozen candidate against the public summary behavior.",
      acceptance: [
        "The public summary result preserves title and numeric count.",
        "The candidate passes the supplied project check.",
      ],
    },
    "case-b": {
      ...contractBase,
      id: "issue-462-case-b",
      instructions: "Review the frozen candidate's application behavior.",
      acceptance: [
        "Main-process dialog behavior remains available through the application's host boundary.",
        "The candidate passes the supplied project check.",
      ],
    },
    "case-c": {
      ...contractBase,
      id: "issue-462-case-c",
      instructions: "Review the frozen candidate for compatibility with the summary behavior.",
      acceptance: [
        "The existing title and numeric count fields remain compatible.",
        "The optional title behavior is covered by a real test.",
        "The candidate passes the supplied project check.",
      ],
    },
  };
  const labels = {
    "case-a": {
      verdict: "changes_requested",
      rationale:
        "The actual comparison output removes the required numeric count property; the green title-only test does not reconcile that contract break.",
      reference: "Issue #462 public contract, case-a fixture",
      protected: true,
    },
    "case-b": {
      verdict: "changes_requested",
      rationale:
        "Main-process code imports an absent renderer export; a fake declaration and matching double conceal the broken import. The real host module owns showDialog.",
      reference: "Issue #462 public contract, case-b fixture",
      protected: true,
    },
    "case-c": {
      verdict: "approved",
      rationale:
        "The optional title is additive and the existing title/count contract remains covered by a passing real test.",
      reference: "Issue #462 public contract, case-c fixture",
      protected: false,
    },
  };

  const relativeRegistration = relative(corpusRoot, registrationPath);
  const plan = {
    schemaVersion: 1,
    id: "issue-462-reviewer-semantics",
    repositoryId: "usine-462-fictional-target",
    baseSha,
    subjectRole: "reviewer",
    changedFactor: "reasoning",
    baselineProfile,
    candidateProfile,
    maxRuns: 6,
    usineBuild: await git(checkoutRoot, "rev-parse", "HEAD"),
    reportPath: "evaluations/462/report.json",
    registrationPath: relativeRegistration,
    cases: Object.keys(candidates).map((id) => ({
      id,
      repetition: 1,
      contractPath: `evaluations/462/contracts/${id}.json`,
      candidateSha: candidates[id],
      checkPath: `evaluations/462/checks/${id}.json`,
      labelPath: `evaluations/462/labels/${id}.json`,
    })),
  };

  for (const [id, contract] of Object.entries(contracts))
    await writeJson(join(corpusRoot, "contracts", `${id}.json`), contract);
  for (const [id, evidence] of Object.entries(checks))
    await writeJson(join(corpusRoot, "checks", `${id}.json`), evidence);
  for (const [id, label] of Object.entries(labels))
    await writeJson(join(corpusRoot, "labels", `${id}.json`), label);
  await writeJson(join(corpusRoot, "plan.json"), plan);
  await mkdir(dirname(registrationPath), { recursive: true });
  await writeJson(registrationPath, {
    id: "usine-462-fictional-target",
    path: targetRoot,
    owner: "ariga39",
    name: "usine",
    baseBranch: "main",
    implementerProfile: "unused-implementer",
    reviewerProfile: "unused-reviewer",
    forgeProfile: "unused-forge",
    githubReadProfile: null,
    projectCheck: { command: projectCheck, timeoutMs: 120_000 },
    gitAuthor: { name: "Issue 462 Fixture Generator", email: "fixture@example.invalid" },
  });

  await commit(targetRoot, "fixture: freeze external evaluation evidence", "2000-01-01T00:00:04Z");

  process.stdout.write(
    JSON.stringify(
      { corpusRoot, targetRoot, registrationPath, baseSha, candidates, plan },
      null,
      2,
    ) + "\n",
  );
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

await main();
