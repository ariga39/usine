import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vite-plus/test";
import { createGithubReadMcpServer } from "../src/index.js";

const exactSha = "a".repeat(40);

describe("host-owned GitHub read MCP", () => {
  test("uses a separate host credential and exposes only bounded exact reads", async () => {
    const requests: Array<{
      method: string;
      path: string;
      query: string;
      authorization: string | null;
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
        if (path === "/repos/example/authorized/pulls/7/comments")
          return Response.json([
            {
              id: 4,
              body: "review thread",
              user: { login: "reviewer" },
              path: "src/index.ts",
              line: 1,
            },
          ]);
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
      expect(JSON.stringify(reviews)).toContain("reviewComments");
      expect(requests.filter(({ path }) => path.endsWith("/comments"))).toHaveLength(2);
      expect(requests.filter(({ path }) => path.endsWith("/reviews"))).toHaveLength(1);
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
});
