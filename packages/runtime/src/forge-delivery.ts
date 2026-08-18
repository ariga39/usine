import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { App, Octokit } from "octokit";
import type { TaskContract } from "./contract.js";
import type { CheckResult, DeliveryEffect, ReviewVerdict } from "./task-authority.js";
import {
  forgeGitEnvironment,
  type CapabilityEnvironments,
  type ForgePolicy,
} from "./runtime-policy.js";
import { remainingUntil } from "./remaining-until.js";

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

interface ForgeClient {
  octokit: InstanceType<typeof Octokit>;
  token: string;
  appSlug: string;
}

export interface ForgeDeliveryOptions {
  repository: string;
  deadlineEpochMs: number;
  forge: ForgePolicy;
  environment: CapabilityEnvironments;
}

export function approvalAttestationBody(
  contract: TaskContract,
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

export class ForgeDelivery {
  constructor(private readonly options: ForgeDeliveryOptions) {}

  async deliver(
    contract: TaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect> {
    if (review.sha !== sha || review.verdict !== "approved")
      throw new Error("delivery requires exact-SHA semantic approval");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.reconcile(contract, sha, check, review);
      } catch (error) {
        lastError = error;
        const status = statusOf(error);
        if (
          status !== undefined &&
          status !== 408 &&
          status !== 409 &&
          status !== 429 &&
          status < 500
        )
          throw error;
        if (attempt < 3)
          await new Promise((resolve) =>
            setTimeout(resolve, remainingUntil(this.options.deadlineEpochMs, 100)),
          );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async client(): Promise<ForgeClient> {
    const forge = this.options.forge;
    if (forge.mode === "test") {
      return {
        octokit: new Octokit({ auth: forge.token, baseUrl: forge.apiUrl }),
        token: forge.token,
        appSlug: forge.appSlug,
      };
    }
    const app = new App({
      appId: forge.appId,
      privateKey: await readFile(forge.privateKeyPath, "utf8"),
    });
    const octokit = await app.getInstallationOctokit(forge.installationId);
    const auth = (await octokit.auth({ type: "installation" })) as { token?: unknown };
    if (typeof auth.token !== "string")
      throw new Error("GitHub App did not produce an installation token");
    return { octokit, token: auth.token, appSlug: forge.appSlug };
  }

  private async reconcile(
    contract: TaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect> {
    const client = await this.client();
    const { owner, name: repo } = contract.repository;
    const { branch, baseBranch } = contract.delivery;
    let observedHead: string | null = null;
    try {
      observedHead = (
        await client.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          request: { timeout: remainingUntil(this.options.deadlineEpochMs), retries: 0 },
        })
      ).data.object.sha;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    if (observedHead !== sha) {
      const gitUrl = this.options.forge.gitUrl;
      const env = forgeGitEnvironment(this.options.environment, client.token, gitUrl);
      await execa(
        "git",
        [
          "-C",
          this.options.repository,
          "push",
          `--force-with-lease=refs/heads/${branch}:${observedHead ?? ""}`,
          gitUrl,
          `${sha}:refs/heads/${branch}`,
        ],
        { env, extendEnv: false, timeout: remainingUntil(this.options.deadlineEpochMs) },
      );
    }
    const pullRequests = await client.octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      base: baseBranch,
      state: "all",
      per_page: 100,
      request: { timeout: remainingUntil(this.options.deadlineEpochMs), retries: 0 },
    });
    const existing = pullRequests.data.find((pr) => pr.head.sha === sha);
    if (existing && existing.state !== "open")
      throw new Error(
        `closed delivery PR #${existing.number} already targets candidate ${sha}; delivery quarantined`,
      );
    if (!existing && pullRequests.data.length > 0)
      throw new Error(
        `open delivery PR #${pullRequests.data[0]?.number ?? "unknown"} has a conflicting head; delivery quarantined`,
      );
    const pullRequest =
      existing ??
      (
        await client.octokit.rest.pulls.create({
          owner,
          repo,
          head: branch,
          base: baseBranch,
          title: contract.delivery.title,
          body: `${contract.delivery.body}\n\nCloses #${contract.delivery.issue}`,
          draft: false,
          request: { timeout: remainingUntil(this.options.deadlineEpochMs), retries: 0 },
        })
      ).data;
    const body = approvalAttestationBody(contract, sha, check, review);
    const comments = await client.octokit.paginate(client.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullRequest.number,
      per_page: 100,
      request: { timeout: remainingUntil(this.options.deadlineEpochMs), retries: 0 },
    });
    const attestation =
      comments.find(
        (comment) =>
          comment.body === body &&
          (comment as typeof comment & { performed_via_github_app?: { slug?: string } })
            .performed_via_github_app?.slug === client.appSlug &&
          comment.user?.type === "Bot",
      ) ??
      (
        await client.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullRequest.number,
          body,
          request: { timeout: remainingUntil(this.options.deadlineEpochMs), retries: 0 },
        })
      ).data;
    return {
      sha,
      effect: "github",
      prNumber: pullRequest.number,
      url: pullRequest.html_url,
      attestationId: String(attestation.id),
    };
  }
}
