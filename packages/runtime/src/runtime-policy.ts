import { homedir } from "node:os";
import { join } from "node:path";
import type { RolePolicy } from "@usine/coding-session";
export { explicitWorkerEnvironment, type RolePolicy } from "@usine/coding-session";

const PORTABLE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface GitAuthor {
  name: string;
  email: string;
}

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

export type ForgePolicy =
  | {
      mode: "test";
      appSlug: string;
      token: string;
      apiUrl: string;
      gitUrl: string;
    }
  | {
      mode: "app";
      appSlug: string;
      appId: string;
      installationId: number;
      privateKeyPath: string;
      gitUrl: string;
    };

export interface CapabilityEnvironments {
  worker: NodeJS.ProcessEnv;
  check: NodeJS.ProcessEnv;
  credentialFreeGit: NodeJS.ProcessEnv;
}

export interface RuntimePolicy {
  stateDirectory: string;
  stopAfterAdmitted: boolean;
  gitAuthor: GitAuthor;
  roles: {
    implementer: RolePolicy;
    reviewer: RolePolicy;
  };
  forge: ForgePolicy | null;
  capabilities: CapabilityEnvironments;
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
  return {
    stateDirectory,
    stopAfterAdmitted,
    gitAuthor,
    roles,
    forge,
    capabilities: capabilityEnvironments(environment),
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

export function capabilityEnvironments(environment: NodeJS.ProcessEnv): CapabilityEnvironments {
  const portable = portableEnvironment(environment);
  const safe = { CI: "true", ...portable };
  return {
    worker: { ...safe },
    check: { ...safe },
    credentialFreeGit: {
      ...portable,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

export function forgeGitEnvironment(
  environments: CapabilityEnvironments,
  token: string,
  gitUrl: string,
): NodeJS.ProcessEnv {
  const result = { ...environments.credentialFreeGit };
  if (gitUrl.startsWith("https://github.com/")) {
    result.GIT_CONFIG_COUNT = "1";
    result.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    result.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return result;
}

function portableEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
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
