import { homedir } from "node:os";
import { join } from "node:path";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import {
  explicitWorkerEnvironment,
  validateCodexProfile,
  type RolePolicy,
} from "@usine/coding-session";
import type { ForgePolicy } from "@usine/forge-delivery";
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
  roles: {
    implementer: RolePolicy;
    reviewer: RolePolicy;
  };
  forge: ForgePolicy;
  workerEnvironment: NodeJS.ProcessEnv;
  credentialFreeGitEnvironment: NodeJS.ProcessEnv;
}

export type ForgeProfileErrorCode = "malformed" | "unauthorized" | "repository_mismatch";

export class ForgeProfileResolutionError extends Error {
  readonly name = "ForgeProfileResolutionError";

  constructor(
    readonly code: ForgeProfileErrorCode,
    readonly profile: string,
    readonly repository: string,
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
  },
  homeDirectory = homedir(),
): RuntimePolicy {
  const stateDirectory = stateDirectoryFromEnvironment(environment, homeDirectory);
  const roles = {
    implementer: {
      ...defaultRolePolicies.implementer,
      profile: validateCodexProfile(repository.implementerProfile),
    },
    reviewer: {
      ...defaultRolePolicies.reviewer,
      profile: validateCodexProfile(repository.reviewerProfile),
    },
  };

  const forge = forgePolicyFromEnvironment(environment, repository);
  const workerEnvironment = explicitWorkerEnvironment(environment);
  return {
    stateDirectory,
    roles,
    forge,
    workerEnvironment,
    credentialFreeGitEnvironment: credentialFreeGitEnvironment(environment),
  };
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
  );
  if (configuredRepository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
    throw new ForgeProfileResolutionError(
      "repository_mismatch",
      profile,
      repositoryIdentity(repository),
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
  );
  const privateKeyPath = requiredProfileValue(
    environment[`${prefix}PRIVATE_KEY_PATH`],
    "malformed",
    profile,
    repository,
  );
  const installationId = Number(environment[`${prefix}INSTALLATION_ID`]);
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new ForgeProfileResolutionError("malformed", profile, repositoryIdentity(repository));
  return { mode: "app", appSlug, appId, installationId, privateKeyPath, gitUrl };
}

function requiredProfileValue(
  value: string | undefined,
  code: ForgeProfileErrorCode,
  profile: string,
  repository: { owner: string; name: string },
): string {
  const result = value?.trim();
  if (!result) throw new ForgeProfileResolutionError(code, profile, repositoryIdentity(repository));
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
