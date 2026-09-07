import type { ExternalReviewPolicy, ForgeClient } from "./forge-policy.js";

export type GithubReviewIdentity =
  | { readonly kind: "user"; readonly id: number; readonly login: string }
  | { readonly kind: "app"; readonly id: number; readonly slug: string };

export interface GithubReviewProjection {
  readonly id: number;
  readonly state: string;
  readonly commitSha: string;
  readonly body: string;
  readonly identity: GithubReviewIdentity | null;
  readonly createdAt: string | null;
  readonly submittedAt: string | null;
  readonly updatedAt: string | null;
}

export interface GithubCommentProjection {
  readonly id: number;
  readonly body: string;
  readonly identity: GithubReviewIdentity | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly pullRequestReviewId?: number | null;
}

export interface GithubReviewEvidence {
  readonly reviews: readonly GithubReviewProjection[];
  readonly comments: readonly GithubCommentProjection[];
  readonly reviewComments: readonly GithubCommentProjection[];
  readonly reviewsTruncated: boolean;
}

export interface GithubNativeReviewEvidence {
  readonly reviews: readonly GithubReviewProjection[];
  readonly reviewsTruncated: boolean;
}

const MAX_TEXT = 8_192;
const MAX_ITEMS = 50;

export function reviewIdentity(input: {
  readonly user?: unknown;
  readonly userType?: unknown;
  readonly performedViaGithubApp?: unknown;
}): GithubReviewIdentity | null {
  const app = input.performedViaGithubApp;
  const appId = positiveInteger(field(app, "id"));
  if (app !== undefined && app !== null && appId === null) return null;
  if (appId !== null)
    return {
      kind: "app",
      id: appId,
      slug: boundedString(field(app, "slug")),
    };

  const user = input.user;
  const userType = input.userType ?? field(user, "type");
  if (userType !== "User") return null;
  const userId = positiveInteger(field(user, "id"));
  if (userId !== null)
    return {
      kind: "user",
      id: userId,
      login: boundedString(field(user, "login")),
    };
  return null;
}

export async function readGithubReviewEvidence(
  client: ForgeClient,
  owner: string,
  repo: string,
  pullNumber: number,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
): Promise<GithubReviewEvidence> {
  const resolveIdentity = createReviewIdentityResolver(client, request);
  const nativeReviews = await readGithubNativeReviews(
    client,
    owner,
    repo,
    pullNumber,
    request,
    resolveIdentity,
  );
  const [comments, reviewComments] = await Promise.all([
    readGithubReviewComments(client, owner, repo, pullNumber, request, resolveIdentity),
    readGithubPullRequestReviewComments(client, owner, repo, pullNumber, request, resolveIdentity),
  ]);
  return { ...nativeReviews, comments, reviewComments };
}

export async function readGithubNativeReviews(
  client: ForgeClient,
  owner: string,
  repo: string,
  pullNumber: number,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
  resolveIdentity = createReviewIdentityResolver(client, request),
): Promise<GithubNativeReviewEvidence> {
  const reviewsResponse = await client.octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: MAX_ITEMS + 1,
    request,
  });
  const reviewsTruncated = reviewsResponse.data.length > MAX_ITEMS;
  const reviews = await Promise.all(
    reviewsResponse.data.slice(0, MAX_ITEMS).map(async (review) => {
      return {
        id: numberOrZero(field(review, "id")),
        state: boundedString(field(review, "state")),
        commitSha: boundedString(field(review, "commit_id")),
        body: boundedString(field(review, "body")),
        identity: await resolveIdentity({
          user: field(review, "user"),
          userType: field(field(review, "user"), "type"),
          performedViaGithubApp: field(review, "performed_via_github_app"),
        }),
        createdAt: nullableBoundedString(field(review, "created_at")),
        submittedAt: nullableBoundedString(field(review, "submitted_at")),
        updatedAt: nullableBoundedString(field(review, "updated_at")),
      } satisfies GithubReviewProjection;
    }),
  );
  return { reviews, reviewsTruncated };
}

export async function readGithubReviewComments(
  client: ForgeClient,
  owner: string,
  repo: string,
  pullNumber: number,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
  resolveIdentity = createReviewIdentityResolver(client, request),
): Promise<readonly GithubCommentProjection[]> {
  const commentsResponse = await client.octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: MAX_ITEMS,
    request,
  });
  return Promise.all(
    commentsResponse.data.slice(0, MAX_ITEMS).map(async (comment) => {
      return {
        id: numberOrZero(field(comment, "id")),
        body: boundedString(field(comment, "body")),
        identity: await resolveIdentity({
          user: field(comment, "user"),
          userType: field(field(comment, "user"), "type"),
          performedViaGithubApp: field(comment, "performed_via_github_app"),
        }),
        createdAt: nullableBoundedString(field(comment, "created_at")),
        updatedAt: nullableBoundedString(field(comment, "updated_at")),
        pullRequestReviewId: nullableNumber(field(comment, "pull_request_review_id")),
      } satisfies GithubCommentProjection;
    }),
  );
}

export async function readGithubPullRequestReviewComments(
  client: ForgeClient,
  owner: string,
  repo: string,
  pullNumber: number,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
  resolveIdentity = createReviewIdentityResolver(client, request),
): Promise<readonly GithubCommentProjection[]> {
  const commentsResponse = await client.octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: MAX_ITEMS,
    request,
  });
  return Promise.all(
    commentsResponse.data.slice(0, MAX_ITEMS).map(async (comment) => {
      return {
        id: numberOrZero(field(comment, "id")),
        body: boundedString(field(comment, "body")),
        identity: await resolveIdentity({
          user: field(comment, "user"),
          userType: field(field(comment, "user"), "type"),
          performedViaGithubApp: field(comment, "performed_via_github_app"),
        }),
        createdAt: nullableBoundedString(field(comment, "created_at")),
        updatedAt: nullableBoundedString(field(comment, "updated_at")),
        path: nullableBoundedString(field(comment, "path")),
        line: nullableLine(field(comment, "line")),
        pullRequestReviewId: nullableNumber(field(comment, "pull_request_review_id")),
      } satisfies GithubCommentProjection;
    }),
  );
}

type ReviewIdentityInput = Parameters<typeof reviewIdentity>[0];
type ReviewIdentityResolver = (input: ReviewIdentityInput) => Promise<GithubReviewIdentity | null>;

function createReviewIdentityResolver(
  client: ForgeClient,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
): ReviewIdentityResolver {
  const appBySlug = new Map<string, Promise<GithubReviewIdentity | null>>();
  return async (input) => {
    const directIdentity = reviewIdentity(input);
    const performedViaGithubApp = input.performedViaGithubApp;
    if (performedViaGithubApp !== undefined && performedViaGithubApp !== null)
      return directIdentity;

    if (input.userType !== "Bot") return directIdentity;
    const login = boundedString(field(input.user, "login"));
    const slug = botAppSlug(login);
    if (slug === null) return null;
    const existing = appBySlug.get(slug);
    if (existing !== undefined) return existing;
    const verification = verifyBotApp(client, slug, request);
    appBySlug.set(slug, verification);
    return verification;
  };
}

async function verifyBotApp(
  client: ForgeClient,
  slug: string,
  request: { timeout: number; retries: 0; signal?: AbortSignal },
): Promise<GithubReviewIdentity | null> {
  try {
    const response = await client.octokit.rest.apps.getBySlug({ app_slug: slug, request });
    const id = positiveInteger(field(response.data, "id"));
    const returnedSlug = boundedString(field(response.data, "slug"));
    if (id === null || returnedSlug !== slug) return null;
    return { kind: "app", id, slug: returnedSlug };
  } catch {
    return null;
  }
}

function botAppSlug(login: string): string | null {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\[bot\]$/.exec(login);
  return match?.[1] ?? null;
}

export function externalReviewBlocksMerge(
  policy: ExternalReviewPolicy,
  evidence: GithubNativeReviewEvidence,
  headSha: string,
): string | null {
  if (!policy.requireApproval) return null;
  if (evidence.reviewsTruncated)
    return "native external review evidence was truncated; merge blocked";
  const trustedUsers = new Set(policy.trustedUsers);
  const trustedApps = new Set(policy.trustedApps);
  const latest = new Map<string, { review: GithubReviewProjection; index: number }>();
  evidence.reviews.forEach((review, index) => {
    if (review.commitSha !== headSha) return;
    const trusted =
      (review.identity?.kind === "user" && trustedUsers.has(review.identity.id)) ||
      (review.identity?.kind === "app" && trustedApps.has(review.identity.id));
    if (!trusted || (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED")) return;
    const key = `${review.identity?.kind}:${review.identity?.id}`;
    const previous = latest.get(key);
    if (previous === undefined || isLaterReview(review, index, previous.review, previous.index))
      latest.set(key, { review, index });
  });
  const decisive = [...latest.values()].map(({ review }) => review);
  if (decisive.some((review) => review.state === "CHANGES_REQUESTED"))
    return "trusted external review requested changes on the current Pull Request head";
  if (!decisive.some((review) => review.state === "APPROVED"))
    return "trusted external approval was not observed on the current Pull Request head";
  return null;
}

function isLaterReview(
  review: GithubReviewProjection,
  index: number,
  previous: GithubReviewProjection,
  previousIndex: number,
): boolean {
  const timestamp = review.submittedAt ?? review.createdAt;
  const previousTimestamp = previous.submittedAt ?? previous.createdAt;
  if (timestamp !== null && previousTimestamp !== null) {
    const currentTime = Date.parse(timestamp);
    const previousTime = Date.parse(previousTimestamp);
    if (
      Number.isFinite(currentTime) &&
      Number.isFinite(previousTime) &&
      currentTime !== previousTime
    )
      return currentTime > previousTime;
  }
  return index > previousIndex;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function numberOrZero(value: unknown): number {
  return positiveInteger(value) ?? 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : positiveInteger(value);
}

function nullableLine(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : null;
}

function boundedString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

function nullableBoundedString(value: unknown): string | null {
  return value === null || value === undefined ? null : boundedString(value);
}
