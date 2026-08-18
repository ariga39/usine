import { execa } from "execa";
import type { TaskContract } from "@usine/task-authority";
import { CandidateWorkspace } from "@usine/candidate-workspace";
import { CodexCodingSession, reviewerOutputSchema, type RolePolicy } from "@usine/coding-session";
import { remainingUntil, type CheckResult, type ReviewVerdict } from "@usine/task-authority";

const CHECK_STREAM_LIMIT = 16_384;

function truncateCheckStream(output: string, stream: "stdout" | "stderr"): string {
  if (output.length <= CHECK_STREAM_LIMIT) return output;
  const marker = `\n[${stream} truncated to ${CHECK_STREAM_LIMIT} characters]\n`;
  const available = CHECK_STREAM_LIMIT - marker.length;
  const headLength = Math.ceil(available / 2);
  return `${output.slice(0, headLength)}${marker}${output.slice(-(available - headLength))}`;
}

export interface QualityGateOptions {
  workspace: CandidateWorkspace;
  session: CodexCodingSession;
  reviewer: RolePolicy;
  checkEnvironment: NodeJS.ProcessEnv;
  reviewerEnvironment: NodeJS.ProcessEnv;
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
        let timeout: number;
        try {
          timeout = remainingUntil(this.options.deadlineEpochMs, contract.projectCheck.timeoutMs);
        } catch {
          return {
            sha,
            status: "failed" as const,
            command: contract.projectCheck.command,
            exitCode: 124,
            stdout: "",
            stderr: "elapsed budget exhausted",
          };
        }
        try {
          result = await execa("sh", ["-c", contract.projectCheck.command], {
            cwd: path,
            env: this.options.checkEnvironment,
            extendEnv: false,
            timeout,
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
          role: this.options.reviewer.role,
          workspace: path,
          contract,
          prompt,
          model: this.options.reviewer.model,
          reasoningEffort: this.options.reviewer.reasoningEffort,
          sandbox: this.options.reviewer.sandbox,
          deadlineEpochMs: this.options.deadlineEpochMs,
          outputSchema: reviewerOutputSchema,
          environment: this.options.reviewerEnvironment,
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
