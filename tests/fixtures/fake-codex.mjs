#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = args[outputIndex + 1];
if (!outputPath) throw new Error("missing structured output path");
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
