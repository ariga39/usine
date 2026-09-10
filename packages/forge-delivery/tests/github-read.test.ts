import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vite-plus/test";
import {
  createGithubReadMcpServer,
  readGithubPipelineEvidence,
  startGithubReadMcpHttp,
  type GithubReadMcpHttpHandle,
} from "../src/index.js";
import { createGithubApiClient } from "../src/index.js";

const exactSha = "a".repeat(40);

test("observes only the configured exact-head pipeline entries", async () => {
  const requests: string[] = [];
  const client = await createGithubApiClient(
    {
      mode: "test",
      appSlug: "test-app",
      token: "test-token",
      apiUrl: "https://github.invalid",
    },
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push(url.pathname);
      if (url.pathname === "/repos/example/authorized/pulls/7")
        return Response.json({ head: { sha: exactSha } });
      if (url.pathname === `/repos/example/authorized/commits/${exactSha}/check-runs`)
        return Response.json({
          total_count: 2,
          check_runs: [
            {
              id: 9,
              name: "required",
              status: "completed",
              conclusion: "success",
              app: { id: 42, slug: "ci" },
            },
            {
              id: 10,
              name: "required",
              status: "queued",
              conclusion: null,
              app: { id: 42, slug: "ci" },
            },
          ],
        });
      if (url.pathname === `/repos/example/authorized/commits/${exactSha}/status`)
        return Response.json({
          total_count: 1,
          statuses: [{ id: 1, context: "deploy", state: "success" }],
        });
      return Response.json({ message: "not found" }, { status: 404 });
    },
  );

  const evidence = await readGithubPipelineEvidence(
    client,
    { owner: "example", name: "authorized" },
    7,
    exactSha,
    { checkRuns: ["required"], statusContexts: ["deploy"] },
  );

  expect(evidence).toMatchObject({ sha: exactSha, ready: false });
  expect(evidence.diagnostic).toContain("required");
  expect(evidence.diagnostic).toContain("queued");
  expect(requests).toEqual([
    "/repos/example/authorized/pulls/7",
    `/repos/example/authorized/commits/${exactSha}/check-runs`,
    `/repos/example/authorized/commits/${exactSha}/status`,
  ]);
});

test("does not require an unconfigured pipeline source", async () => {
  const requests: string[] = [];
  const client = await createGithubApiClient(
    {
      mode: "test",
      appSlug: "test-app",
      token: "test-token",
      apiUrl: "https://github.invalid",
    },
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push(url.pathname);
      if (url.pathname === "/repos/example/authorized/pulls/7")
        return Response.json({ head: { sha: exactSha } });
      if (url.pathname === `/repos/example/authorized/commits/${exactSha}/check-runs`)
        return Response.json({
          total_count: 1,
          check_runs: [{ id: 10, name: "required", status: "completed", conclusion: "success" }],
        });
      return Response.json({ message: "unconfigured source must not be read" }, { status: 403 });
    },
  );

  await expect(
    readGithubPipelineEvidence(client, { owner: "example", name: "authorized" }, 7, exactSha, {
      checkRuns: ["required"],
      statusContexts: [],
    }),
  ).resolves.toMatchObject({ ready: true });
  expect(requests).not.toContain(`/repos/example/authorized/commits/${exactSha}/status`);
});

describe("host-owned GitHub read MCP", () => {
  test("uses a separate host credential and exposes only bounded exact reads", async () => {
    const requests: Array<{
      method: string;
      path: string;
      query: string;
      authorization: string | null;
      body: string | null;
    }> = [];
    const server = createGithubReadMcpServer({
      repository: { owner: "example", name: "authorized" },
      issueNumber: 189,
      pullRequestNumber: 7,
      role: "implementer",
      tools: [
        "github_issue_get",
        "github_issue_comments",
        "github_pull_request_get",
        "github_pull_request_reviews",
        "github_pull_request_checks",
        "github_file_get",
        "github_commit_get",
      ],
      policy: {
        mode: "test",
        appSlug: "read-only-app",
        token: "host-read-credential",
        apiUrl: "https://fake-github.invalid",
      },
      deadlineEpochMs: Date.now() + 5_000,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        const path = decodeURIComponent(url.pathname);
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          query: url.search,
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (path === "/repos/example/authorized/issues/189")
          return Response.json({
            number: 189,
            title: "Authorized issue",
            body: "bounded issue body",
            state: "open",
          });
        if (path === "/repos/example/authorized/issues/189/comments")
          return Response.json([
            { id: 1, body: "bounded issue comment", user: { login: "author", type: "User" } },
          ]);
        if (path === "/repos/example/authorized/issues/7/comments")
          return Response.json([
            {
              id: 5,
              body: `ordinary PR comment${"x".repeat(9_000)}`,
              user: { id: 22, login: "commenter", type: "User" },
              created_at: "2026-09-08T00:00:00Z",
              updated_at: "2026-09-08T00:01:00Z",
            },
          ]);
        if (path === "/repos/example/authorized/pulls/7")
          return Response.json({
            number: 7,
            title: "Authorized PR",
            body: "bounded PR body",
            state: "open",
            head: { sha: exactSha, ref: "agent/189" },
            base: { sha: "b".repeat(40), ref: "main" },
          });
        if (path === "/repos/example/authorized/pulls/7/reviews")
          return Response.json([
            {
              id: 2,
              state: "APPROVED",
              body: "approved",
              user: { id: 314708956, login: "review-app[bot]", type: "Bot" },
              performed_via_github_app: null,
              commit_id: exactSha,
              submitted_at: "2026-09-08T00:00:00Z",
            },
            ...Array.from({ length: 50 }, (_, index) => ({
              id: 100 + index,
              state: "COMMENTED",
              body: "bounded review",
              user: { id: 21, login: "reviewer", type: "User" },
              commit_id: exactSha,
              submitted_at: "2026-09-08T00:00:00Z",
            })),
          ]);
        if (path === "/repos/example/authorized/pulls/7/comments")
          return Response.json([
            {
              id: 4,
              body: "App inline feedback",
              user: { id: 314708956, login: "review-app[bot]", type: "Bot" },
              performed_via_github_app: null,
              pull_request_review_id: 2,
              path: "src/index.ts",
              line: 7,
              created_at: "2026-09-08T00:02:00Z",
              updated_at: "2026-09-08T00:03:00Z",
            },
          ]);
        if (path === "/apps/review-app") return Response.json({ id: 42, slug: "review-app" });
        if (path === "/graphql")
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-1",
                        isResolved: true,
                        comments: {
                          nodes: [
                            {
                              databaseId: 4,
                              body: "review thread",
                              author: { databaseId: 21, login: "reviewer" },
                              path: "src/index.ts",
                              line: 1,
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        if (path === `/repos/example/authorized/commits/${exactSha}/check-runs`)
          return Response.json({
            check_runs: [{ id: 3, name: "checks", status: "completed", conclusion: "success" }],
          });
        if (path === "/repos/example/authorized/contents/src/index.ts")
          return Response.json({
            type: "file",
            path: "src/index.ts",
            sha: "c".repeat(40),
            encoding: "base64",
            content: Buffer.from("export const ok = true;\n").toString("base64"),
          });
        if (path === `/repos/example/authorized/commits/${exactSha}`)
          return Response.json({
            sha: exactSha,
            commit: { message: "bounded commit" },
            files: [{ filename: "src/index.ts", status: "modified" }],
          });
        return Response.json({ message: "not found" }, { status: 404 });
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "github-read-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "github_issue_get",
        "github_issue_comments",
        "github_pull_request_get",
        "github_pull_request_reviews",
        "github_pull_request_checks",
        "github_file_get",
        "github_commit_get",
      ]);
      expect(listed.tools.map((tool) => tool.name)).not.toContain("github_issue_update");

      const issue = await client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "authorized", issue: 189 },
      });
      const pr = await client.callTool({
        name: "github_pull_request_get",
        arguments: { owner: "example", repository: "authorized", pullRequest: 7 },
      });
      const comments = await client.callTool({
        name: "github_issue_comments",
        arguments: { owner: "example", repository: "authorized", issue: 189 },
      });
      const reviews = await client.callTool({
        name: "github_pull_request_reviews",
        arguments: { owner: "example", repository: "authorized", pullRequest: 7 },
      });
      const checks = await client.callTool({
        name: "github_pull_request_checks",
        arguments: { owner: "example", repository: "authorized", pullRequest: 7 },
      });
      const file = await client.callTool({
        name: "github_file_get",
        arguments: {
          owner: "example",
          repository: "authorized",
          commitSha: exactSha,
          path: "src/index.ts",
        },
      });
      const commit = await client.callTool({
        name: "github_commit_get",
        arguments: { owner: "example", repository: "authorized", commitSha: exactSha },
      });
      for (const [name, result] of [
        ["issue", issue],
        ["pr", pr],
        ["comments", comments],
        ["reviews", reviews],
        ["checks", checks],
        ["file", file],
        ["commit", commit],
      ] as const) {
        expect(result.isError, name).not.toBe(true);
        const text = Array.isArray(result.content)
          ? result.content.find(
              (item): item is { type: "text"; text: string } =>
                typeof item === "object" &&
                item !== null &&
                "type" in item &&
                item.type === "text" &&
                "text" in item &&
                typeof item.text === "string",
            )
          : undefined;
        expect(text?.text ?? "").toContain('"provenance"');
        expect(JSON.stringify(result)).not.toContain("host-read-credential");
      }
      expect(JSON.stringify(reviews)).toContain("review thread");
      expect(JSON.stringify(reviews)).toContain("ordinary PR comment");
      expect(JSON.stringify(reviews)).toContain('\\"kind\\":\\"app\\"');
      expect(JSON.stringify(reviews)).toContain('\\"id\\":42');
      expect(JSON.stringify(reviews)).toContain('\\"pullRequestReviewId\\":2');
      expect(JSON.stringify(reviews)).toContain('\\"path\\":\\"src/index.ts\\"');
      expect(JSON.stringify(reviews)).toContain('\\"line\\":7');
      expect(JSON.stringify(reviews)).not.toContain("x".repeat(9_000));
      expect(JSON.stringify(reviews)).toContain('\\"id\\":21');
      expect(JSON.stringify(reviews)).toContain('\\"exactHead\\":true');
      expect(JSON.stringify(reviews)).toContain('\\"reviewsTruncated\\":true');
      expect(JSON.stringify(reviews)).toContain("reviewThreads");
      expect(JSON.stringify(reviews)).toContain('\\"isResolved\\":true');
      expect(requests.filter(({ path }) => path.endsWith("/comments"))).toHaveLength(3);
      expect(requests.filter(({ path }) => path.endsWith("/reviews"))).toHaveLength(1);
      expect(requests.filter(({ path }) => path === "/apps/review-app")).toHaveLength(1);
      expect(JSON.stringify(reviews)).toContain('\\"state\\":\\"APPROVED\\"');
      const graphQlRequests = requests.filter(({ path }) => path === "/graphql");
      expect(graphQlRequests).toHaveLength(1);
      const graphQlBody = JSON.parse(graphQlRequests[0]?.body ?? "{}");
      expect(graphQlBody.variables).toMatchObject({
        owner: "example",
        repo: "authorized",
        pullRequest: 7,
        threadLimit: 50,
        commentLimit: 50,
      });
      expect(graphQlBody.query).toContain("reviewThreads");
      expect(graphQlBody.query).not.toContain("after");
      expect(requests.find(({ path }) => path.endsWith("/reviews"))?.query).toContain(
        "per_page=51",
      );
      expect(requests.some(({ query }) => query.includes("page=2"))).toBe(false);

      const crossRepository = await client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "other", issue: 189 },
      });
      const wrongIssue = await client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "authorized", issue: 190 },
      });
      const wrongCommit = await client.callTool({
        name: "github_file_get",
        arguments: {
          owner: "example",
          repository: "authorized",
          commitSha: "main",
          path: "src/index.ts",
        },
      });
      const traversal = await client.callTool({
        name: "github_file_get",
        arguments: {
          owner: "example",
          repository: "authorized",
          commitSha: exactSha,
          path: "../secret",
        },
      });
      expect(crossRepository.isError).toBe(true);
      expect(wrongIssue.isError).toBe(true);
      expect(wrongCommit.isError).toBe(true);
      expect(traversal.isError).toBe(true);
      expect(
        requests.every((request) => request.authorization === "token host-read-credential"),
      ).toBe(true);
      expect(
        requests.some(
          (request) => request.path.includes("/other/") || request.path.includes("/190"),
        ),
      ).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("serves the public MCP contract through official Streamable HTTP", async ({ skip }) => {
    const apiRequests: string[] = [];
    let handle: GithubReadMcpHttpHandle;
    try {
      handle = await startGithubReadMcpHttp({
        repository: { owner: "example", name: "authorized" },
        issueNumber: 189,
        role: "reviewer",
        tools: ["github_issue_get"],
        policy: {
          mode: "test",
          appSlug: "read-only-app",
          token: "host-read-credential",
          apiUrl: "https://fake-github.invalid",
        },
        deadlineEpochMs: Date.now() + 5_000,
        fetch: async (input) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input : input.url,
          );
          apiRequests.push(url.pathname);
          return Response.json({
            number: 189,
            title: "Authorized issue over HTTP",
            body: "bounded issue body",
            state: "open",
          });
        },
      });
    } catch (error) {
      if (isListenPermissionError(error)) {
        skip();
        return;
      }
      throw error;
    }
    const transport = new StreamableHTTPClientTransport(new URL(handle.url));
    const client = new Client({ name: "github-read-http-test", version: "1.0.0" });
    let clientClosed = false;
    let hostClosed = false;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "authorized", issue: 189 },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("Authorized issue over HTTP");
      expect(apiRequests).toEqual(["/repos/example/authorized/issues/189"]);
      process.on("unhandledRejection", onUnhandledRejection);
      await client.close();
      clientClosed = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
      await handle.close();
      hostClosed = true;
      await expect(handle.close()).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      if (!clientClosed) await client.close();
      if (!hostClosed) await handle.close();
    }
  });

  test.each([
    ["implementer", ["github_issue_get", "github_issue_comments"]],
    ["reviewer", ["github_pull_request_get", "github_pull_request_reviews"]],
  ] as const)("keeps the %s public tool scope independent", async (role, tools) => {
    const server = createGithubReadMcpServer({
      repository: { owner: "example", name: "authorized" },
      issueNumber: 189,
      pullRequestNumber: 7,
      role,
      tools,
      policy: {
        mode: "test",
        appSlug: "read-only-app",
        token: "host-read-credential",
        apiUrl: "https://fake-github.invalid",
      },
      deadlineEpochMs: Date.now() + 5_000,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `github-read-${role}-scope-test`, version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...tools]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("fails closed when the fake host exceeds the read deadline", async () => {
    let resolveFetchStarted!: (signal: AbortSignal) => void;
    let rejectFetchStarted!: (error: Error) => void;
    const fetchStarted = new Promise<AbortSignal>((resolve, reject) => {
      resolveFetchStarted = resolve;
      rejectFetchStarted = reject;
    });
    const server = createGithubReadMcpServer({
      repository: { owner: "example", name: "authorized" },
      issueNumber: 189,
      role: "implementer",
      tools: ["github_issue_get"],
      policy: {
        mode: "test",
        appSlug: "read-only-app",
        token: "host-read-credential",
        apiUrl: "https://fake-github.invalid",
      },
      deadlineEpochMs: Date.now() + 5_000,
      requestTimeoutMs: 1_000,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            const error = new Error("GitHub request signal is missing");
            rejectFetchStarted(error);
            reject(error);
            return;
          }
          resolveFetchStarted(signal);
          const timeout = setTimeout(() => reject(new Error("fake host did not respond")), 2_000);
          if (signal?.aborted) {
            clearTimeout(timeout);
            reject(new Error("fake host request timed out"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(new Error("fake host request timed out"));
            },
            { once: true },
          );
        }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "github-read-timeout-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resultPromise = client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "authorized", issue: 189 },
      });
      const underlyingRequestSignal = await fetchStarted;
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("GitHub read unavailable");
      expect(JSON.stringify(result)).not.toContain("host-read-credential");
      expect(underlyingRequestSignal?.aborted).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("cancelling the caller aborts the underlying GitHub request", async () => {
    const caller = new AbortController();
    let resolveFetchStarted!: (signal: AbortSignal) => void;
    const fetchStarted = new Promise<AbortSignal>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const server = createGithubReadMcpServer({
      repository: { owner: "example", name: "authorized" },
      issueNumber: 189,
      role: "implementer",
      tools: ["github_issue_get"],
      policy: {
        mode: "test",
        appSlug: "read-only-app",
        token: "host-read-credential",
        apiUrl: "https://fake-github.invalid",
      },
      deadlineEpochMs: Date.now() + 5_000,
      signal: caller.signal,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("GitHub request signal is missing"));
            return;
          }
          resolveFetchStarted(signal);
          if (signal.aborted) {
            reject(new Error("GitHub request was cancelled"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new Error("GitHub request was cancelled")),
            { once: true },
          );
        }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "github-read-cancellation-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resultPromise = client.callTool({
        name: "github_issue_get",
        arguments: { owner: "example", repository: "authorized", issue: 189 },
      });
      const underlyingRequestSignal = await fetchStarted;
      caller.abort();
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("GitHub read unavailable");
      expect(JSON.stringify(result)).not.toContain("host-read-credential");
      expect(underlyingRequestSignal.aborted).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function isListenPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}
