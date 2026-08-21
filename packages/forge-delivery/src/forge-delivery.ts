import { execa } from "execa";
import { Duration, Effect } from "effect";
import type {
  CheckResult,
  DeliveryEffect,
  MergeEffect,
  ReviewVerdict,
  ResolvedTaskContract,
} from "@usine/task-authority";
import { remainingUntil } from "@usine/task-authority";
import {
  approvalAttestationBody,
  createForgeClient,
  forgeGitEnvironment,
  type ForgeDeliveryOptions,
} from "./forge-policy.js";

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

export class DeliveryQuarantineError extends Error {}

export class ForgeDelivery {
  constructor(private readonly options: ForgeDeliveryOptions) {}

  async deliver(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect> {
    if (check.sha !== sha || check.status !== "passed")
      throw new Error("delivery requires a passed exact-SHA project check");
    if (review.sha !== sha || review.verdict !== "approved")
      throw new Error("delivery requires exact-SHA semantic approval");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.reconcile(contract, sha, check, review);
      } catch (error) {
        lastError = error;
        if (error instanceof DeliveryQuarantineError) throw error;
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
          await Effect.runPromise(
            Effect.sleep(Duration.millis(remainingUntil(this.options.deadlineEpochMs, 100))),
            { signal: this.options.signal },
          );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async reconcile(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect> {
    const client = await createForgeClient(this.options);
    const { owner, name: repo } = contract.repository;
    const { branch, baseBranch } = contract.delivery;
    const body = approvalAttestationBody(contract, sha, check, review);
    const marker = `<!-- usine-approval:${contract.id}:${sha} -->`;
    let observedHead: string | null = null;
    try {
      observedHead = (
        await client.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          request: {
            timeout: remainingUntil(this.options.deadlineEpochMs),
            retries: 0,
            signal: this.options.signal,
          },
        })
      ).data.object.sha;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    const pullRequests = await client.octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      base: baseBranch,
      state: "all",
      per_page: 100,
      request: {
        timeout: remainingUntil(this.options.deadlineEpochMs),
        retries: 0,
        signal: this.options.signal,
      },
    });
    const matching = pullRequests.data.filter((pr) => pr.head.sha === sha);
    if (matching.length > 1)
      throw new DeliveryQuarantineError(
        `multiple delivery PRs target candidate ${sha}; delivery quarantined`,
      );
    const existing = matching[0] as LivePullRequest | undefined;
    if (existing && existing.state !== "open") {
      if (mergedEffect(existing, sha)) {
        if (contract.authorization.merge !== true)
          throw new DeliveryQuarantineError(
            `merged delivery PR #${existing.number} was observed without explicit merge authority; delivery quarantined`,
          );
        const recovered = await this.probeMerged(
          client,
          owner,
          repo,
          existing.number,
          sha,
          marker,
          body,
        );
        if (recovered) return recovered;
      }
      throw new DeliveryQuarantineError(
        `closed delivery PR #${existing.number} already targets candidate ${sha}; delivery quarantined`,
      );
    }
    if (!existing && pullRequests.data.length > 0)
      throw new DeliveryQuarantineError(
        `open delivery PR #${pullRequests.data[0]?.number ?? "unknown"} has a conflicting head; delivery quarantined`,
      );
    if (observedHead !== null && observedHead !== sha)
      throw new DeliveryQuarantineError(
        `delivery branch ${branch} has conflicting head ${observedHead}; delivery quarantined`,
      );
    if (observedHead === null) {
      const gitUrl = this.options.forge.gitUrl;
      const env = forgeGitEnvironment(this.options.environment, client.token, gitUrl);
      await execa(
        "git",
        [
          "-C",
          this.options.repository,
          "-c",
          "core.hooksPath=/dev/null",
          "push",
          `--force-with-lease=refs/heads/${branch}:${observedHead ?? ""}`,
          gitUrl,
          `${sha}:refs/heads/${branch}`,
        ],
        {
          env,
          extendEnv: false,
          timeout: remainingUntil(this.options.deadlineEpochMs),
          cancelSignal: this.options.signal,
        },
      );
    }
    const pullRequest = (existing ??
      (
        await client.octokit.rest.pulls.create({
          owner,
          repo,
          head: branch,
          base: baseBranch,
          title: contract.delivery.title,
          body: `${contract.delivery.body}\n\nCloses #${contract.delivery.issue}`,
          draft: false,
          request: {
            timeout: remainingUntil(this.options.deadlineEpochMs),
            retries: 0,
            signal: this.options.signal,
          },
        })
      ).data) as LivePullRequest;
    if (pullRequest.state !== "open" || pullRequest.head.sha !== sha)
      throw new DeliveryQuarantineError(
        `delivery PR #${pullRequest.number} does not target the approved open head; delivery quarantined`,
      );
    const attestation = await this.ensureAttestation(
      client,
      owner,
      repo,
      pullRequest.number,
      marker,
      body,
    );
    const delivered = deliveryEffect(pullRequest, sha, null, String(attestation.id));
    if (contract.authorization.merge !== true) return delivered;

    const livePullRequest = (
      await client.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullRequest.number,
        request: {
          timeout: remainingUntil(this.options.deadlineEpochMs),
          retries: 0,
          signal: this.options.signal,
        },
      })
    ).data as LivePullRequest;
    const alreadyMerged = mergedEffect(livePullRequest, sha);
    if (alreadyMerged) {
      const recovered = await this.probeMerged(
        client,
        owner,
        repo,
        livePullRequest.number,
        sha,
        marker,
        body,
      );
      if (recovered) return recovered;
    }
    if (livePullRequest.state !== "open" || livePullRequest.head.sha !== sha)
      throw new DeliveryQuarantineError(
        `live delivery PR #${pullRequest.number} does not target the approved open head; merge blocked`,
      );
    await this.ensureAttestation(client, owner, repo, livePullRequest.number, marker, body);
    let mergeResponse: Awaited<ReturnType<typeof client.octokit.rest.pulls.merge>>;
    try {
      mergeResponse = await client.octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: livePullRequest.number,
        sha,
        request: {
          timeout: remainingUntil(this.options.deadlineEpochMs),
          retries: 0,
          signal: this.options.signal,
        },
      });
    } catch (error) {
      const recovered = await this.probeMerged(
        client,
        owner,
        repo,
        livePullRequest.number,
        sha,
        marker,
        body,
      );
      if (recovered) return recovered;
      if (isMergeRefusal(error))
        throw new DeliveryQuarantineError(
          `GitHub refused merge for PR #${livePullRequest.number} after live probe (mergeable=${String(livePullRequest.mergeable)}, mergeable_state=${livePullRequest.mergeable_state ?? "unknown"}); platform policy blocked merge`,
        );
      throw error;
    }
    if (!mergeResponse.data.merged)
      throw new DeliveryQuarantineError(
        `GitHub refused merge for PR #${livePullRequest.number}: ${mergeResponse.data.message ?? "platform policy rejected merge"} (mergeable=${String(livePullRequest.mergeable)}, mergeable_state=${livePullRequest.mergeable_state ?? "unknown"})`,
      );
    const mergeCommitSha = mergeResponse.data.sha;
    if (!isExactSha(mergeCommitSha))
      throw new DeliveryQuarantineError(
        `GitHub accepted merge for PR #${livePullRequest.number} without a merge commit SHA`,
      );
    return deliveryEffect(
      livePullRequest,
      sha,
      {
        prNumber: livePullRequest.number,
        approvedHeadSha: sha,
        mergeCommitSha,
        observedState: "merged",
      },
      String(attestation.id),
    );
  }

  private async probeMerged(
    client: Awaited<ReturnType<typeof createForgeClient>>,
    owner: string,
    repo: string,
    pullNumber: number,
    sha: string,
    marker: string,
    body: string,
  ): Promise<DeliveryEffect | null> {
    const authoritative = (
      await client.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        request: {
          timeout: remainingUntil(this.options.deadlineEpochMs),
          retries: 0,
          signal: this.options.signal,
        },
      })
    ).data as LivePullRequest;
    const merge = mergedEffect(authoritative, sha);
    if (!merge) return null;
    const attestation = await this.ensureAttestation(client, owner, repo, pullNumber, marker, body);
    return deliveryEffect(authoritative, sha, merge, String(attestation.id));
  }

  private async ensureAttestation(
    client: Awaited<ReturnType<typeof createForgeClient>>,
    owner: string,
    repo: string,
    pullNumber: number,
    marker: string,
    body: string,
  ) {
    const comments = await client.octokit.paginate(client.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      request: {
        timeout: remainingUntil(this.options.deadlineEpochMs),
        retries: 0,
        signal: this.options.signal,
      },
    });
    const marked = comments.filter((comment) => comment.body?.includes(marker));
    if (marked.length > 1)
      throw new DeliveryQuarantineError(
        `multiple approval attestations exist for candidate ${marker}; delivery quarantined`,
      );
    const existingAttestation = marked[0];
    let attestation = existingAttestation;
    if (existingAttestation) {
      const app = (
        existingAttestation as typeof existingAttestation & {
          performed_via_github_app?: { slug?: string };
        }
      ).performed_via_github_app;
      if (
        existingAttestation.body !== body ||
        app?.slug !== client.appSlug ||
        existingAttestation.user?.type !== "Bot"
      )
        throw new DeliveryQuarantineError(
          `approval attestation identity does not match delivery App/Bot; delivery quarantined`,
        );
    } else {
      attestation = (
        await client.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body,
          request: {
            timeout: remainingUntil(this.options.deadlineEpochMs),
            retries: 0,
            signal: this.options.signal,
          },
        })
      ).data;
      const app = (
        attestation as typeof attestation & { performed_via_github_app?: { slug?: string } }
      ).performed_via_github_app;
      if (
        attestation.body !== body ||
        app?.slug !== client.appSlug ||
        attestation.user?.type !== "Bot"
      )
        throw new DeliveryQuarantineError(
          `created approval attestation identity does not match delivery App/Bot; delivery quarantined`,
        );
    }
    if (!attestation) throw new DeliveryQuarantineError("approval attestation was not observed");
    return attestation;
  }
}

type LivePullRequest = {
  number: number;
  state: "open" | "closed";
  head: { sha: string };
  html_url: string;
  merged?: boolean | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
};

function isExactSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isMergeRefusal(error: unknown): boolean {
  const status = statusOf(error);
  return status === 405 || status === 409 || status === 422;
}

function mergedEffect(pullRequest: LivePullRequest, sha: string): MergeEffect | null {
  if (
    pullRequest.head.sha !== sha ||
    (pullRequest.merged !== true && pullRequest.merged_at == null) ||
    !isExactSha(pullRequest.merge_commit_sha)
  )
    return null;
  return {
    prNumber: pullRequest.number,
    approvedHeadSha: sha,
    mergeCommitSha: pullRequest.merge_commit_sha,
    observedState: "merged",
  };
}

function deliveryEffect(
  pullRequest: LivePullRequest,
  sha: string,
  merge: MergeEffect | null,
  attestationId: string,
): DeliveryEffect {
  return {
    sha,
    effect: "github",
    prNumber: pullRequest.number,
    url: pullRequest.html_url,
    attestationId,
    merge,
  };
}
