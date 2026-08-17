#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = args[outputIndex + 1];
if (!outputPath) throw new Error("missing structured output path");

if (process.env.USINE_CODEX_ROLE === "implementer") {
  await writeFile("delivered.txt", "implemented\n");
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
  await writeFile(
    outputPath,
    JSON.stringify({ sha, verdict: "approved", summary: "Fixture approved", findings: [] }),
  );
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", thread_id: "fixture-review" })}\n`,
  );
} else {
  throw new Error("unknown USINE_CODEX_ROLE");
}
