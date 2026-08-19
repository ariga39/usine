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

const repositoryIdentity = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  });

function isCanonicalGitHubIssueSource(
  source: unknown,
  repository: { owner: string; name: string },
  issue: number,
): boolean {
  if (typeof source !== "string") return false;

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }

  if (
    source !== url.href ||
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }

  const segments = url.pathname.split("/");
  const [leading, owner, name, kind, number] = segments;
  return (
    segments.length === 5 &&
    leading === "" &&
    owner !== undefined &&
    name !== undefined &&
    kind === "issues" &&
    number === String(issue) &&
    owner.toLowerCase() === repository.owner.toLowerCase() &&
    name.toLowerCase() === repository.name.toLowerCase()
  );
}

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
  .strict()
  .superRefine((contract, context) => {
    if (!contract.authorization || !contract.repository || !contract.delivery) return;
    if (
      !isCanonicalGitHubIssueSource(
        contract.authorization.source,
        contract.repository,
        contract.delivery.issue,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorization", "source"],
        message:
          "must be the canonical HTTPS GitHub Issue URL matching repository and delivery.issue",
      });
    }
  });

export type TaskContract = z.infer<typeof taskContractSchema>;

export function contractIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
