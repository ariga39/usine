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
