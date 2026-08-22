import { z } from "zod";

const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must be a safe durable identifier of at most 128 characters",
  );

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "must not be blank",
  });

export const forgeProfileSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/, "must use lowercase kebab-case");

export const repositoryRegistrationSchema = z
  .object({
    id: identifier,
    path: nonBlank,
    owner: nonBlank,
    name: nonBlank,
    baseBranch: nonBlank,
    implementerProfile: nonBlank,
    reviewerProfile: nonBlank,
    forgeProfile: forgeProfileSchema,
    githubReadProfile: forgeProfileSchema.nullable().optional(),
    projectCheck: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive(),
    }),
    gitAuthor: z.object({ name: nonBlank, email: nonBlank }),
  })
  .strict();

export type RepositoryRegistration = z.infer<typeof repositoryRegistrationSchema>;

export const repositoryResourceSchema = z
  .object({
    id: identifier,
    revision: z.number().int().nonnegative(),
    owner: nonBlank,
    name: nonBlank,
    baseBranch: nonBlank,
  })
  .strict();

export type RepositoryResource = z.infer<typeof repositoryResourceSchema>;

/** The immutable repository facts copied into an admitted Task. */
export type RepositorySnapshot = RepositoryRegistration;
export type TaskRepositorySnapshot = Omit<
  RepositorySnapshot,
  "implementerProfile" | "reviewerProfile" | "forgeProfile" | "githubReadProfile"
>;

export function taskSnapshotFromRegistration(
  registration: RepositoryRegistration,
): TaskRepositorySnapshot {
  return {
    id: registration.id,
    path: registration.path,
    owner: registration.owner,
    name: registration.name,
    baseBranch: registration.baseBranch,
    projectCheck: { ...registration.projectCheck },
    gitAuthor: { ...registration.gitAuthor },
  };
}

export function repositoryIdentity(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export function snapshotFromRegistration(registration: RepositoryRegistration): RepositorySnapshot {
  return {
    ...registration,
    githubReadProfile: registration.githubReadProfile ?? null,
    projectCheck: { ...registration.projectCheck },
    gitAuthor: { ...registration.gitAuthor },
  };
}

export function repositoryResourceFromSnapshot(
  snapshot: RepositorySnapshot,
  revision: number,
): RepositoryResource {
  return {
    id: snapshot.id,
    revision,
    owner: snapshot.owner,
    name: snapshot.name,
    baseBranch: snapshot.baseBranch,
  };
}
