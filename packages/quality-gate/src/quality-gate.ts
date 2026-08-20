import { execa } from "execa";
import type { TaskContract } from "@usine/task-authority";
import { reviewerOutputSchema, type RolePolicy } from "@usine/coding-session";
import type { ReviewerOutput, SessionObservation, SessionRequest } from "@usine/coding-session";
import {
  remainingUntil,
  type CheckResult,
  type ReviewVerdict,
  type TaskHistoryTokenUsage,
} from "@usine/task-authority";

const CHECK_STREAM_LIMIT = 16_384;

function truncateCheckStream(output: string, stream: "stdout" | "stderr"): string {
  if (output.length <= CHECK_STREAM_LIMIT) return output;
  const marker = `\n[${stream} truncated to ${CHECK_STREAM_LIMIT} characters]\n`;
  const available = CHECK_STREAM_LIMIT - marker.length;
  const headLength = Math.ceil(available / 2);
  return `${output.slice(0, headLength)}${marker}${output.slice(-(available - headLength))}`;
}

export interface QualityGateOptions {
  workspace: QualityGateWorkspace;
  session: QualityGateSession;
  reviewer: RolePolicy;
  environment: NodeJS.ProcessEnv;
  deadlineEpochMs: number;
  signal?: AbortSignal;
}

export interface ReviewAttemptObservation {
  review: ReviewVerdict;
  usage: TaskHistoryTokenUsage | null;
}

interface QualityGateWorkspace {
  withCheckout<T>(purpose: string, sha: string, callback: (path: string) => Promise<T>): Promise<T>;
}

interface QualityGateSession {
  run(request: SessionRequest<ReviewerOutput>): Promise<
    Pick<SessionObservation<ReviewerOutput>, "status" | "output"> &
      Pick<SessionObservation<ReviewerOutput>, "summary" | "failure"> & {
        usage?: TaskHistoryTokenUsage | null;
      }
  >;
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
            env: this.options.environment,
            extendEnv: false,
            timeout,
            cancelSignal: this.options.signal,
            killDescendants: true,
            reject: false,
          });
          if (this.options.signal?.aborted) throw new Error("project check cancelled");
        } catch (error) {
          if (this.options.signal?.aborted) throw error;
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
    return (await this.reviewWithObservation(contract, sha, check, cycle)).review;
  }

  async reviewWithObservation(
    contract: TaskContract,
    sha: string,
    check: CheckResult,
    cycle: number,
  ): Promise<ReviewAttemptObservation> {
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
          environment: this.options.environment,
          signal: this.options.signal,
        });
        if (observation.status !== "completed" || !observation.output)
          return {
            review: {
              sha,
              verdict: "inconclusive",
              summary: observation.failure ?? observation.summary,
              findings: [],
            },
            usage: observation.usage ?? null,
          };
        if (observation.output.sha !== sha)
          return {
            review: {
              sha,
              verdict: "inconclusive",
              summary: "review output was stale",
              findings: [],
            },
            usage: observation.usage ?? null,
          };
        return { review: observation.output, usage: observation.usage ?? null };
      },
    );
  }
}
