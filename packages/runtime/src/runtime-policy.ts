import { homedir } from "node:os";
import { join } from "node:path";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import {
  codingSessionAdapterSelectionEnvironment,
  createOpenAICompatibleRoleOutputTransform,
  explicitWorkerEnvironment,
  type RolePolicy,
  type RoleOutputTransform,
  type SessionArchiveOptions,
} from "@usine/coding-session";
import {
  checkForgeReadiness,
  githubReadToolNames,
  type ForgeReadinessResult,
  type ForgePolicy,
  type GithubApiPolicy,
  type GithubReadToolName,
} from "@usine/forge-delivery";
import { forgeProfileSchema } from "@usine/task-authority";

const defaultRolePolicies = {
  implementer: {
    role: "implementer" as const,
    sandbox: "workspace-write" as const,
  },
  reviewer: {
    role: "reviewer" as const,
    sandbox: "read-only" as const,
  },
};

export interface RuntimePolicy {
  stateDirectory: string;
  /** Host-private SDK executable override; never projected to provider children. */
  codexPathOverride?: string;
  roles: {
    implementer: RolePolicy;
    reviewer: RolePolicy;
  };
  forge: ForgePolicy;
  githubRead?: GithubReadPolicy;
  roleOutputTransform?: RoleOutputTransform;
  workerEnvironment: NodeJS.ProcessEnv;
  adapterSelectionEnvironment: NodeJS.ProcessEnv;
  credentialFreeGitEnvironment: NodeJS.ProcessEnv;
  sessionArchive: SessionArchiveOptions;
}

export interface GithubReadPolicy {
  policy: GithubApiPolicy;
  implementerTools: readonly GithubReadToolName[];
  reviewerTools: readonly GithubReadToolName[];
}

export type ForgeProfileErrorCode = "malformed" | "unauthorized" | "repository_mismatch";
export type ForgeProfileField =
  | "app_slug"
  | "app_id"
  | "installation_id"
  | "private_key"
  | "repository";

export class ForgeProfileResolutionError extends Error {
  readonly name = "ForgeProfileResolutionError";

  constructor(
    readonly code: ForgeProfileErrorCode,
    readonly profile: string,
    readonly repository: string,
    readonly field?: ForgeProfileField,
  ) {
    super(
      code === "repository_mismatch"
        ? `forge profile '${profile}' is not authorized for repository '${repository}'`
        : `forge profile '${profile}' is ${code}`,
    );
  }
}

export function stateDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory = homedir(),
): string {
  const userStateDirectory =
    environment.XDG_STATE_HOME?.trim() || join(homeDirectory, ".local", "state");
  return environment.USINE_STATE_DIR?.trim() || join(userStateDirectory, "usine");
}

export function runtimePolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  repository: {
    owner: string;
    name: string;
    implementerProfile: string;
    reviewerProfile: string;
    forgeProfile: string;
    githubReadProfile?: string | null;
  },
  homeDirectory = homedir(),
): RuntimePolicy {
  const stateDirectory = stateDirectoryFromEnvironment(environment, homeDirectory);
  const roles = {
    implementer: {
      ...defaultRolePolicies.implementer,
      profile: repository.implementerProfile,
    },
    reviewer: {
      ...defaultRolePolicies.reviewer,
      profile: repository.reviewerProfile,
    },
  };

  const forge = forgePolicyFromEnvironment(environment, repository);
  const githubRead = githubReadPolicyFromEnvironment(environment, repository);
  const workerEnvironment = explicitWorkerEnvironment(environment);
  const roleOutputTransform = roleOutputTransformFromEnvironment(environment);
  const sessionArchive = sessionArchiveOptionsFromEnvironment(environment, stateDirectory);
  return {
    stateDirectory,
    codexPathOverride: environment.USINE_CODEX_PATH_OVERRIDE,
    roles,
    forge,
    githubRead,
    roleOutputTransform,
    workerEnvironment,
    adapterSelectionEnvironment: codingSessionAdapterSelectionEnvironment(environment),
    credentialFreeGitEnvironment: credentialFreeGitEnvironment(environment),
    sessionArchive,
  };
}

export function sessionArchiveOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  stateDirectory: string,
): SessionArchiveOptions {
  return {
    stateDirectory,
    maxArchiveBytes: finitePositiveEnvironmentLimit(
      environment.USINE_SESSION_ARCHIVE_MAX_BYTES,
      "USINE_SESSION_ARCHIVE_MAX_BYTES",
    ),
    maxArchives: finitePositiveEnvironmentLimit(
      environment.USINE_SESSION_ARCHIVE_MAX_COUNT,
      "USINE_SESSION_ARCHIVE_MAX_COUNT",
    ),
  };
}

function finitePositiveEnvironmentLimit(
  value: string | undefined,
  name: string,
): number | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  if (!/^\d+$/.test(configured)) throw new Error(`${name} must be a positive finite integer`);
  const limit = Number(configured);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(`${name} must be a positive finite integer`);
  return limit;
}

export function githubReadPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  repository: { owner: string; name: string; githubReadProfile?: string | null },
): GithubReadPolicy | undefined {
  const profile = repository.githubReadProfile?.trim();
  if (!profile) return undefined;
  if (!forgeProfileSchema.safeParse(profile).success)
    throw new Error("GitHub read profile is malformed");
  const prefix = `USINE_GITHUB_READ_PROFILE_${profile.toUpperCase().replaceAll("-", "_")}_`;
  const configuredRepository = requiredProfileValue(
    environment[`${prefix}REPOSITORY`],
    "unauthorized",
    profile,
    repository,
  );
  if (configuredRepository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
    throw new Error(`GitHub read profile '${profile}' is not authorized for this repository`);

  const policy = githubApiPolicyFromEnvironment(environment, prefix, profile, repository);
  return {
    policy,
    implementerTools: githubReadToolsFromEnvironment(environment[`${prefix}IMPLEMENTER_TOOLS`]),
    reviewerTools: githubReadToolsFromEnvironment(environment[`${prefix}REVIEWER_TOOLS`]),
  };
}

function roleOutputTransformFromEnvironment(
  environment: NodeJS.ProcessEnv,
): RoleOutputTransform | undefined {
  const apiKey = environment.USINE_ROLE_OUTPUT_API_KEY?.trim();
  const baseURL = environment.USINE_ROLE_OUTPUT_API_URL?.trim();
  const model = environment.USINE_ROLE_OUTPUT_MODEL?.trim();
  const configured = [apiKey, baseURL, model].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 3 || !apiKey || !baseURL || !model)
    throw new Error("role output transform configuration is incomplete");
  return createOpenAICompatibleRoleOutputTransform({ apiKey, baseURL, model });
}

export function forgePolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  repository: { owner: string; name: string; forgeProfile: string },
): ForgePolicy {
  const profile = repository.forgeProfile.trim();
  if (!forgeProfileSchema.safeParse(profile).success)
    throw new ForgeProfileResolutionError(
      "malformed",
      profile || "<missing>",
      repositoryIdentity(repository),
    );
  const prefix = `USINE_FORGE_PROFILE_${profile.toUpperCase().replaceAll("-", "_")}_`;
  const appSlug = requiredProfileValue(
    environment[`${prefix}APP_SLUG`],
    "unauthorized",
    profile,
    repository,
    "app_slug",
  );
  const testToken = environment[`${prefix}TEST_TOKEN`];
  const apiUrl = environment[`${prefix}API_URL`]?.trim();
  const gitUrl =
    environment[`${prefix}GIT_URL`]?.trim() ||
    `https://github.com/${repository.owner}/${repository.name}.git`;
  const configuredRepository = requiredProfileValue(
    environment[`${prefix}REPOSITORY`],
    "unauthorized",
    profile,
    repository,
    "repository",
  );
  if (configuredRepository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
    throw new ForgeProfileResolutionError(
      "repository_mismatch",
      profile,
      repositoryIdentity(repository),
      "repository",
    );
  if (testToken) {
    if (!apiUrl || !isLoopbackHttpUrl(apiUrl))
      throw new Error("test GitHub token is restricted to loopback API URL");
    return { mode: "test", appSlug, token: testToken, apiUrl, gitUrl };
  }

  const appId = requiredProfileValue(
    environment[`${prefix}APP_ID`],
    "malformed",
    profile,
    repository,
    "app_id",
  );
  const privateKeyPath = requiredProfileValue(
    environment[`${prefix}PRIVATE_KEY_PATH`],
    "malformed",
    profile,
    repository,
    "private_key",
  );
  const installationId = Number(environment[`${prefix}INSTALLATION_ID`]);
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new ForgeProfileResolutionError(
      "malformed",
      profile,
      repositoryIdentity(repository),
      "installation_id",
    );
  return { mode: "app", appSlug, appId, installationId, privateKeyPath, gitUrl };
}

export async function forgeReadinessFromEnvironment(
  environment: NodeJS.ProcessEnv,
  repository: { owner: string; name: string; forgeProfile: string },
  options: { fetch?: typeof fetch; deadlineEpochMs?: number; signal?: AbortSignal } = {},
): Promise<ForgeReadinessResult> {
  let forge: ForgePolicy;
  try {
    forge = forgePolicyFromEnvironment(environment, repository);
  } catch (error) {
    return forgeProfileReadinessFailure(error);
  }
  return checkForgeReadiness({
    repository,
    forge,
    ...options,
  });
}

function forgeProfileReadinessFailure(error: unknown): ForgeReadinessResult {
  if (error instanceof ForgeProfileResolutionError) {
    if (error.field === "installation_id")
      return {
        ready: false,
        code: "installation_missing",
        expected: "a positive Forge App installation ID in host-private configuration",
        observed: "the configured installation ID is missing or malformed",
        action: "Record the installed App's installation ID, then rerun readiness.",
      };
    if (error.code === "repository_mismatch" || error.field === "repository")
      return {
        ready: false,
        code: "repository_binding_missing",
        expected: "the host-private Forge profile binding to the registered owner/name",
        observed: "the configured Forge repository binding does not match the registration",
        action:
          "Set the Forge profile repository to the registered owner/name, then rerun readiness.",
      };
  }
  return {
    ready: false,
    code: "identity_missing",
    expected: "a complete host-private Forge App identity",
    observed: "the Forge App slug, App ID, or private-key configuration is missing or malformed",
    action: "Configure the Forge App slug, App ID, and private-key path, then rerun readiness.",
  };
}

function githubApiPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  prefix: string,
  profile: string,
  repository: { owner: string; name: string },
): GithubApiPolicy {
  const appSlug = requiredProfileValue(
    environment[`${prefix}APP_SLUG`],
    "unauthorized",
    profile,
    repository,
  );
  const testToken = environment[`${prefix}TEST_TOKEN`]?.trim();
  const apiUrl = environment[`${prefix}API_URL`]?.trim();
  if (testToken) {
    if (!apiUrl || !isLoopbackHttpUrl(apiUrl))
      throw new Error("test GitHub read token is restricted to loopback API URL");
    return { mode: "test", appSlug, token: testToken, apiUrl };
  }
  const appId = requiredProfileValue(
    environment[`${prefix}APP_ID`],
    "malformed",
    profile,
    repository,
  );
  const privateKeyPath = requiredProfileValue(
    environment[`${prefix}PRIVATE_KEY_PATH`],
    "malformed",
    profile,
    repository,
  );
  const installationId = Number(environment[`${prefix}INSTALLATION_ID`]);
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new Error("GitHub read installation ID is malformed");
  return { mode: "app", appSlug, appId, installationId, privateKeyPath };
}

function githubReadToolsFromEnvironment(value: string | undefined): GithubReadToolName[] {
  const raw = value?.trim();
  if (!raw) return [...githubReadToolNames];
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("GitHub read tool scope is empty");
  const tools: GithubReadToolName[] = [];
  for (const name of names) {
    const tool = githubReadToolNames.find((candidate) => candidate === name);
    if (!tool) throw new Error("GitHub read tool scope is invalid");
    tools.push(tool);
  }
  return [...new Set(tools)];
}

function requiredProfileValue(
  value: string | undefined,
  code: ForgeProfileErrorCode,
  profile: string,
  repository: { owner: string; name: string },
  field?: ForgeProfileField,
): string {
  const result = value?.trim();
  if (!result)
    throw new ForgeProfileResolutionError(code, profile, repositoryIdentity(repository), field);
  return result;
}

function repositoryIdentity(repository: { owner: string; name: string }): string {
  return `${repository.owner}/${repository.name}`;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
