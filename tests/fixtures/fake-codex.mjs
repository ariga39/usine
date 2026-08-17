#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = args[outputIndex + 1];
if (!outputPath) throw new Error("missing structured output path");
if (args.includes("--sandbox") && args.includes("--approve-for-me")) {
  throw new Error("--sandbox cannot be combined with --approve-for-me");
}
for (const key of [
  "USINE_DATABASE_URL",
  "USINE_STATE_DIR",
  "USINE_TEST_SECRET",
  "USINE_GITHUB_TEST_TOKEN",
  "USINE_GITHUB_PRIVATE_KEY_PATH",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]) {
  if (process.env[key]) throw new Error(`secret leaked to ${process.env.USINE_CODEX_ROLE}: ${key}`);
}
const prompt = args.at(-1) ?? "";
if (process.env.USINE_CODEX_ROLE === "implementer") {
  if (!prompt.includes("Frozen Task Contract JSON:")) {
    throw new Error("implementer prompt is missing the frozen Task Contract JSON");
  }
  const contractLine = prompt
    .split("\n")
    .find((line) => line.startsWith("Frozen Task Contract JSON: "));
  const contract = JSON.parse(contractLine.slice("Frozen Task Contract JSON: ".length));
  if (
    !contract.authorization?.source ||
    !prompt.includes(`Authorization source: ${contract.authorization.source}`)
  ) {
    throw new Error("implementer prompt is missing the authorization source");
  }
  const currentSha = (await execa("git", ["rev-parse", "HEAD"])).stdout;
  if (
    !prompt.includes(`Base SHA: ${contract.baseSha}`) ||
    !prompt.includes(`Current SHA: ${currentSha}`)
  ) {
    throw new Error("implementer prompt is missing exact Git facts");
  }
  if (
    !prompt.includes("credential-separated projection of active private Issue/PR/thread authority")
  ) {
    throw new Error("implementer prompt is missing coordinator authority statement");
  }
  if (
    !prompt.includes("do not access GitHub") ||
    !prompt.includes("do not wait for user input") ||
    !prompt.includes("missing GitHub credentials are not a blocker")
  ) {
    throw new Error("implementer prompt is missing the no-GitHub instruction");
  }
  if (!prompt.includes("Make the first observable in-scope action promptly")) {
    throw new Error("implementer prompt is missing prompt-action guidance");
  }
  if (
    contract.instructions.includes("address review findings") &&
    outputPath.includes("implementer-2") &&
    !prompt.includes("Add the reviewed fix.")
  ) {
    throw new Error("implementer prompt is missing unresolved findings");
  }
}
const modelIndex = args.findIndex((arg) => arg === "--model" || arg === "-m");
const model = args[modelIndex + 1];
const expectedModel =
  process.env.USINE_CODEX_ROLE === "implementer" ? "gpt-5.6-luna" : "gpt-5.6-sol";
if (model !== expectedModel) {
  throw new Error(
    `${process.env.USINE_CODEX_ROLE} expected model ${expectedModel}, received ${model ?? "none"}`,
  );
}
const profileIndex = args.findIndex((arg) => arg === "--profile" || arg === "-p");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
if (process.env.USINE_CODEX_ROLE === "implementer" && profile !== "usine-implementer") {
  throw new Error(`implementer expected profile usine-implementer, received ${profile ?? "none"}`);
}
if (process.env.USINE_CODEX_ROLE === "reviewer" && profile !== undefined) {
  throw new Error(`reviewer must remain fresh without implementer profile, received ${profile}`);
}

if (process.env.USINE_CODEX_ROLE === "implementer") {
  if (prompt.includes("Hang forever")) {
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  if (prompt.includes("Stop once") && outputPath.includes("implementer-1")) {
    await writeFile(
      outputPath,
      JSON.stringify({ status: "blocked", summary: "Stopped early once" }),
    );
    process.exit(0);
  }
  let content = "implemented\n";
  try {
    await readFile("delivered.txt", "utf8");
    content += "review-fixed\n";
  } catch {
    // The first activation creates the file.
  }
  await writeFile("delivered.txt", content);
  await execa("git", ["add", "delivered.txt"]);
  await execa("git", ["commit", "-m", "Implement authorized task"]);
  await writeFile(
    outputPath,
    JSON.stringify({ status: "proposed", summary: "Implemented fixture" }),
  );
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", thread_id: "fixture-session" })}\n`,
  );
} else if (process.env.USINE_CODEX_ROLE === "reviewer") {
  const sha = (await execa("git", ["rev-parse", "HEAD"])).stdout;
  let verdict = "approved";
  let findings = [];
  if (prompt.includes("address review findings") && outputPath.includes("reviewer-1")) {
    verdict = "changes_requested";
    findings = ["Add the reviewed fix."];
  }
  await writeFile(
    outputPath,
    JSON.stringify({ sha, verdict, summary: "Fixture review", findings }),
  );
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", thread_id: "fixture-review" })}\n`,
  );
} else {
  throw new Error("unknown USINE_CODEX_ROLE");
}
