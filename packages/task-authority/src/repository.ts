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

export const repositoryRegistrationSchema = z
  .object({
    id: identifier,
    path: nonBlank,
    owner: nonBlank,
    name: nonBlank,
    baseBranch: nonBlank,
    projectCheck: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive(),
    }),
    gitAuthor: z.object({ name: nonBlank, email: nonBlank }),
  })
  .strict();

export type RepositoryRegistration = z.infer<typeof repositoryRegistrationSchema>;

/** The immutable repository facts copied into an admitted Task. */
export type RepositorySnapshot = RepositoryRegistration;

export function repositoryIdentity(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export function snapshotFromRegistration(registration: RepositoryRegistration): RepositorySnapshot {
  return {
    ...registration,
    projectCheck: { ...registration.projectCheck },
    gitAuthor: { ...registration.gitAuthor },
  };
}
