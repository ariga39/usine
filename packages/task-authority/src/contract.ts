import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

function isMachineSpecificAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:/.test(value);
}

function hasParentDirectorySegment(value: string): boolean {
  return /(?:^|[\\/])\.\.(?:$|[\\/])/.test(value);
}

const repositoryPath = z
  .string()
  .min(1)
  .refine((value) => !isMachineSpecificAbsolutePath(value) && !hasParentDirectorySegment(value), {
    message:
      "must be a repository-relative path; absolute and parent-directory paths are not allowed",
  });

const repositoryIdentity = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

export const taskContractSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
        "must be a safe durable identifier of at most 128 characters",
      ),
    repository: z.object({
      path: repositoryPath,
      owner: repositoryIdentity,
      name: repositoryIdentity,
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
      baseBranch: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0, {
          message: "must not be blank",
        }),
      branch: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0, {
          message: "must not be blank",
        }),
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
