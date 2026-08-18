import { execa } from "execa";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession } from "./coding-session.js";
import { reviewerOutputSchema } from "./role-output.js";
import type { CheckResult, ReviewVerdict } from "./task-authority.js";

const CHECK_STREAM_LIMIT = 16_384;

function truncateCheckStream(output: string, stream: "stdout" | "stderr"): string {
  if (output.length <= CHECK_STREAM_LIMIT) return output;
  const marker = `\n[${stream} truncated to ${CHECK_STREAM_LIMIT} characters]\n`;
  const available = CHECK_STREAM_LIMIT - marker.length;
  const headLength = Math.ceil(available / 2);
  return `${output.slice(0, headLength)}${marker}${output.slice(-(available - headLength))}`;
}

function checkEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export interface QualityGateOptions {
  workspace: CandidateWorkspace;
  session: CodexCodingSession;
  reviewerModel: string;
  reviewerReasoningEffort: string;
  deadlineEpochMs: number;
}

export class QualityGate {
  constructor(private readonly options: QualityGateOptions) {}

  async check(contract: TaskContract, sha: string, cycle: number): Promise<CheckResult> {
    return this.options.workspace.withCheckout(
      `check-${contract.id}-${cycle}`,
      sha,
      async (path) => {
        let result;
        const remaining = this.options.deadlineEpochMs - Date.now() - 100;
        if (remaining <= 0)
          return {
            sha,
            status: "failed" as const,
            command: contract.projectCheck.command,
            exitCode: 124,
            stdout: "",
            stderr: "elapsed budget exhausted",
          };
        try {
          result = await execa("sh", ["-c", contract.projectCheck.command], {
            cwd: path,
            env: checkEnvironment(),
            extendEnv: false,
            timeout: Math.min(contract.projectCheck.timeoutMs, remaining),
            reject: false,
          });
        } catch (error) {
          return {
            sha,
            status: "failed" as const,
            command: contract.projectCheck.command,
            exitCode: 124,
            stdout: "",
            stderr: truncateCheckStream(
              error instanceof Error ? error.message : String(error),
              "stderr",
            ),
          };
        }
        return {
          sha,
          status: result.exitCode === 0 ? ("passed" as const) : ("failed" as const),
          command: contract.projectCheck.command,
          exitCode: result.exitCode ?? 1,
          stdout: truncateCheckStream(result.stdout, "stdout"),
          stderr: truncateCheckStream(result.stderr, "stderr"),
        };
      },
    );
  }

  async review(
    contract: TaskContract,
    sha: string,
    check: CheckResult,
    cycle: number,
  ): Promise<ReviewVerdict> {
    if (check.status !== "passed" || check.sha !== sha)
      throw new Error("review requires a passing exact-SHA check");
    return this.options.workspace.withCheckout(
      `review-${contract.id}-${cycle}`,
      sha,
      async (path) => {
        const prompt = [
          "Role: fresh independent reviewer.",
          "Review only the frozen Task Contract, exact candidate checkout, and project check evidence.",
          "Return an explicit JSON object matching the supplied schema. Approval requires the exact candidate SHA.",
          `Candidate SHA: ${sha}`,
          `Task Contract: ${JSON.stringify(contract)}`,
          `Project check evidence: ${JSON.stringify(check)}`,
          "Do not rely on implementer conversation or process exit status.",
        ].join("\n");
        const observation = await this.options.session.run({
          role: "reviewer",
          workspace: path,
          contract,
          prompt,
          model: this.options.reviewerModel,
          reasoningEffort: this.options.reviewerReasoningEffort,
          sandbox: "read-only",
          deadlineEpochMs: this.options.deadlineEpochMs,
          outputSchema: reviewerOutputSchema,
        });
        if (observation.status !== "completed" || !observation.output)
          return {
            sha,
            verdict: "inconclusive",
            summary: observation.failure ?? observation.summary,
            findings: [],
          };
        if (observation.output.sha !== sha)
          return {
            sha,
            verdict: "inconclusive",
            summary: "review output was stale",
            findings: [],
          };
        return observation.output;
      },
    );
  }
}
