#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const corpus = dirname(fileURLToPath(import.meta.url));
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const targetArgument = argument("--target-root");
if (!targetArgument) throw new Error("--target-root must name a new empty directory");
const target = resolve(targetArgument);
const control = argument("--control");
if (control !== undefined && control !== "valid" && control !== "invented")
  throw new Error("--control must be valid or invented");
await mkdir(target, { recursive: true });
if ((await readdir(target)).length !== 0) throw new Error("target directory is not empty");
const run = async (command, args) =>
  (await execFile(command, args, { cwd: target, maxBuffer: 4 * 1024 * 1024 })).stdout;
await cp(join(corpus, "fixture"), target, { recursive: true });
await mkdir(join(target, "src"));
if (control) {
  await cp(join(corpus, "controls", control, "index.ts"), join(target, "src/index.ts"));
  await cp(join(corpus, "controls", control, "unit.test.mjs"), join(target, "tests/unit.test.mjs"));
} else {
  await writeFile(join(target, "src/index.ts"), "export {};\n");
}
await run("corepack", ["pnpm", "install"]);
await run("corepack", ["pnpm", "exec", "vp", "fmt"]);
await run("git", ["init", "--initial-branch=main"]);
await run("git", ["add", "."]);
await run("git", [
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "--no-gpg-sign",
  "-m",
  "fixture: establish bounded host-plugin case",
]);
const baseSha = (await run("git", ["rev-parse", "HEAD"])).trim();
const contract = {
  id: "host-plugin-qualification",
  repositoryId: "host-plugin-qualification",
  baseSha,
  instructions:
    "Implement the bounded host-plugin case in docs/HOST-EVIDENCE.md, inspecting its pinned public sources. Preserve the real pnpm/Vite+ toolchain and built host-boundary checks. Implement only the read-only resource snapshot, host lifecycle/settings, authentication and opt-in LAN behavior described there. Add meaningful tests as needed; do not weaken the frozen host test or replace required scripts. Return the first complete candidate; the evaluator stops after its exact-SHA check, without delivery. Read no external evaluation controls or prior candidate solutions.",
  acceptance: [
    "The built package follows the real poi loader, zero-argument lifecycle, metadata and React settings contract.",
    "Read-only resource data is served only with valid bearer authentication, loopback by default and LAN by explicit opt-in.",
    "Host configuration events apply enabled, port and token changes without plugin reload or leaked listeners.",
    "The frozen built-entry tests pass through genuine pnpm/Vite+ format/lint/type/build/test commands.",
    "Document the bounded no-proxy deployment policy and which full-host/UI interactions were not exercised.",
  ],
  nonGoals: [
    "No WebSocket/MCP, host changes, external delivery, historical target repair or trial restart.",
  ],
  budget: { maxImplementerActivations: null, maxReviewCycles: null, maxElapsedMs: 2700000 },
  authorization: { source: "https://github.com/ariga39/usine/issues/475", delivery: true },
  delivery: {
    issue: 475,
    branch: "qualification-only",
    title: "Host-grounded resource snapshot",
    body: "Local qualification; no forge operation is performed.",
  },
};
await mkdir(join(target, ".tasks"));
const contractPath = join(target, ".tasks/contract.json");
await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    targetRoot: target,
    control: control ?? null,
    baseSha,
    contractPath,
    projectCheck: "corepack pnpm install --frozen-lockfile && corepack pnpm run check",
  })}\n`,
);
