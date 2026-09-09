import { z } from "zod";

export const ROLE_RESULT_LIMITS = {
  summaryMaxLength: 4_096,
  findingMaxCount: 32,
  findingMaxLength: 2_048,
} as const;

const exactSha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

export const implementerOutputSchema = z
  .object({
    status: z.enum(["proposed", "blocked"]),
    summary: z.string().max(ROLE_RESULT_LIMITS.summaryMaxLength),
  })
  .strict();

export type ImplementerOutput = z.infer<typeof implementerOutputSchema>;

export const reviewerOutputSchema = z
  .object({
    sha: exactSha,
    verdict: z.enum(["approved", "changes_requested", "inconclusive"]),
    summary: z.string().max(ROLE_RESULT_LIMITS.summaryMaxLength),
    findings: z
      .array(z.string().max(ROLE_RESULT_LIMITS.findingMaxLength))
      .max(ROLE_RESULT_LIMITS.findingMaxCount),
  })
  .strict();

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export function recoverReviewerOutput(finalResponse: string): ReviewerOutput | undefined {
  let recovered: ReviewerOutput | undefined;
  for (let start = 0; start < finalResponse.length; start += 1) {
    if (finalResponse[start] !== "{") continue;
    const end = balancedJsonObjectEnd(finalResponse, start);
    if (end === undefined) {
      const nextObject = finalResponse.indexOf("{", start + 1);
      const malformedCandidate = finalResponse.slice(
        start,
        nextObject === -1 ? finalResponse.length : nextObject,
      );
      if (looksLikeReviewerOutput(malformedCandidate)) return undefined;
      continue;
    }
    const candidate = finalResponse.slice(start, end);
    if (!looksLikeReviewerOutput(candidate)) {
      start = end - 1;
      continue;
    }
    try {
      const parsed = reviewerOutputSchema.safeParse(JSON.parse(candidate));
      if (!parsed.success) return undefined;
      if (recovered !== undefined) return undefined;
      recovered = parsed.data;
    } catch {
      return undefined;
    }
    start = end - 1;
  }
  return recovered;
}

function looksLikeReviewerOutput(value: string): boolean {
  const fields = ["sha", "verdict", "summary", "findings"];
  const present = fields.filter((field) =>
    new RegExp(`(?:^|[,{]\\s*)["']?${field}["']?(?=\\s|:|,|})`).test(value),
  );
  return present.includes("verdict") || present.length >= 2;
}

function balancedJsonObjectEnd(value: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}
