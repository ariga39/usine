import { homedir } from "node:os";
import { join } from "node:path";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import {
  explicitWorkerEnvironment,
  validateCodexProfile,
  type RolePolicy,
} from "@usine/coding-session";
import type { ForgePolicy } from "@usine/forge-delivery";

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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile))
    throw new Error("forge profile is malformed");
  const prefix = `USINE_FORGE_PROFILE_${profile.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_`;
  const appSlug = required(environment[`${prefix}APP_SLUG`], "forge profile is unauthorized");
  const testToken = environment[`${prefix}TEST_TOKEN`];
  const apiUrl = environment[`${prefix}API_URL`]?.trim();
  const gitUrl =
    environment[`${prefix}GIT_URL`]?.trim() ||
    `https://github.com/${repository.owner}/${repository.name}.git`;
  const configuredRepository = required(
    environment[`${prefix}REPOSITORY`],
    "forge profile is unauthorized",
  );
  if (configuredRepository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
    throw new Error("forge profile does not match repository");
  if (testToken) {
    if (!apiUrl || !isLoopbackHttpUrl(apiUrl))
      throw new Error("test GitHub token is restricted to loopback API URL");
    return { mode: "test", appSlug, token: testToken, apiUrl, gitUrl };
  }

  const appId = required(environment[`${prefix}APP_ID`], "forge profile is malformed");
  const privateKeyPath = required(
    environment[`${prefix}PRIVATE_KEY_PATH`],
    "forge profile is malformed",
  );
  const installationId = Number(environment[`${prefix}INSTALLATION_ID`]);
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new Error("forge profile is malformed");
  return { mode: "app", appSlug, appId, installationId, privateKeyPath, gitUrl };
}

function required(value: string | undefined, message: string): string {
  const result = value?.trim();
  if (!result) throw new Error(message);
  return result;
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
