import { execa } from "execa";
import type { ResolvedTaskContract } from "@usine/task-authority";
import {
  reviewerOutputSchema,
  type CodingSessionPhase,
  type EffectiveSessionProfile,
  type RolePolicy,
  type SessionArchiveCaptureStatus,
  type ProviderNeutralUsage,
  type RoleOutputNormalizerObservation,
} from "@usine/coding-session";
import type { ReviewerOutput, SessionObservation, SessionRequest } from "@usine/coding-session";
import {
  originalTaskContract,
  remainingUntil,
  type CheckResult,
  type ReviewVerdict,
  taskFailureClassFromProvider,
  type TaskFailureClass,
} from "@usine/task-authority";

type SessionUsage = ProviderNeutralUsage;

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
  usage: SessionUsage | null;
  normalizer?: RoleOutputNormalizerObservation;
  requestedProfile?: string;
  effectiveProfile?: EffectiveSessionProfile;
  interruption?: { phase: CodingSessionPhase; failureClass: TaskFailureClass };
  archive?: {
    archiveId: string;
    status: SessionArchiveCaptureStatus;
    completeness?: "complete" | "partial";
  };
}

interface QualityGateWorkspace {
  withCheckout<T>(purpose: string, sha: string, callback: (path: string) => Promise<T>): Promise<T>;
}

interface QualityGateSession {
  run(request: SessionRequest<ReviewerOutput>): Promise<
    Pick<SessionObservation<ReviewerOutput>, "status" | "output"> &
      Pick<SessionObservation<ReviewerOutput>, "summary" | "failure"> & {
        phase?: SessionObservation<ReviewerOutput>["phase"];
        failureClass?: SessionObservation<ReviewerOutput>["failureClass"];
        usage?: SessionUsage | null;
        archiveId?: string;
        archiveStatus?: SessionArchiveCaptureStatus;
        archiveCompleteness?: "complete" | "partial";
        requestedProfile?: string;
        effectiveProfile?: EffectiveSessionProfile;
        normalizer?: RoleOutputNormalizerObservation;
      }
  >;
}

export class QualityGate {
  constructor(private readonly options: QualityGateOptions) {}

  async check(contract: ResolvedTaskContract, sha: string, cycle: number): Promise<CheckResult> {
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
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    cycle: number,
  ): Promise<ReviewVerdict> {
    return (await this.reviewWithObservation(contract, sha, check, cycle)).review;
  }

  async reviewWithObservation(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    cycle: number,
    onObservation?: SessionRequest<ReviewerOutput>["onObservation"],
  ): Promise<ReviewAttemptObservation> {
    if (check.status !== "passed" || check.sha !== sha)
      throw new Error("review requires a passing exact-SHA check");
    return this.options.workspace.withCheckout(
      `review-${contract.id}-${cycle}`,
      sha,
      async (path) => {
        const taskContract = originalTaskContract(contract);
        const prompt = [
          "Role: fresh independent reviewer.",
          "Review only the frozen Task Contract, exact candidate checkout, and project check evidence.",
          "Return an explicit JSON object matching the supplied schema. Approval requires the exact candidate SHA.",
          `Candidate SHA: ${sha}`,
          `Task Contract: ${JSON.stringify(taskContract)}`,
          `Project check evidence: ${JSON.stringify(check)}`,
          "Do not rely on implementer conversation or process exit status.",
        ].join("\n");
        const observation = await this.options.session.run({
          role: this.options.reviewer.role,
          attempt: `${cycle}-${sha}`,
          workspace: path,
          contract: taskContract,
          prompt,
          profile: this.options.reviewer.profile,
          sandbox: this.options.reviewer.sandbox,
          deadlineEpochMs: this.options.deadlineEpochMs,
          outputSchema: reviewerOutputSchema,
          environment: this.options.environment,
          signal: this.options.signal,
          onObservation,
        });
        if (observation.status !== "completed" || !observation.output)
          return {
            review: {
              sha,
              verdict: "inconclusive",
              summary: observation.failure ?? observation.summary,
              findings: [],
              ...(observation.failureClass
                ? { failureClass: taskFailureClassFromProvider(observation.failureClass) }
                : {}),
            },
            usage: observation.usage ?? null,
            requestedProfile: observation.requestedProfile ?? this.options.reviewer.profile,
            effectiveProfile: observation.effectiveProfile,
            normalizer: observation.normalizer,
            ...(observation.phase && observation.failureClass
              ? {
                  interruption: {
                    phase: observation.phase,
                    failureClass: taskFailureClassFromProvider(observation.failureClass),
                  },
                }
              : {}),
            ...(observation.archiveId && observation.archiveStatus
              ? {
                  archive: {
                    archiveId: observation.archiveId,
                    status: observation.archiveStatus,
                    ...(observation.archiveCompleteness
                      ? { completeness: observation.archiveCompleteness }
                      : {}),
                  },
                }
              : {}),
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
            requestedProfile: observation.requestedProfile ?? this.options.reviewer.profile,
            effectiveProfile: observation.effectiveProfile,
            normalizer: observation.normalizer,
            ...(observation.archiveId && observation.archiveStatus
              ? {
                  archive: {
                    archiveId: observation.archiveId,
                    status: observation.archiveStatus,
                    ...(observation.archiveCompleteness
                      ? { completeness: observation.archiveCompleteness }
                      : {}),
                  },
                }
              : {}),
          };
        return {
          review: observation.output,
          usage: observation.usage ?? null,
          requestedProfile: observation.requestedProfile ?? this.options.reviewer.profile,
          effectiveProfile: observation.effectiveProfile,
          normalizer: observation.normalizer,
          ...(observation.archiveId && observation.archiveStatus
            ? {
                archive: {
                  archiveId: observation.archiveId,
                  status: observation.archiveStatus,
                  ...(observation.archiveCompleteness
                    ? { completeness: observation.archiveCompleteness }
                    : {}),
                },
              }
            : {}),
        };
      },
    );
  }
}
