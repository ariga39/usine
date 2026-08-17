import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

export const taskContractSchema = z
  .object({
    id: z.string().min(1),
    repository: z.object({
      path: z.string().min(1),
      owner: z.string().min(1),
      name: z.string().min(1),
    }),
    baseSha: sha,
    instructions: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string().min(1)),
    projectCheck: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive(),
    }),
    budget: z.object({
      maxImplementerActivations: z.number().int().min(1).max(2),
      maxReviewCycles: z.number().int().min(1).max(2),
      maxElapsedMs: z.number().int().positive(),
    }),
    authorization: z.object({
      source: z.string().min(1),
      delivery: z.literal(true),
    }),
    delivery: z.object({
      baseBranch: z.string().min(1),
      branch: z.string().min(1),
      issue: z.number().int().positive(),
      title: z.string().min(1),
      body: z.string().min(1),
    }),
  })
  .strict();

export type TaskContract = z.infer<typeof taskContractSchema>;

export function contractIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
