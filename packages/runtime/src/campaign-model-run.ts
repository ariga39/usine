import type { CampaignAssessmentUsage } from "@usine/task-authority";
import { taskFailureClassFromProvider } from "@usine/task-authority";
import type { SessionObservation, SessionRole } from "@usine/coding-session";

/** Provider-neutral evidence for one Campaign-only model invocation. */
export interface CampaignModelRunDraft {
  readonly invocationId: string;
  readonly role: Extract<SessionRole, "assessor" | "replacement-planner">;
  readonly status: "completed" | "failed" | "cancelled";
  readonly failureClass: ReturnType<typeof taskFailureClassFromProvider> | null;
  readonly startedAtEpochMs: number;
  readonly completedAtEpochMs: number;
  readonly elapsedMs: number;
  readonly repositoryId: string | null;
  readonly repository: string | null;
  readonly profile: string | null;
  readonly configuredProvider: string | null;
  readonly configuredModel: string | null;
  readonly actualProvider: string | null;
  readonly actualModel: string | null;
  readonly adapter: string | null;
  readonly serviceTier: string | null;
  readonly reasoningEffort: string | null;
  readonly usage: CampaignAssessmentUsage | null;
}

/**
 * A completed SessionObservation is provider evidence. A failed observation is
 * evidence only after Coding Session left startup (or reported usage), so a
 * profile/configuration failure cannot become a fabricated AI generation.
 */
export function campaignModelRunFromObservation(
  role: CampaignModelRunDraft["role"],
  repository: { readonly id: string; readonly owner: string; readonly name: string },
  invocationId: string,
  startedAtEpochMs: number,
  observation: SessionObservation,
): readonly CampaignModelRunDraft[] {
  const invoked =
    observation.status === "completed" ||
    observation.phase !== "startup" ||
    observation.usage !== null;
  if (!invoked) return [];
  const completedAtEpochMs = Date.now();
  const profile = observation.effectiveProfile;
  const main: CampaignModelRunDraft = {
    invocationId,
    role,
    status: observation.status,
    failureClass: observation.failureClass
      ? taskFailureClassFromProvider(observation.failureClass)
      : null,
    startedAtEpochMs,
    completedAtEpochMs,
    elapsedMs: Math.max(0, completedAtEpochMs - startedAtEpochMs),
    repositoryId: repository.id,
    repository: `${repository.owner}/${repository.name}`,
    profile: profile?.profileName ?? observation.requestedProfile ?? null,
    configuredProvider: profile?.configuredProvider ?? profile?.modelProvider ?? null,
    configuredModel: profile?.configuredModel ?? profile?.model ?? null,
    actualProvider: profile?.actualProvider ?? profile?.actualModelProvider ?? null,
    actualModel: profile?.actualModel ?? null,
    adapter: profile?.adapter ?? null,
    serviceTier: profile?.serviceTier ?? null,
    reasoningEffort: profile?.reasoningEffort ?? null,
    usage: observation.usage
      ? {
          inputTokens: observation.usage.inputTokens ?? null,
          cachedInputTokens: observation.usage.cachedInputTokens ?? null,
          uncachedInputTokens: observation.usage.uncachedInputTokens ?? null,
          cacheWriteInputTokens: observation.usage.cacheWriteInputTokens ?? null,
          outputTokens: observation.usage.outputTokens ?? null,
          reasoningOutputTokens: observation.usage.reasoningOutputTokens ?? null,
        }
      : null,
  };
  if (!observation.normalizer) return [main];
  const normalizer = observation.normalizer;
  return [
    main,
    {
      invocationId: `${invocationId}:role-output-normalizer`,
      role,
      status: normalizer.status === "succeeded" ? "completed" : normalizer.status,
      failureClass:
        normalizer.status === "succeeded"
          ? null
          : taskFailureClassFromProvider(
              observation.failureClass ??
                (normalizer.status === "cancelled" ? "cancellation" : "unknown"),
            ),
      startedAtEpochMs,
      completedAtEpochMs,
      elapsedMs: Math.max(0, completedAtEpochMs - startedAtEpochMs),
      repositoryId: repository.id,
      repository: `${repository.owner}/${repository.name}`,
      profile: null,
      configuredProvider: normalizer.configuredProvider ?? normalizer.modelProvider,
      configuredModel: normalizer.configuredModel ?? normalizer.model,
      actualProvider: normalizer.actualProvider ?? normalizer.actualModelProvider,
      actualModel: normalizer.actualModel,
      adapter: normalizer.adapter,
      serviceTier: null,
      reasoningEffort: null,
      usage: normalizer.usage
        ? {
            inputTokens: normalizer.usage.inputTokens ?? null,
            cachedInputTokens: normalizer.usage.cachedInputTokens ?? null,
            uncachedInputTokens: normalizer.usage.uncachedInputTokens ?? null,
            cacheWriteInputTokens: normalizer.usage.cacheWriteInputTokens ?? null,
            outputTokens: normalizer.usage.outputTokens ?? null,
            reasoningOutputTokens: normalizer.usage.reasoningOutputTokens ?? null,
          }
        : null,
    },
  ];
}
