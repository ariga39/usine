import { readFile } from "node:fs/promises";
import { App, Octokit } from "octokit";
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
  const status = (error as { status: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export async function createForgeClient(options: ForgeDeliveryOptions): Promise<ForgeClient> {
  const forge = options.forge;
  if (forge.mode === "test") {
    return {
      octokit: new Octokit({ auth: forge.token, baseUrl: forge.apiUrl }),
      token: forge.token,
      appSlug: forge.appSlug,
    };
  }
  try {
    const app = new App({
      appId: forge.appId,
      privateKey: await readFile(forge.privateKeyPath, "utf8"),
    });
    const octokit = await app.getInstallationOctokit(forge.installationId);
    const auth = (await octokit.auth({ type: "installation" })) as { token?: unknown };
    if (typeof auth.token !== "string") throw new ForgeAuthenticationError();
    return { octokit, token: auth.token, appSlug: forge.appSlug };
  } catch (error) {
    if (error instanceof ForgeAuthenticationError) throw error;
    throw new ForgeAuthenticationError(providerStatusOf(error));
  }
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
    `- Candidate: \`${sha}\``,
    `- Project check: \`${check.command}\` (${check.status})`,
    `- Fresh reviewer verdict: \`${review.verdict}\``,
    `- Review summary: ${review.summary}`,
  ].join("\n");
}
