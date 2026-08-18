#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { contractIssues, taskContractSchema } from "@usine/task-authority/contract";
import { admitTask, runtimePolicyFromEnvironment } from "@usine/runtime";

async function main(): Promise<void> {
  const [command, contractPath] = process.argv.slice(2);
  if (command !== "run" || !contractPath) {
    process.stderr.write(
      `${JSON.stringify({ error: "usage", usage: "usine run <task-contract.json>" })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  let input: unknown;
  let rawContract: string;
  try {
    rawContract = await readFile(contractPath, "utf8");
    input = JSON.parse(rawContract);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: "invalid_task_contract", issues: [{ path: "", message: String(error) }] })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const parsed = taskContractSchema.safeParse(input);
  if (!parsed.success) {
    process.stderr.write(
      `${JSON.stringify({ error: "invalid_task_contract", issues: contractIssues(parsed.error) })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  try {
    const policy = runtimePolicyFromEnvironment(process.env, parsed.data.repository);
    const result = await admitTask(contractPath, rawContract, parsed.data, policy);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (policy.stopAfterAdmitted) process.exitCode = 75;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: "run_failed", message: String(error) })}\n`);
    process.exitCode = 1;
  }
}

await main();
