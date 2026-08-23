import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vite-plus/test";
import {
  createGithubReadMcpServer,
  startGithubReadMcpHttp,
  type GithubReadMcpHttpHandle,
} from "../src/index.js";

const exactSha = "a".repeat(40);

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
            { id: 1, body: "bounded issue comment", user: { login: "author" } },
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
            { id: 2, state: "APPROVED", body: "approved", user: { login: "reviewer" } },
          ]);
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
                              author: { login: "reviewer" },
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
      expect(JSON.stringify(reviews)).toContain("reviewThreads");
      expect(JSON.stringify(reviews)).toContain('\\"isResolved\\":true');
      expect(requests.filter(({ path }) => path.endsWith("/comments"))).toHaveLength(1);
      expect(requests.filter(({ path }) => path.endsWith("/reviews"))).toHaveLength(1);
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
        "per_page=50",
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
