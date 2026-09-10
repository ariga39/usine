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
  createGithubApiClient,
  forgeGitEnvironment,
  ForgeAuthenticationError,
  type ForgeDeliveryOptions,
} from "./forge-policy.js";
import { externalReviewBlocksMerge, readGithubNativeReviews } from "./external-review.js";
import { readGithubPipelineEvidence } from "./github-read.js";

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

export class DeliveryQuarantineError extends Error {}

export class ExternalReviewPendingError extends Error {
  readonly code = "external_review_pending" as const;

  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = "ExternalReviewPendingError";
  }
}

export class PipelineChecksPendingError extends Error {
  readonly code = "pipeline_checks_pending" as const;

  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = "PipelineChecksPendingError";
  }
}

export class ForgeDeliveryReconciliationError extends Error {
  readonly code = "forge_delivery_reconciliation_required" as const;

  constructor() {
    super("forge delivery effect remains unresolved; explicit reconciliation is required");
    this.name = "ForgeDeliveryReconciliationError";
  }
}

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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.reconcile(contract, sha, check, review);
      } catch (error) {
        if (error instanceof DeliveryQuarantineError) throw error;
        if (error instanceof ForgeAuthenticationError) throw error;
        if (error instanceof ExternalReviewPendingError) throw error;
        if (error instanceof PipelineChecksPendingError) throw error;
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
    throw new ForgeDeliveryReconciliationError();
  }

  private async reconcile(
    contract: ResolvedTaskContract,
    sha: string,
    check: CheckResult,
    review: ReviewVerdict,
  ): Promise<DeliveryEffect> {
    const client = await createGithubApiClient(this.options.forge);
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
          contract,
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
          body: pullRequestBody(contract, sha, check, review),
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
    const delivered = deliveryEffect(pullRequest, sha, null, requireAttestationId(attestation));
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
        contract,
      );
      if (recovered) return recovered;
    }
    if (livePullRequest.state !== "open" || livePullRequest.head.sha !== sha)
      throw new DeliveryQuarantineError(
        `live delivery PR #${pullRequest.number} does not target the approved open head; merge blocked`,
      );
    await this.ensureAttestation(client, owner, repo, livePullRequest.number, marker, body);
    await this.enforceExternalReviewGate(client, owner, repo, livePullRequest.number, sha);
    await this.enforcePipelineGate(client, owner, repo, livePullRequest.number, sha);
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
        contract,
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
    if (!isExactSha(mergeCommitSha)) {
      const recovered = await this.probeMerged(
        client,
        owner,
        repo,
        livePullRequest.number,
        sha,
        marker,
        body,
        contract,
      );
      if (recovered) return recovered;
      throw new DeliveryQuarantineError(
        `GitHub accepted merge for PR #${livePullRequest.number} without a merge commit SHA; authoritative probe did not prove the merged effect`,
      );
    }
    await this.materializeMergeCommit(mergeCommitSha, client.token, contract);
    return deliveryEffect(
      livePullRequest,
      sha,
      {
        prNumber: livePullRequest.number,
        approvedHeadSha: sha,
        mergeCommitSha,
        observedState: "merged",
      },
      requireAttestationId(attestation),
    );
  }

  private async enforceExternalReviewGate(
    client: Awaited<ReturnType<typeof createGithubApiClient>>,
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): Promise<void> {
    const policy = this.options.externalReview;
    if (!policy?.requireApproval) return;
    const evidence = await readGithubNativeReviews(client, owner, repo, pullNumber, {
      timeout: remainingUntil(this.options.deadlineEpochMs),
      retries: 0,
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    });
    const blocker = externalReviewBlocksMerge(policy, evidence, headSha);
    if (blocker) throw new ExternalReviewPendingError(blocker);
  }

  private async enforcePipelineGate(
    client: Awaited<ReturnType<typeof createGithubApiClient>>,
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): Promise<void> {
    const pipeline = this.options.forge.pipeline;
    if (!pipeline || (pipeline.checkRuns.length === 0 && pipeline.statusContexts.length === 0))
      return;
    let evidence;
    try {
      evidence = await readGithubPipelineEvidence(
        client,
        { owner, name: repo },
        pullNumber,
        headSha,
        pipeline,
        {
          timeout: remainingUntil(this.options.deadlineEpochMs),
          retries: 0,
          signal: this.options.signal,
        },
      );
    } catch {
      throw new PipelineChecksPendingError(
        "allowlisted pipeline evidence is unavailable; grant the Forge App Checks and Commit statuses read permissions",
      );
    }
    if (!evidence.ready)
      throw new PipelineChecksPendingError(
        evidence.diagnostic ??
          "allowlisted pipeline checks have not all succeeded on the current head",
      );
  }

  private async probeMerged(
    client: Awaited<ReturnType<typeof createGithubApiClient>>,
    owner: string,
    repo: string,
    pullNumber: number,
    sha: string,
    marker: string,
    body: string,
    contract: ResolvedTaskContract,
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
    await this.materializeMergeCommit(merge.mergeCommitSha, client.token, contract);
    return deliveryEffect(authoritative, sha, merge, requireAttestationId(attestation));
  }

  private async materializeMergeCommit(
    mergeCommitSha: string,
    token: string,
    contract: ResolvedTaskContract,
  ): Promise<void> {
    if (!isExactSha(mergeCommitSha))
      throw new Error("merge effect must contain an exact commit SHA");
    const ref = `refs/usine/merge/${mergeCommitSha}`;
    const remoteBaseRef = `refs/heads/${contract.delivery.baseBranch}`;
    const environment = forgeGitEnvironment(
      this.options.environment,
      token,
      this.options.forge.gitUrl,
    );
    try {
      await execa(
        "git",
        [
          "-C",
          this.options.repository,
          "-c",
          "core.hooksPath=/dev/null",
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--force",
          this.options.forge.gitUrl,
          `+${remoteBaseRef}:${ref}`,
        ],
        {
          env: environment,
          extendEnv: false,
          timeout: remainingUntil(this.options.deadlineEpochMs),
          cancelSignal: this.options.signal,
        },
      );
    } catch (error) {
      throw new Error("merge commit materialization fetch failed", { cause: error });
    }
    const fetchedTip = (
      await execa("git", ["-C", this.options.repository, "rev-parse", `${ref}^{commit}`], {
        env: environment,
        extendEnv: false,
        timeout: remainingUntil(this.options.deadlineEpochMs),
        cancelSignal: this.options.signal,
      })
    ).stdout.trim();
    if (!isExactSha(fetchedTip))
      throw new Error("materialized merge ref did not resolve to a commit");
    await execa(
      "git",
      ["-C", this.options.repository, "merge-base", "--is-ancestor", mergeCommitSha, fetchedTip],
      {
        env: environment,
        extendEnv: false,
        timeout: remainingUntil(this.options.deadlineEpochMs),
        cancelSignal: this.options.signal,
      },
    );
    await execa(
      "git",
      ["-C", this.options.repository, "cat-file", "-e", `${mergeCommitSha}^{commit}`],
      {
        env: environment,
        extendEnv: false,
        timeout: remainingUntil(this.options.deadlineEpochMs),
        cancelSignal: this.options.signal,
      },
    );
  }

  private async ensureAttestation(
    client: Awaited<ReturnType<typeof createGithubApiClient>>,
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

function pullRequestBody(
  contract: ResolvedTaskContract,
  sha: string,
  check: CheckResult,
  review: ReviewVerdict,
): string {
  const evidence =
    contract.campaign === undefined
      ? contract.delivery.body
      : [
          contract.delivery.body,
          "",
          "Delivery evidence:",
          `- Candidate SHA: \`${sha}\``,
          `- Project check: \`${check.status}\``,
          `- Fresh independent review: \`${review.verdict}\``,
        ].join("\n");
  return contract.delivery.issue === undefined
    ? evidence
    : `${evidence}\n\nCloses #${contract.delivery.issue}`;
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

function requireAttestationId(attestation: { id?: unknown }): string {
  const id =
    typeof attestation.id === "string" || typeof attestation.id === "number"
      ? String(attestation.id)
      : "";
  if (id.length === 0) throw new DeliveryQuarantineError("approval attestation has no durable ID");
  return id;
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
