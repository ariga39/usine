import { homedir } from "node:os";
import { join } from "node:path";
import { credentialFreeGitEnvironment, type GitAuthor } from "@usine/candidate-workspace";
import { explicitWorkerEnvironment, type RolePolicy } from "@usine/coding-session";
import type { ForgePolicy } from "@usine/forge-delivery";

const defaultRolePolicies = {
  implementer: {
    role: "implementer" as const,
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    sandbox: "workspace-write" as const,
  },
  reviewer: {
    role: "reviewer" as const,
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    sandbox: "read-only" as const,
  },
};

export interface RuntimePolicy {
  stateDirectory: string;
  stopAfterAdmitted: boolean;
  gitAuthor: GitAuthor;
  roles: {
    implementer: RolePolicy;
    reviewer: RolePolicy;
  };
  forge: ForgePolicy | null;
  workerEnvironment: NodeJS.ProcessEnv;
  checkEnvironment: NodeJS.ProcessEnv;
  credentialFreeGitEnvironment: NodeJS.ProcessEnv;
}

export function runtimePolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  repository: { owner: string; name: string },
  homeDirectory = homedir(),
): RuntimePolicy {
  const stopAfterAdmitted = environment.USINE_STOP_AFTER === "admitted";
  const userStateDirectory =
    environment.XDG_STATE_HOME?.trim() || join(homeDirectory, ".local", "state");
  const stateDirectory = environment.USINE_STATE_DIR?.trim() || join(userStateDirectory, "usine");
  const roles = {
    implementer: {
      ...defaultRolePolicies.implementer,
      model: environment.USINE_IMPLEMENTER_MODEL?.trim() || defaultRolePolicies.implementer.model,
    },
    reviewer: {
      ...defaultRolePolicies.reviewer,
      model: environment.USINE_REVIEWER_MODEL?.trim() || defaultRolePolicies.reviewer.model,
      reasoningEffort:
        environment.USINE_REVIEWER_REASONING_EFFORT?.trim() ||
        defaultRolePolicies.reviewer.reasoningEffort,
    },
  };

  const gitAuthor = parseGitAuthor(environment);
  const forge = parseForgePolicy(environment, stopAfterAdmitted, repository);
  const workerEnvironment = explicitWorkerEnvironment(environment);
  return {
    stateDirectory,
    stopAfterAdmitted,
    gitAuthor,
    roles,
    forge,
    workerEnvironment,
    checkEnvironment: workerEnvironment,
    credentialFreeGitEnvironment: credentialFreeGitEnvironment(environment),
  };
}

function parseGitAuthor(environment: NodeJS.ProcessEnv): GitAuthor {
  const name = environment.USINE_GIT_AUTHOR_NAME?.trim();
  const email = environment.USINE_GIT_AUTHOR_EMAIL?.trim();
  if (!name || !email) {
    const missing = [
      name ? null : "USINE_GIT_AUTHOR_NAME",
      email ? null : "USINE_GIT_AUTHOR_EMAIL",
    ].filter((key): key is string => key !== null);
    throw new Error(`Git author identity requires ${missing.join(" and ")}`);
  }
  return { name, email };
}

function parseForgePolicy(
  environment: NodeJS.ProcessEnv,
  admissionOnly: boolean,
  repository: { owner: string; name: string },
): ForgePolicy | null {
  const appSlug = environment.USINE_GITHUB_APP_SLUG?.trim();
  const testToken = environment.USINE_GITHUB_TEST_TOKEN;
  const apiUrl = environment.USINE_GITHUB_API_URL?.trim();
  const gitUrl =
    environment.USINE_GITHUB_GIT_URL?.trim() ||
    `https://github.com/${repository.owner}/${repository.name}.git`;

  if (!testToken && admissionOnly && !appSlug && !apiUrl) return null;
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
