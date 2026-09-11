import { createHash } from "node:crypto";
import { serializeRoleContext } from "@usine/coding-session";
import type { CampaignAssessmentFact } from "@usine/task-authority";

/** A compact reference to one immutable fact in the caller-owned source bundle. */
export interface CampaignAssessmentReference {
  readonly criterionIndex: number;
  readonly evidenceId: string;
}

export function campaignAssessmentFactKey(item: CampaignAssessmentFact): string {
  return serializeRoleContext([
    item.repositoryId,
    item.proposalId,
    item.taskId,
    item.fact,
    item.status,
    item.sha,
    item.candidateObservedAtEpochMs ?? null,
    item.criterionId ?? null,
    item.criterion ?? null,
    item.mandatory ?? null,
    item.checkId ?? null,
    item.artifact ?? null,
    item.checkExitCode ?? null,
    item.checkReason ?? null,
    item.checkOutputDigest ?? null,
    item.checkObservation ?? null,
    item.reviewSummary ?? null,
    item.reviewFindings ?? null,
    item.deliveryPrNumber ?? null,
    item.deliveryAttestationId ?? null,
    item.deliveryMerged ?? null,
  ]);
}

/** Identifies the complete fact version, not only a candidate SHA. */
export function campaignAssessmentFactId(item: CampaignAssessmentFact): string {
  return `fact-${createHash("sha256")
    .update(campaignAssessmentFactKey(item), "utf8")
    .digest("hex")}`;
}
