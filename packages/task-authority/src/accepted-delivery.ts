import type { DeliveryEffect, TaskResult } from "./task-state.js";

const EXACT_SHA = /^[0-9a-f]{40}$/;

export interface AcceptedTaskDelivery {
  readonly delivery: DeliveryEffect;
  readonly mergedHeadSha: string | null;
}

/**
 * Returns the delivery effect only when the Task has durable exact-SHA acceptance.
 * Campaign callers bind the returned effect to their own Goal and proposal facts.
 */
export function acceptedTaskDelivery(result: TaskResult | null): AcceptedTaskDelivery | null {
  if (
    !result ||
    !result.candidateSha ||
    !EXACT_SHA.test(result.candidateSha) ||
    !result.check ||
    result.check.status !== "passed" ||
    !EXACT_SHA.test(result.check.sha) ||
    result.check.sha !== result.candidateSha ||
    !result.review ||
    result.review.verdict !== "approved" ||
    !EXACT_SHA.test(result.review.sha) ||
    result.review.sha !== result.candidateSha ||
    !result.delivery ||
    !EXACT_SHA.test(result.delivery.sha) ||
    result.delivery.sha !== result.candidateSha
  )
    return null;

  if (!result.mergeAuthorized) {
    return result.state === "reviewed_pr" && result.delivery.merge == null
      ? { delivery: result.delivery, mergedHeadSha: null }
      : null;
  }

  const merge = result.delivery.merge;
  return result.state === "merged" &&
    merge !== null &&
    merge !== undefined &&
    merge.observedState === "merged" &&
    merge.prNumber === result.delivery.prNumber &&
    merge.approvedHeadSha === result.delivery.sha &&
    EXACT_SHA.test(merge.approvedHeadSha) &&
    EXACT_SHA.test(merge.mergeCommitSha)
    ? { delivery: result.delivery, mergedHeadSha: merge.mergeCommitSha }
    : null;
}
