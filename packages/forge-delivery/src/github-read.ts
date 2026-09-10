import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { remainingUntil } from "@usine/task-authority";
import { Duration, Effect } from "effect";
import type { GithubApiPolicy, ForgeClient, GithubPipelineAllowlist } from "./forge-policy.js";
import { createGithubApiClient } from "./forge-policy.js";
import { readGithubReviewEvidence } from "./external-review.js";
import { z } from "zod";

const exactSha = /^[0-9a-f]{40}$/;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const MAX_TEXT = 8_192;
const MAX_ITEMS = 50;
const MAX_FILES = 50;

export const githubReadToolNames = [
  "github_issue_get",
  "github_issue_comments",
  "github_pull_request_get",
  "github_pull_request_reviews",
  "github_pull_request_checks",
  "github_file_get",
  "github_commit_get",
] as const;

export type GithubReadToolName = (typeof githubReadToolNames)[number];
export type GithubReadRole = "implementer" | "reviewer";

export interface GithubPipelineEvidence {
  readonly sha: string;
  readonly ready: boolean;
  readonly checkRuns: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly source: string | null;
  }[];
  readonly statusContexts: readonly {
    readonly context: string;
    readonly state: string;
  }[];
  readonly diagnostic?: string;
}

export interface GithubReadMcpOptions {
  repository: { owner: string; name: string };
  issueNumber: number;
  pullRequestNumber?: number;
  role: GithubReadRole;
  tools: readonly GithubReadToolName[];
  policy: GithubApiPolicy;
  fetch?: typeof fetch;
  deadlineEpochMs: number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

type ReadArguments = {
  owner: string;
  repository: string;
};

type IssueArguments = ReadArguments & { issue: number };
type PullRequestArguments = ReadArguments & { pullRequest: number };
type FileArguments = ReadArguments & { commitSha: string; path: string };
type CommitArguments = ReadArguments & { commitSha: string };

export function createGithubReadMcpServer(options: GithubReadMcpOptions): McpServer {
  const clientPromise = createGithubApiClient(options.policy, options.fetch);
  const server = new McpServer(
    { name: `usine-github-read-${options.role}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const enabled = new Set(options.tools);
  const register = (name: GithubReadToolName, registerTool: () => void): void => {
    if (enabled.has(name)) registerTool();
  };
  const requestShape = {
    owner: z.string(),
    repository: z.string(),
  };

  register("github_issue_get", () =>
    server.registerTool(
      "github_issue_get",
      {
        description: "Read the task's authorized GitHub Issue.",
        inputSchema: { ...requestShape, issue: z.number().int() },
      },
      async (input: IssueArguments) => callSafely(() => readIssue(clientPromise, options, input)),
    ),
  );
  register("github_issue_comments", () =>
    server.registerTool(
      "github_issue_comments",
      {
        description: "Read bounded comments on the task's authorized GitHub Issue.",
        inputSchema: { ...requestShape, issue: z.number().int() },
      },
      async (input: IssueArguments) =>
        callSafely(() => readIssueComments(clientPromise, options, input)),
    ),
  );
  register("github_pull_request_get", () =>
    server.registerTool(
      "github_pull_request_get",
      {
        description: "Read the authorized GitHub Pull Request metadata.",
        inputSchema: { ...requestShape, pullRequest: z.number().int() },
      },
      async (input: PullRequestArguments) =>
        callSafely(() => readPullRequest(clientPromise, options, input)),
    ),
  );
  register("github_pull_request_reviews", () =>
    server.registerTool(
      "github_pull_request_reviews",
      {
        description:
          "Read bounded review decisions and resolved review threads on the authorized Pull Request.",
        inputSchema: { ...requestShape, pullRequest: z.number().int() },
      },
      async (input: PullRequestArguments) =>
        callSafely(() => readPullRequestReviews(clientPromise, options, input)),
    ),
  );
  register("github_pull_request_checks", () =>
    server.registerTool(
      "github_pull_request_checks",
      {
        description: "Read checks for the exact head of the authorized GitHub Pull Request.",
        inputSchema: { ...requestShape, pullRequest: z.number().int() },
      },
      async (input: PullRequestArguments) =>
        callSafely(() => readPullRequestChecks(clientPromise, options, input)),
    ),
  );
  register("github_file_get", () =>
    server.registerTool(
      "github_file_get",
      {
        description: "Read one exact file at one exact commit SHA.",
        inputSchema: { ...requestShape, commitSha: z.string(), path: z.string() },
      },
      async (input: FileArguments) => callSafely(() => readFile(clientPromise, options, input)),
    ),
  );
  register("github_commit_get", () =>
    server.registerTool(
      "github_commit_get",
      {
        description: "Read one exact Git commit and bounded changed-file metadata.",
        inputSchema: { ...requestShape, commitSha: z.string() },
      },
      async (input: CommitArguments) => callSafely(() => readCommit(clientPromise, options, input)),
    ),
  );
  return server;
}

async function callSafely<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch {
    return {
      isError: true,
      content: [
        { type: "text" as const, text: "GitHub read unavailable or outside the authorized scope" },
      ],
    };
  }
}

async function readIssue(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: IssueArguments,
) {
  assertIssue(options, input);
  const client = await clientPromise;
  const issue = await withRequestOptions(options, (request) =>
    client.octokit.rest.issues.get({
      owner: input.owner,
      repo: input.repository,
      issue_number: input.issue,
      request,
    }),
  );
  return project("issue", options, {
    number: issue.data.number,
    title: bounded(issue.data.title),
    body: bounded(issue.data.body),
    state: issue.data.state,
    url: bounded(issue.data.html_url),
  });
}

async function readIssueComments(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: IssueArguments,
) {
  assertIssue(options, input);
  const client = await clientPromise;
  const comments = (
    await withRequestOptions(options, (request) =>
      client.octokit.rest.issues.listComments({
        owner: input.owner,
        repo: input.repository,
        issue_number: input.issue,
        per_page: MAX_ITEMS,
        request,
      }),
    )
  ).data;
  return project("issue_comments", options, {
    issue: input.issue,
    comments: comments.slice(0, MAX_ITEMS).map((comment) => ({
      id: comment.id,
      body: bounded(comment.body),
      author: bounded(comment.user?.login),
    })),
  });
}

async function readPullRequest(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: PullRequestArguments,
) {
  assertPullRequest(options, input);
  const client = await clientPromise;
  const pullRequest = await withRequestOptions(options, (request) =>
    client.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repository,
      pull_number: input.pullRequest,
      request,
    }),
  );
  return project("pull_request", options, {
    number: pullRequest.data.number,
    title: bounded(pullRequest.data.title),
    body: bounded(pullRequest.data.body),
    state: pullRequest.data.state,
    url: bounded(pullRequest.data.html_url),
    head: { sha: pullRequest.data.head.sha, ref: bounded(pullRequest.data.head.ref) },
    base: { sha: pullRequest.data.base.sha, ref: bounded(pullRequest.data.base.ref) },
  });
}

async function readPullRequestReviews(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: PullRequestArguments,
) {
  assertPullRequest(options, input);
  const client = await clientPromise;
  const pullRequest = await withRequestOptions(options, (request) =>
    client.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repository,
      pull_number: input.pullRequest,
      request,
    }),
  );
  const evidence = await withRequestOptions(options, (request) =>
    readGithubReviewEvidence(client, input.owner, input.repository, input.pullRequest, request),
  );
  const threads = await withRequestOptions(options, (request) =>
    client.octokit.graphql<ReviewThreadsResponse>(
      `
      query($owner: String!, $repo: String!, $pullRequest: Int!, $threadLimit: Int!, $commentLimit: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullRequest) {
            reviewThreads(first: $threadLimit) {
              nodes {
                id
                isResolved
                comments(first: $commentLimit) {
                  nodes {
                    databaseId
                    body
                    path
                    line
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }
      `,
      {
        owner: input.owner,
        repo: input.repository,
        pullRequest: input.pullRequest,
        threadLimit: MAX_ITEMS,
        commentLimit: MAX_ITEMS,
        request,
      },
    ),
  );
  const threadPullRequest = threads.repository?.pullRequest;
  if (!threadPullRequest) throw new Error("authorized Pull Request was not returned by GraphQL");
  const reviewThreads = threadPullRequest.reviewThreads.nodes.filter(
    (thread): thread is NonNullable<typeof thread> => thread !== null,
  );
  const reviewComments = new Map(evidence.reviewComments.map((comment) => [comment.id, comment]));
  return project("pull_request_reviews", options, {
    pullRequest: input.pullRequest,
    pullRequestHeadSha: pullRequest.data.head.sha,
    reviewsTruncated: evidence.reviewsTruncated,
    reviews: evidence.reviews.map((review) => ({
      id: review.id,
      state: review.state,
      body: review.body,
      author: review.identity?.kind === "user" ? review.identity.login : "",
      identity: review.identity,
      commitSha: review.commitSha,
      createdAt: review.createdAt,
      submittedAt: review.submittedAt,
      updatedAt: review.updatedAt,
      exactHead: review.commitSha === pullRequest.data.head.sha,
    })),
    comments: evidence.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.identity?.kind === "user" ? comment.identity.login : "",
      identity: comment.identity,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      pullRequestReviewId: comment.pullRequestReviewId,
    })),
    reviewThreads: reviewThreads.slice(0, MAX_ITEMS).map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      comments: thread.comments.nodes
        .filter((comment): comment is NonNullable<typeof comment> => comment !== null)
        .slice(0, MAX_ITEMS)
        .map((comment) => {
          const restComment = reviewComments.get(comment.databaseId);
          const identity = restComment?.identity ?? null;
          return {
            id: comment.databaseId,
            body: bounded(comment.body),
            author: identity?.kind === "user" ? identity.login : "",
            identity,
            path: bounded(restComment?.path ?? comment.path),
            line: restComment?.line ?? comment.line ?? null,
            createdAt: restComment?.createdAt ?? comment.createdAt,
            updatedAt: restComment?.updatedAt ?? comment.updatedAt,
            pullRequestReviewId: restComment?.pullRequestReviewId ?? null,
          };
        }),
    })),
  });
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: {
            nodes: Array<{
              databaseId: number;
              body: string;
              path: string | null;
              line: number | null;
              createdAt: string;
              updatedAt: string;
            } | null>;
          };
        } | null>;
      };
    } | null;
  } | null;
}

async function readPullRequestChecks(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: PullRequestArguments,
) {
  assertPullRequest(options, input);
  const client = await clientPromise;
  const pullRequest = await withRequestOptions(options, (request) =>
    client.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repository,
      pull_number: input.pullRequest,
      request,
    }),
  );
  const checks = await withRequestOptions(options, (request) =>
    client.octokit.rest.checks.listForRef({
      owner: input.owner,
      repo: input.repository,
      ref: pullRequest.data.head.sha,
      per_page: MAX_ITEMS,
      request,
    }),
  );
  return project("pull_request_checks", options, {
    pullRequest: input.pullRequest,
    commitSha: pullRequest.data.head.sha,
    checks: checks.data.check_runs.slice(0, MAX_ITEMS).map((check) => ({
      id: check.id,
      name: bounded(check.name),
      status: check.status,
      conclusion: check.conclusion,
    })),
  });
}

/**
 * Observe the configured pipeline entries for one live Pull Request head.
 * This is the only boundary that interprets GitHub check-run and status
 * payloads for the merge gate.
 */
export async function readGithubPipelineEvidence(
  client: ForgeClient,
  repository: { readonly owner: string; readonly name: string },
  pullNumber: number,
  expectedSha: string,
  allowlist: GithubPipelineAllowlist,
  request?: { readonly timeout: number; readonly retries: 0; readonly signal?: AbortSignal },
): Promise<GithubPipelineEvidence> {
  const pullRequest = await client.octokit.rest.pulls.get({
    owner: repository.owner,
    repo: repository.name,
    pull_number: pullNumber,
    ...(request ? { request } : {}),
  });
  const liveSha = pullRequest.data.head.sha;
  if (liveSha !== expectedSha) {
    return {
      sha: liveSha,
      ready: false,
      checkRuns: [],
      statusContexts: [],
      diagnostic: `pipeline evidence is stale: Pull Request head is ${liveSha}`,
    };
  }

  let checkRunsResponse;
  let statusesResponse;
  try {
    [checkRunsResponse, statusesResponse] = await Promise.all([
      allowlist.checkRuns.length === 0
        ? undefined
        : client.octokit.rest.checks.listForRef({
            owner: repository.owner,
            repo: repository.name,
            ref: expectedSha,
            per_page: MAX_ITEMS,
            ...(request ? { request } : {}),
          }),
      allowlist.statusContexts.length === 0
        ? undefined
        : client.octokit.rest.repos.getCombinedStatusForRef({
            owner: repository.owner,
            repo: repository.name,
            ref: expectedSha,
            per_page: MAX_ITEMS,
            ...(request ? { request } : {}),
          }),
    ]);
  } catch {
    return {
      sha: expectedSha,
      ready: false,
      checkRuns: [],
      statusContexts: [],
      diagnostic: pipelineEvidenceUnavailableDiagnostic(allowlist),
    };
  }
  const checkRuns = allowlist.checkRuns.map((name) => {
    const matching =
      checkRunsResponse?.data.check_runs.filter((check) => check.name === name) ?? [];
    return latestBy(matching, (check) => check.id);
  });
  const statuses = allowlist.statusContexts.map((context) => {
    const matching =
      statusesResponse?.data.statuses.filter((status) => status.context === context) ?? [];
    return latestBy(matching, (status) => status.id);
  });
  const checkSources = allowlist.checkRuns.map((name) => {
    const sources = new Set(
      (checkRunsResponse?.data.check_runs ?? [])
        .filter((check) => check.name === name)
        .map((check) => check.app?.id ?? check.app?.slug ?? check.app?.name ?? null),
    );
    return { name, ambiguous: sources.size > 1 };
  });
  const truncated =
    (checkRunsResponse?.data.total_count ?? 0) > MAX_ITEMS ||
    (statusesResponse?.data.total_count ?? 0) > MAX_ITEMS;
  const checkEvidence = checkRuns.flatMap((check, index) =>
    check === undefined
      ? []
      : [
          {
            name: allowlist.checkRuns[index]!,
            status: check.status,
            conclusion: check.conclusion,
            source: check.app?.slug ?? check.app?.name ?? null,
          },
        ],
  );
  const statusEvidence = statuses.flatMap((status, index) =>
    status === undefined
      ? []
      : [{ context: allowlist.statusContexts[index]!, state: status.state }],
  );
  const failures = [
    ...(truncated ? ["pipeline evidence was truncated"] : []),
    ...allowlist.checkRuns.flatMap((name, index) => {
      const check = checkRuns[index];
      const source = checkSources[index];
      return source?.ambiguous
        ? [`check run '${name}' has ambiguous sources`]
        : check?.status === "completed" && check.conclusion === "success"
          ? []
          : [
              `check run '${name}' is ${check ? `${check.status}/${check.conclusion ?? "no conclusion"}` : "missing"}`,
            ];
    }),
    ...allowlist.statusContexts.flatMap((context, index) => {
      const status = statuses[index];
      return status?.state === "success"
        ? []
        : [`status context '${context}' is ${status?.state ?? "missing"}`];
    }),
  ];
  return {
    sha: expectedSha,
    ready: failures.length === 0,
    checkRuns: checkEvidence,
    statusContexts: statusEvidence,
    ...(failures.length > 0 ? { diagnostic: failures.join("; ").slice(0, 512) } : {}),
  };
}

function latestBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (latest, item) => (latest === undefined || key(item) > key(latest) ? item : latest),
    undefined,
  );
}

function pipelineEvidenceUnavailableDiagnostic(allowlist: GithubPipelineAllowlist): string {
  const permissions = [
    ...(allowlist.checkRuns.length > 0 ? ["Checks"] : []),
    ...(allowlist.statusContexts.length > 0 ? ["Commit statuses"] : []),
  ];
  return `allowlisted pipeline evidence is unavailable; grant the Forge App ${permissions.join(" and ")} read permission${permissions.length === 1 ? "" : "s"}`;
}

async function readFile(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: FileArguments,
) {
  assertRepository(options, input);
  assertExactFile(input.commitSha, input.path);
  const client = await clientPromise;
  const response = await withRequestOptions(options, (request) =>
    client.octokit.rest.repos.getContent({
      owner: input.owner,
      repo: input.repository,
      path: input.path,
      ref: input.commitSha,
      request,
    }),
  );
  if (Array.isArray(response.data) || response.data.type !== "file")
    throw new Error("exact file read did not return one file");
  const content =
    response.data.encoding === "base64"
      ? Buffer.from(response.data.content.replaceAll("\n", ""), "base64").toString("utf8")
      : response.data.content;
  return project("file", options, {
    commitSha: input.commitSha,
    path: input.path,
    content: bounded(content),
    sha: response.data.sha,
  });
}

async function readCommit(
  clientPromise: Promise<ForgeClient>,
  options: GithubReadMcpOptions,
  input: CommitArguments,
) {
  assertRepository(options, input);
  if (!exactSha.test(input.commitSha)) throw new Error("commit reads require an exact commit SHA");
  const client = await clientPromise;
  const commit = await withRequestOptions(options, (request) =>
    client.octokit.rest.repos.getCommit({
      owner: input.owner,
      repo: input.repository,
      ref: input.commitSha,
      request,
    }),
  );
  return project("commit", options, {
    commitSha: commit.data.sha,
    message: bounded(commit.data.commit.message),
    files: (commit.data.files ?? []).slice(0, MAX_FILES).map((file) => ({
      filename: bounded(file.filename),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
  });
}

function assertRepository(options: GithubReadMcpOptions, input: ReadArguments): void {
  if (
    input.owner.toLowerCase() !== options.repository.owner.toLowerCase() ||
    input.repository.toLowerCase() !== options.repository.name.toLowerCase()
  )
    throw new Error("repository is outside the authorized scope");
}

function assertIssue(options: GithubReadMcpOptions, input: IssueArguments): void {
  assertRepository(options, input);
  if (input.issue !== options.issueNumber) throw new Error("Issue is outside the authorized scope");
}

function assertPullRequest(options: GithubReadMcpOptions, input: PullRequestArguments): void {
  assertRepository(options, input);
  if (options.pullRequestNumber === undefined || input.pullRequest !== options.pullRequestNumber)
    throw new Error("Pull Request is outside the authorized scope");
}

function assertExactFile(commitSha: string, path: string): void {
  if (!exactSha.test(commitSha) || !safePath.test(path))
    throw new Error("file reads require an exact commit SHA and safe path");
}

function project(resource: string, options: GithubReadMcpOptions, data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          provenance: {
            source: "github",
            role: options.role,
            repository: `${options.repository.owner}/${options.repository.name}`,
            issue: options.issueNumber,
            pullRequest: options.pullRequestNumber ?? null,
            resource,
          },
          data,
        }),
      },
    ],
  };
}

function bounded(value: string | null | undefined): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

async function withRequestOptions<T>(
  options: GithubReadMcpOptions,
  operation: (request: RequestOptions) => Promise<T>,
): Promise<T> {
  const timeout = Math.max(
    1,
    Math.min(options.requestTimeoutMs ?? 10_000, remainingUntil(options.deadlineEpochMs)),
  );
  return Effect.runPromise(
    Effect.tryPromise({
      try: (signal) =>
        operation({
          timeout,
          retries: 0,
          signal,
        }),
      catch: (error) => error,
    }).pipe(Effect.timeout(Duration.millis(timeout))),
    { signal: options.signal },
  );
}

type RequestOptions = {
  timeout: number;
  retries: 0;
  signal: AbortSignal;
};

export interface GithubReadMcpHttpOptions extends GithubReadMcpOptions {
  host?: string;
  port?: number;
}

export interface GithubReadMcpHttpHandle {
  url: string;
  close(): Promise<void>;
}

export async function startGithubReadMcpHttp(
  options: GithubReadMcpHttpOptions,
): Promise<GithubReadMcpHttpHandle> {
  const transports = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();
  const http = createServer(async (request, response) => {
    if (request.url?.split("?", 1)[0] !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    try {
      const sessionId = request.headers["mcp-session-id"];
      const body = request.method === "POST" ? await requestBody(request) : undefined;
      let session = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!session) {
        if (!isInitializeRequest(body)) {
          response.statusCode = 400;
          response.end("MCP session is unavailable");
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createGithubReadMcpServer(options);
        session = { transport, server };
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        if (transport.sessionId) transports.set(transport.sessionId, session);
        return;
      }
      await session.transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("MCP request failed");
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("GitHub read MCP host did not bind");
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}/mcp`,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const { server } of transports.values()) await server.close();
        await new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
      })();
      return closePromise;
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > 65_536) throw new Error("MCP request is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
