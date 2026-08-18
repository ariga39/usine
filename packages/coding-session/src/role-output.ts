import { z } from "zod";

const exactSha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

export const implementerOutputSchema = z
  .object({
    status: z.enum(["proposed", "blocked"]),
    summary: z.string(),
  })
  .strict();

export type ImplementerOutput = z.infer<typeof implementerOutputSchema>;

export const reviewerOutputSchema = z
  .object({
    sha: exactSha,
    verdict: z.enum(["approved", "changes_requested", "inconclusive"]),
    summary: z.string(),
    findings: z.array(z.string()),
  })
  .strict();

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
