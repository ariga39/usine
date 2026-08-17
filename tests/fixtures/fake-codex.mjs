#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = args[outputIndex + 1];
if (!outputPath) throw new Error("missing structured output path");

if (process.env.USINE_CODEX_ROLE === "implementer") {
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
  const sequenceFile = process.env.USINE_FAKE_REVIEW_SEQUENCE_FILE;
  if (sequenceFile) {
    let reviewCount = 0;
    try {
      reviewCount = Number(await readFile(sequenceFile, "utf8"));
    } catch {
      // Missing means this is the first review.
    }
    await writeFile(sequenceFile, String(reviewCount + 1));
    if (reviewCount === 0) {
      verdict = "changes_requested";
      findings = ["Add the reviewed fix."];
    }
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
