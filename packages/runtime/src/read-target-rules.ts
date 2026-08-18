import { execa } from "execa";
import { remainingUntil } from "./remaining-until.js";

export async function readTargetRules(
  repository: string,
  baseSha: string,
  deadlineEpochMs: number,
): Promise<Array<{ path: string; contents: string }>> {
  const path = "AGENTS.md";
  const result = await execa("git", ["-C", repository, "show", `${baseSha}:${path}`], {
    timeout: remainingUntil(deadlineEpochMs),
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return [{ path, contents: String(result.stdout) }];
}
