import { readFile } from "node:fs/promises";
import { App, Octokit } from "octokit";
import { remainingUntil } from "@usine/task-authority";
import type { CheckResult, ResolvedTaskContract, ReviewVerdict } from "@usine/task-authority";

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

export type ForgeReadinessPermission = "contents" | "pull_requests" | "issues";

export type GithubApiPolicy =
  | {
      mode: "test";
      appSlug: string;
      token: string;
      apiUrl: string;
      /** Hermetic test-only identity; production identity comes from App authentication metadata. */
      installationId?: number;
      /** Hermetic test-only metadata; production metadata comes from App authentication. */
      permissions?: Partial<Record<ForgeReadinessPermission, string>>;
      /** Hermetic test-only App identity; production identity comes from App JWT observation. */
      appId?: string;
      appToken?: string;
    }
  | {
      mode: "app";
      appSlug: string;
      appId: string;
      installationId: number;
      privateKeyPath: string;
    };

export type ForgePolicy =
  | (Extract<GithubApiPolicy, { mode: "test" }> & {
      gitUrl: string;
    })
  | (Extract<GithubApiPolicy, { mode: "app" }> & {
      gitUrl: string;
    });

export function forgeGitEnvironment(
  environment: NodeJS.ProcessEnv,
  token: string,
  gitUrl: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of PORTABLE_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = "/dev/null";
  result.GIT_TERMINAL_PROMPT = "0";
  if (gitUrl.startsWith("https://github.com/")) {
    result.GIT_CONFIG_COUNT = "1";
    result.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    result.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return result;
}

export interface ForgeDeliveryOptions {
  repository: string;
  deadlineEpochMs: number;
  forge: ForgePolicy;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ForgeClient {
  octokit: InstanceType<typeof Octokit>;
  token: string;
  appSlug: string;
  installationId?: number;
  permissions?: Partial<Record<ForgeReadinessPermission, string>>;
  verifyAppIdentity: (request?: {
    timeout: number;
    signal?: AbortSignal;
  }) => Promise<ForgeAppIdentity>;
}

export interface ForgeAppIdentity {
  readonly id: number;
  readonly slug: string;
}

export type ForgeReadinessResult =
  | {
      readonly ready: true;
      readonly appSlug: string;
      readonly installationId: number;
      readonly repository: string;
      readonly permissions: {
        readonly contents: "write";
        readonly pullRequests: "write";
        readonly issues: "write";
      };
    }
  | {
      readonly ready: false;
      readonly code:
        | "identity_missing"
        | "installation_missing"
        | "repository_binding_missing"
        | "permission_missing"
        | "authentication_failed";
      readonly expected: string;
      readonly observed: string;
      readonly action: string;
      readonly permission?: ForgeReadinessPermission;
    };

export interface ForgeReadinessOptions {
  readonly repository: { readonly owner: string; readonly name: string };
  readonly forge: ForgePolicy;
  readonly fetch?: typeof fetch;
  readonly deadlineEpochMs?: number;
  readonly signal?: AbortSignal;
}

export class ForgeAuthenticationError extends Error {
  readonly code = "forge_authentication_failed" as const;
  readonly name = "ForgeAuthenticationError";

  constructor(readonly status?: number) {
    super("forge authentication capability is unavailable");
  }
}

function providerStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = error.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export async function createGithubApiClient(
  policy: GithubApiPolicy,
  fetchImplementation?: typeof fetch,
  requestOptions?: { timeout: number; retries: number; signal?: AbortSignal },
): Promise<ForgeClient> {
  const requestDefaults =
    requestOptions === undefined && fetchImplementation === undefined
      ? undefined
      : {
          ...requestOptions,
          ...(fetchImplementation === undefined ? undefined : { fetch: fetchImplementation }),
        };
  if (policy.mode === "test") {
    return {
      octokit: new Octokit({
        auth: policy.token,
        baseUrl: policy.apiUrl,
        request: requestDefaults,
      }),
      token: policy.token,
      appSlug: policy.appSlug,
      installationId: policy.installationId,
      permissions: policy.permissions,
      verifyAppIdentity: async (request) => {
        const appClient = new Octokit({
          auth: policy.appToken ?? policy.token,
          baseUrl: policy.apiUrl,
          request: requestDefaults,
        });
        const response = await appClient.request("GET /app", {
          request,
        });
        return appIdentityFrom(response.data);
      },
    };
  }
  try {
    const AppOctokit =
      requestOptions === undefined ? Octokit : Octokit.defaults({ request: requestOptions });
    const app = new App({
      appId: policy.appId,
      privateKey: await readFile(policy.privateKeyPath, "utf8"),
      Octokit: AppOctokit,
    });
    const octokit = await app.getInstallationOctokit(policy.installationId);
    const auth = installationAuthenticationFrom(await octokit.auth({ type: "installation" }));
    return {
      octokit,
      token: auth.token,
      appSlug: policy.appSlug,
      installationId: auth.installationId,
      permissions: auth.permissions,
      verifyAppIdentity: async (request) => {
        const response = await app.octokit.request("GET /app", { request });
        return appIdentityFrom(response.data);
      },
    };
  } catch (error) {
    if (error instanceof ForgeAuthenticationError) throw error;
    throw new ForgeAuthenticationError(providerStatusOf(error));
  }
}

/**
 * Proves the host Forge App capability with authenticated reads only.
 * GitHub's installation-token exchange is authentication, not a repository mutation.
 */
export async function checkForgeReadiness(
  options: ForgeReadinessOptions,
): Promise<ForgeReadinessResult> {
  const repositoryName = `${options.repository.owner}/${options.repository.name}`;
  const deadlineEpochMs = options.deadlineEpochMs ?? Date.now() + 30_000;
  let client: ForgeClient;
  try {
    client = await createGithubApiClient(
      options.forge,
      options.fetch,
      requestOptions(deadlineEpochMs, options.signal),
    );
  } catch (error) {
    const status = providerStatusOf(error);
    if (status === 404)
      return installationMissing(
        expectedInstallationId(options.forge),
        "the configured installation was not found",
      );
    return authenticationFailure(expectedInstallationId(options.forge), status);
  }

  try {
    const installationId = client.installationId;
    const expectedId = expectedInstallationId(options.forge);
    if (installationId === undefined || (expectedId !== undefined && installationId !== expectedId))
      return {
        ready: false,
        code: "installation_missing",
        expected:
          expectedId === undefined
            ? "an authenticated Forge App installation identity"
            : `an active Forge App installation with ID ${expectedId}`,
        observed:
          installationId === undefined
            ? "installation authentication returned no installation ID"
            : `GitHub authenticated installation ID ${installationId}`,
        action: "Record the installed App's installation ID, then rerun readiness.",
      };
    let appIdentity: ForgeAppIdentity;
    try {
      appIdentity = await client.verifyAppIdentity(requestOptions(deadlineEpochMs, options.signal));
    } catch (error) {
      return authenticationFailure(expectedInstallationId(options.forge), providerStatusOf(error));
    }
    const expectedAppId = appIdFrom(options.forge);
    if (
      (expectedAppId !== undefined && appIdentity.id !== expectedAppId) ||
      appIdentity.slug.toLowerCase() !== options.forge.appSlug.toLowerCase()
    )
      return {
        ready: false,
        code: "identity_missing",
        expected:
          expectedAppId === undefined
            ? `Forge App slug '${options.forge.appSlug}'`
            : `Forge App ID ${expectedAppId} and slug '${options.forge.appSlug}'`,
        observed: `GitHub returned App ID ${appIdentity.id} with a different configured identity`,
        action: "Configure the App ID and slug for the installed Forge App, then rerun readiness.",
      };
    const permissions = client.permissions ?? {};
    for (const requirement of [
      ["contents", "Contents"],
      ["pull_requests", "Pull requests"],
      ["issues", "Issues"],
    ] as const) {
      const [permission, label] = requirement;
      const observed = permissions[permission];
      if (observed !== "write")
        return {
          ready: false,
          code: "permission_missing",
          permission,
          expected: `${label}: write`,
          observed: `${label}: ${observed ?? "unavailable"}`,
          action: `Update the Forge App installation permission for ${label} to write, then rerun readiness.`,
        };
    }

    const repositoryResponse = await client.octokit.request("GET /repos/{owner}/{repo}", {
      owner: options.repository.owner,
      repo: options.repository.name,
      request: requestOptions(deadlineEpochMs, options.signal),
    });
    const accessibleRepository = repositoryFrom(repositoryResponse.data);
    if (accessibleRepository?.toLowerCase() !== repositoryName.toLowerCase())
      return {
        ready: false,
        code: "repository_binding_missing",
        expected: `Forge App installation access to ${repositoryName}`,
        observed: "the installation does not expose the registered repository",
        action: `Install the Forge App on ${repositoryName}, then rerun readiness.`,
      };

    return {
      ready: true,
      appSlug: options.forge.appSlug,
      installationId,
      repository: repositoryName,
      permissions: { contents: "write", pullRequests: "write", issues: "write" },
    };
  } catch (error) {
    const status = providerStatusOf(error);
    if (status === 404)
      return {
        ready: false,
        code: "repository_binding_missing",
        expected: `Forge App installation access to ${repositoryName}`,
        observed: "GitHub did not return the registered repository",
        action: `Install the Forge App on ${repositoryName}, then rerun readiness.`,
      };
    return authenticationFailure(expectedInstallationId(options.forge), status);
  }
}

function installationMissing(
  installationId: number | undefined,
  observed: string,
): ForgeReadinessResult {
  return {
    ready: false,
    code: "installation_missing",
    expected:
      installationId === undefined
        ? "an active Forge App installation"
        : `an active Forge App installation with ID ${installationId}`,
    observed,
    action: "Install the Forge App, record the installation ID, then rerun readiness.",
  };
}

function authenticationFailure(
  installationId: number | undefined,
  status: number | undefined,
): ForgeReadinessResult {
  return {
    ready: false,
    code: "authentication_failed",
    expected:
      installationId === undefined
        ? "authenticated access from the configured Forge App installation"
        : `authenticated access from Forge App installation ${installationId}`,
    observed:
      status === 401 || status === 403
        ? "GitHub rejected the Forge installation authentication"
        : "Forge installation authentication was unavailable",
    action:
      "Check the App ID, installation ID, private key, and App installation, then rerun readiness.",
  };
}

function requestOptions(deadlineEpochMs: number, signal: AbortSignal | undefined) {
  return {
    timeout: remainingUntil(deadlineEpochMs),
    retries: 0,
    ...(signal === undefined ? {} : { signal }),
  };
}

function expectedInstallationId(forge: ForgePolicy): number | undefined {
  return forge.installationId;
}

function appIdFrom(forge: ForgePolicy): number | undefined {
  if (forge.mode !== "app") {
    const value = forge.appId?.trim();
    if (!value || !/^\d+$/.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  const id = Number(forge.appId);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function repositoryFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fullName = (value as { full_name?: unknown }).full_name;
  return typeof fullName === "string" ? fullName : undefined;
}

interface InstallationAuthentication {
  readonly token: string;
  readonly installationId: number;
  readonly permissions?: Partial<Record<ForgeReadinessPermission, string>>;
}

function installationAuthenticationFrom(value: unknown): InstallationAuthentication {
  if (typeof value !== "object" || value === null) throw new ForgeAuthenticationError();
  const token = Reflect.get(value, "token");
  const installationId = Reflect.get(value, "installationId");
  if (
    typeof token !== "string" ||
    typeof installationId !== "number" ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0
  )
    throw new ForgeAuthenticationError();

  const rawPermissions = Reflect.get(value, "permissions");
  if (typeof rawPermissions !== "object" || rawPermissions === null)
    return { token, installationId };
  const permissions: Partial<Record<ForgeReadinessPermission, string>> = {};
  for (const permission of ["contents", "pull_requests", "issues"] as const) {
    const observed = Reflect.get(rawPermissions, permission);
    if (typeof observed === "string") permissions[permission] = observed;
  }
  return { token, installationId, permissions };
}

function appIdentityFrom(value: unknown): ForgeAppIdentity {
  if (typeof value !== "object" || value === null) throw new ForgeAuthenticationError();
  const input = value as { id?: unknown; slug?: unknown };
  const id = input.id;
  const slug = input.slug;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== "string" ||
    slug.trim() === "" ||
    slug.length > 100
  )
    throw new ForgeAuthenticationError();
  return { id, slug: slug.trim() };
}

export function approvalAttestationBody(
  contract: ResolvedTaskContract,
  sha: string,
  check: CheckResult,
  review: ReviewVerdict,
): string {
  return [
    `<!-- usine-approval:${contract.id}:${sha} -->`,
    "Usine exact-SHA semantic approval attestation",
    `- Task: \`${contract.id}\``,
    `- Candidate: \`${sha}\``,
    `- Project check: \`${check.status}\``,
    `- Fresh reviewer verdict: \`${review.verdict}\``,
  ].join("\n");
}
