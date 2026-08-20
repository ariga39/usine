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
  forge: ForgePolicy | null;
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
  repository: { owner: string; name: string; implementerProfile: string; reviewerProfile: string },
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

  const forge = parseForgePolicy(environment, repository);
  const workerEnvironment = explicitWorkerEnvironment(environment);
  return {
    stateDirectory,
    roles,
    forge,
    workerEnvironment,
    credentialFreeGitEnvironment: credentialFreeGitEnvironment(environment),
  };
}

function parseForgePolicy(
  environment: NodeJS.ProcessEnv,
  repository: { owner: string; name: string },
): ForgePolicy | null {
  const appSlug = environment.USINE_GITHUB_APP_SLUG?.trim();
  const testToken = environment.USINE_GITHUB_TEST_TOKEN;
  const apiUrl = environment.USINE_GITHUB_API_URL?.trim();
  const gitUrl =
    environment.USINE_GITHUB_GIT_URL?.trim() ||
    `https://github.com/${repository.owner}/${repository.name}.git`;

  if (!testToken && !appSlug && !apiUrl) return null;
  if (!appSlug) throw new Error("USINE_GITHUB_APP_SLUG is required");
  if (testToken) {
    if (!apiUrl || !isLoopbackHttpUrl(apiUrl))
      throw new Error("test GitHub token is restricted to loopback API URL");
    return { mode: "test", appSlug, token: testToken, apiUrl, gitUrl };
  }

  const appId = required(environment.USINE_GITHUB_APP_ID, "GitHub App credentials are required");
  const privateKeyPath = required(
    environment.USINE_GITHUB_PRIVATE_KEY_PATH,
    "GitHub App credentials are required",
  );
  const installationId = Number(environment.USINE_GITHUB_INSTALLATION_ID);
  if (!Number.isSafeInteger(installationId) || installationId <= 0)
    throw new Error("GitHub App credentials are required");
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
