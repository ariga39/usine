import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { App, Octokit } from "octokit";
import type { TaskContract } from "./contract.js";
import type { CheckResult, DeliveryEffect, ReviewVerdict } from "./task-authority.js";

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : undefined;
}

function timeoutUntil(deadlineEpochMs: number): number {
  const remaining = deadlineEpochMs - Date.now() - 100;
  if (remaining <= 0) throw new Error("elapsed budget exhausted");
  return Math.max(1, remaining);
}

interface ForgeClient {
  octokit: InstanceType<typeof Octokit>;
  token: string;
  appSlug: string;
}

export interface ForgeDeliveryOptions {
  repository: string;
  deadlineEpochMs: number;
}

export class ForgeDelivery {
  constructor(private readonly options: ForgeDeliveryOptions) {}

  async deliver(contract: TaskContract, sha: string, check: CheckResult, review: ReviewVerdict): Promise<DeliveryEffect> {
    if (review.sha !== sha || review.verdict !== "approved") throw new Error("delivery requires exact-SHA semantic approval");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.reconcile(contract, sha, check, review);
      } catch (error) {
        lastError = error;
        const status = statusOf(error);
        if (status !== undefined && status !== 408 && status !== 409 && status !== 429 && status < 500) throw error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutUntil(this.options.deadlineEpochMs))));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async client(): Promise<ForgeClient> {
    const appSlug = process.env.USINE_GITHUB_APP_SLUG;
    if (!appSlug) throw new Error("USINE_GITHUB_APP_SLUG is required");
    const testToken = process.env.USINE_GITHUB_TEST_TOKEN;
    const apiUrl = process.env.USINE_GITHUB_API_URL;
    if (testToken) {
      if (!apiUrl || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(apiUrl)) throw new Error("test GitHub token is restricted to loopback API URL");
      return { octokit: new Octokit({ auth: testToken, baseUrl: apiUrl }), token: testToken, appSlug };
    }
    const appId = process.env.USINE_GITHUB_APP_ID;
    const installationId = Number(process.env.USINE_GITHUB_INSTALLATION_ID);
    const privateKeyPath = process.env.USINE_GITHUB_PRIVATE_KEY_PATH;
    if (!appId || !Number.isSafeInteger(installationId) || !privateKeyPath) throw new Error("GitHub App credentials are required");
    const app = new App({ appId, privateKey: await readFile(privateKeyPath, "utf8") });
    const octokit = await app.getInstallationOctokit(installationId);
    const auth = (await octokit.auth({ type: "installation" })) as { token?: unknown };
    if (typeof auth.token !== "string") throw new Error("GitHub App did not produce an installation token");
    return { octokit, token: auth.token, appSlug };
  }

  private async reconcile(contract: TaskContract, sha: string, check: CheckResult, review: ReviewVerdict): Promise<DeliveryEffect> {
    const client = await this.client();
    const { owner, name: repo } = contract.repository;
    const { branch, baseBranch } = contract.delivery;
    let observedHead: string | null = null;
    try {
      observedHead = (await client.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}`, request: { timeout: timeoutUntil(this.options.deadlineEpochMs), retries: 0 } })).data.object.sha;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    if (observedHead !== sha) {
      const gitUrl = process.env.USINE_GITHUB_GIT_URL ?? `https://github.com/${owner}/${repo}.git`;
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      if (gitUrl.startsWith("https://github.com/")) {
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${client.token}`).toString("base64")}`;
      }
      await execa("git", ["-C", this.options.repository, "push", `--force-with-lease=refs/heads/${branch}:${observedHead ?? ""}`, gitUrl, `${sha}:refs/heads/${branch}`], { env, timeout: timeoutUntil(this.options.deadlineEpochMs) });
    }
    const pullRequests = await client.octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base: baseBranch, state: "all", per_page: 100, request: { timeout: timeoutUntil(this.options.deadlineEpochMs), retries: 0 } });
    const existing = pullRequests.data.find((pr) => pr.head.sha === sha);
    if (existing && existing.state !== "open") throw new Error(`closed delivery PR #${existing.number} already targets candidate ${sha}; delivery quarantined`);
    if (!existing && pullRequests.data.length > 0) throw new Error(`open delivery PR #${pullRequests.data[0]?.number ?? "unknown"} has a conflicting head; delivery quarantined`);
    const pullRequest = existing ?? (await client.octokit.rest.pulls.create({ owner, repo, head: branch, base: baseBranch, title: contract.delivery.title, body: `${contract.delivery.body}\n\nCloses #${contract.delivery.issue}`, draft: false, request: { timeout: timeoutUntil(this.options.deadlineEpochMs), retries: 0 } })).data;
    const body = [`<!-- usine-approval:${contract.id}:${sha} -->`, "Usine exact-SHA semantic approval attestation", `- Candidate: \`${sha}\``, `- Project check: \`${check.command}\` (${check.status})`, `- Fresh reviewer verdict: \`${review.verdict}\``, `- Review summary: ${review.summary}`].join("\n");
    const comments = await client.octokit.paginate(client.octokit.rest.issues.listComments, { owner, repo, issue_number: pullRequest.number, per_page: 100, request: { timeout: timeoutUntil(this.options.deadlineEpochMs), retries: 0 } });
    const attestation = comments.find((comment) => comment.body === body && (comment as typeof comment & { performed_via_github_app?: { slug?: string } }).performed_via_github_app?.slug === client.appSlug && comment.user?.type === "Bot") ?? (await client.octokit.rest.issues.createComment({ owner, repo, issue_number: pullRequest.number, body, request: { timeout: timeoutUntil(this.options.deadlineEpochMs), retries: 0 } })).data;
    return { sha, effect: "github", prNumber: pullRequest.number, url: pullRequest.html_url, attestationId: String(attestation.id) };
  }
}
