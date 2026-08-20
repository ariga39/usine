import { z } from "zod";
import type { RepositorySnapshot } from "./repository.js";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

const repositoryId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must be a safe durable repository identifier of at most 128 characters",
  );

function isCanonicalGitHubIssueSource(source: unknown, issue: number): boolean {
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
    owner.length > 0 &&
    name.length > 0
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
    repositoryId,
    baseSha: sha,
    instructions: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string().min(1)),
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
    if (!contract.authorization || !contract.delivery) return;
    if (!isCanonicalGitHubIssueSource(contract.authorization.source, contract.delivery.issue)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorization", "source"],
        message: "must be the canonical HTTPS GitHub Issue URL matching delivery.issue",
      });
    }
  });

export type TaskContract = z.infer<typeof taskContractSchema>;

export type ResolvedTaskContract = Omit<TaskContract, "delivery"> & {
  repository: Pick<RepositorySnapshot, "path" | "owner" | "name">;
  projectCheck: RepositorySnapshot["projectCheck"];
  delivery: TaskContract["delivery"] & { baseBranch: string };
};

export function resolveTaskContract(
  contract: TaskContract,
  repository: Pick<
    RepositorySnapshot,
    "id" | "path" | "owner" | "name" | "baseBranch" | "projectCheck"
  >,
): ResolvedTaskContract {
  if (contract.repositoryId !== repository.id)
    throw new Error("task repository ID does not match the registered repository");
  const source = new URL(contract.authorization.source);
  const [leading, owner, name, kind, issue] = source.pathname.split("/");
  if (
    leading !== "" ||
    owner?.toLowerCase() !== repository.owner.toLowerCase() ||
    name?.toLowerCase() !== repository.name.toLowerCase() ||
    kind !== "issues" ||
    issue !== String(contract.delivery.issue)
  ) {
    throw new Error("task authorization does not match the registered repository");
  }
  return {
    ...contract,
    repository: { path: repository.path, owner: repository.owner, name: repository.name },
    projectCheck: { ...repository.projectCheck },
    delivery: { ...contract.delivery, baseBranch: repository.baseBranch },
  };
}

export function contractIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
