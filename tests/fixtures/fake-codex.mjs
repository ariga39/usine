#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected.toSorted())) {
    throw new Error(`${label} is incomplete: ${actual.join(",")}`);
  }
}

const args = process.argv.slice(2);
const reviewerExtractor =
  process.env.USINE_CODEX_ROLE === "reviewer" &&
  args[0] === "exec" &&
  process.env.USINE_CODEX_EXTRACTOR === "1";
if (reviewerExtractor) {
  throw new Error("reviewer verdict extraction must not invoke the Codex subprocess");
}
if (process.env.USINE_CODEX_ROLE === "reviewer" && args[0] === "exec" && !reviewerExtractor) {
  throw new Error("reviewer must not use direct codex exec");
}
const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const outputPath = args[outputIndex + 1];
if (!outputPath) throw new Error("missing structured output path");
const lifecycle = ["thread.started", "turn.started", "turn.completed"];
await appendFile(
  join(dirname(outputPath), "codex-invocations.jsonl"),
  `${JSON.stringify({ args, lifecycle, role: process.env.USINE_CODEX_ROLE })}\n`,
);
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
  "USINE_EXTRACTOR_API_KEY",
  "OPENAI_API_KEY",
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
  requireExactKeys(
    contract,
    [
      "acceptance",
      "authorization",
      "baseSha",
      "budget",
      "delivery",
      "id",
      "instructions",
      "nonGoals",
      "projectCheck",
      "repository",
    ],
    "frozen Task Contract",
  );
  requireExactKeys(contract.repository, ["name", "owner", "path"], "repository authority");
  requireExactKeys(contract.projectCheck, ["command", "timeoutMs"], "project check authority");
  requireExactKeys(
    contract.budget,
    ["maxElapsedMs", "maxImplementerActivations", "maxReviewCycles"],
    "budget authority",
  );
  requireExactKeys(contract.authorization, ["delivery", "source"], "authorization");
  requireExactKeys(
    contract.delivery,
    ["baseBranch", "body", "branch", "issue", "title"],
    "delivery authority",
  );
  if (!Array.isArray(contract.acceptance) || !Array.isArray(contract.nonGoals)) {
    throw new Error("frozen Task Contract is missing acceptance or nonGoals arrays");
  }
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
  if (!prompt.includes("Canonical corpus already loaded; do not reread before first action.")) {
    throw new Error("implementer prompt is missing canonical no-reread guidance");
  }
  for (const document of [
    "AGENTS.md",
    "docs/DESIGN.md",
    "docs/DEVELOPMENT.md",
    "docs/DECISIONS.md",
  ]) {
    const marker = `Canonical document ${document}:\n`;
    const endMarker = `\nEnd canonical document ${document}.`;
    const start = prompt.indexOf(marker);
    const end = prompt.indexOf(endMarker, start + marker.length);
    if (start < 0 || end < 0) {
      throw new Error(`implementer prompt is missing canonical document ${document}`);
    }
    const contents = prompt.slice(start + marker.length, end);
    const expected = await readFile(new URL(`../../${document}`, import.meta.url), "utf8");
    if (contents !== expected) {
      throw new Error(`implementer prompt has incomplete canonical document ${document}`);
    }
  }
  if (
    contract.instructions.includes("respect target rules") &&
    !prompt.includes(
      "Target repository rule AGENTS.md (exact base SHA):\nFixture target rule: preserve review evidence.",
    )
  ) {
    throw new Error("implementer prompt is missing exact-base target rules");
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
  process.env.USINE_CODEX_ROLE === "implementer" || reviewerExtractor
    ? "gpt-5.6-luna"
    : "gpt-5.6-sol";
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
if (process.env.USINE_CODEX_ROLE === "reviewer") {
  const configValues = args.flatMap((arg, index) => (arg === "--config" ? [args[index + 1]] : []));
  const expectedReasoningEffort = process.env.USINE_REVIEWER_REASONING_EFFORT ?? "low";
  if (!configValues.includes(`model_reasoning_effort=${expectedReasoningEffort}`)) {
    throw new Error(
      `reviewer must set model_reasoning_effort=${expectedReasoningEffort} explicitly`,
    );
  }
  if (!configValues.includes("service_tier=default")) {
    throw new Error("reviewer must set service_tier=default explicitly");
  }
  const sandboxIndex = args.findIndex((arg) => arg === "--sandbox");
  if (sandboxIndex < 0 || args[sandboxIndex + 1] !== "read-only") {
    throw new Error("reviewer must use a read-only sandbox");
  }
  if (
    !prompt.includes("The frozen Task Contract is the complete private Issue authority projection")
  ) {
    throw new Error("reviewer prompt is missing the frozen Task Contract authority guidance");
  }
  if (
    !prompt.includes("do not access GitHub") ||
    !prompt.includes("do not wait for user input") ||
    !prompt.includes("missing GitHub credentials are not a blocker")
  ) {
    throw new Error("reviewer prompt is missing the no-GitHub instruction");
  }
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
  if (process.env.USINE_HERDR_MODE !== "propose-without-commit") {
    await execa("git", ["add", "delivered.txt"]);
    await execa("git", ["commit", "-m", "Implement authorized task"]);
  }
  await writeFile(
    outputPath,
    JSON.stringify({ status: "proposed", summary: "Implemented fixture" }),
  );
  process.stdout.write(
    `${lifecycle
      .map((type) =>
        JSON.stringify({
          type,
          ...(type === "thread.started" ? { thread_id: "fixture-session" } : {}),
        }),
      )
      .join("\n")}\n`,
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
