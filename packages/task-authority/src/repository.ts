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

const exactSha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase commit SHA");

export interface AcceptanceCheck {
  readonly id: string;
  readonly source: "host";
  readonly workingDirectory: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export const acceptanceCheckSchema = z
  .object({
    id: identifier,
    source: z.literal("host"),
    workingDirectory: nonBlank,
    command: nonBlank,
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export function decodeAcceptanceChecks(input: unknown): AcceptanceCheck[] {
  return z.array(acceptanceCheckSchema).parse(input);
}

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
    acceptanceChecks: z.array(acceptanceCheckSchema).default([]),
    gitAuthor: z.object({ name: nonBlank, email: nonBlank }),
  })
  .strict();

export type RepositoryRegistration = z.input<typeof repositoryRegistrationSchema>;

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
export type RepositorySnapshot = RepositoryRegistration & {
  /** Host-observed durable head; never accepted as registration input. */
  readonly headSha?: z.infer<typeof exactSha>;
};
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
    acceptanceChecks: (registration.acceptanceChecks ?? []).map((check) => ({ ...check })),
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
    acceptanceChecks: (registration.acceptanceChecks ?? []).map((check) => ({ ...check })),
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
