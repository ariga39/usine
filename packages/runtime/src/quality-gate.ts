import { execa } from "execa";
import type { TaskContract } from "./contract.js";
import { CandidateWorkspace } from "./candidate-workspace.js";
import { CodexCodingSession, type SessionObservation } from "./coding-session.js";
import type { CheckResult, ReviewVerdict } from "./task-authority.js";

export interface QualityEvaluation {
  check: CheckResult;
  review: ReviewVerdict;
}

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sha", "verdict", "summary", "findings"],
  properties: {
    sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
    verdict: { type: "string", enum: ["approved", "changes_requested", "inconclusive"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
};

function checkEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "true" };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function parseReview(output: unknown, sha: string): ReviewVerdict {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { sha, verdict: "inconclusive", summary: "review output was not valid JSON", findings: [] };
    }
  }
  if (!value || typeof value !== "object") return { sha, verdict: "inconclusive", summary: "review output was missing", findings: [] };
  const candidate = value as { sha?: unknown; verdict?: unknown; summary?: unknown; findings?: unknown };
  if (candidate.sha !== sha || !["approved", "changes_requested", "inconclusive"].includes(String(candidate.verdict)) || typeof candidate.summary !== "string" || !Array.isArray(candidate.findings) || candidate.findings.some((finding) => typeof finding !== "string")) {
    return { sha, verdict: "inconclusive", summary: "review output was malformed or stale", findings: [] };
  }
  return { sha, verdict: candidate.verdict as ReviewVerdict["verdict"], summary: candidate.summary, findings: candidate.findings as string[] };
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

  async evaluate(contract: TaskContract, sha: string, cycle: number): Promise<QualityEvaluation> {
    const check = await this.options.workspace.withCheckout(`check-${contract.id}-${cycle}`, sha, async (path) => {
      let result;
      try {
        result = await execa("sh", ["-c", contract.projectCheck.command], {
          cwd: path,
          env: checkEnvironment(),
          extendEnv: false,
          timeout: Math.min(contract.projectCheck.timeoutMs, this.options.deadlineEpochMs - Date.now()),
          reject: false,
        });
      } catch (error) {
        return { sha, status: "failed" as const, command: contract.projectCheck.command, exitCode: 124, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      return { sha, status: result.exitCode === 0 ? "passed" as const : "failed" as const, command: contract.projectCheck.command, exitCode: result.exitCode ?? 1, stdout: String(result.stdout), stderr: String(result.stderr) };
    });
    if (check.status !== "passed") return { check, review: { sha, verdict: "inconclusive", summary: "project check failed", findings: [check.stderr || "project check failed"] } };

    const review = await this.options.workspace.withCheckout(`review-${contract.id}-${cycle}`, sha, async (path) => {
      const prompt = [
        "Role: fresh independent reviewer.",
        "Review only the frozen Task Contract, exact candidate checkout, and project check evidence.",
        "Return an explicit JSON object matching the supplied schema. Approval requires the exact candidate SHA.",
        `Candidate SHA: ${sha}`,
        `Task Contract: ${JSON.stringify(contract)}`,
        `Project check evidence: ${JSON.stringify(check)}`,
        "Do not rely on implementer conversation or process exit status.",
      ].join("\n");
      const observation: SessionObservation = await this.options.session.run({
        role: "reviewer",
        workspace: path,
        contract,
        prompt,
        model: this.options.reviewerModel,
        reasoningEffort: this.options.reviewerReasoningEffort,
        sandbox: "read-only",
        deadlineEpochMs: this.options.deadlineEpochMs,
        outputSchema: reviewSchema,
      });
      return parseReview(observation.output, sha);
    });
    return { check, review };
  }
}
