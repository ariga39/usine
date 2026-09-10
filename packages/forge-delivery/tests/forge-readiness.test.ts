import { describe, expect, test } from "vite-plus/test";
import { checkForgeReadiness, type ForgePolicy } from "../src/index.js";

const repository = { owner: "owner", name: "repo" };
const forge = {
  mode: "test" as const,
  appSlug: "forge-app",
  token: "installation-token",
  apiUrl: "http://127.0.0.1:8787",
  gitUrl: "https://github.com/owner/repo.git",
  installationId: 42,
  appId: "123",
  appToken: "app-jwt",
  permissions: { contents: "write", pull_requests: "write", issues: "write" },
};

function fetchFor(options: { repository?: string; repositoryStatus?: number }) {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: headers.get("authorization"),
    });
    if (url.pathname === "/app") {
      if (headers.get("authorization") !== "token app-jwt")
        return Response.json(
          { message: "App JWT observation requires App authentication" },
          { status: 403 },
        );
      return Response.json({ id: 123, slug: "forge-app" });
    }
    if (url.pathname === "/repos/owner/repo") {
      if (headers.get("authorization") !== "token installation-token")
        return Response.json(
          { message: "repository read requires installation authentication" },
          { status: 403 },
        );
      return Response.json(
        { full_name: options.repository ?? "owner/repo" },
        { status: options.repositoryStatus ?? 200 },
      );
    }
    // The old /repos/{owner}/{repo}/installation endpoint is App-JWT-only and must never be used.
    return Response.json(
      { message: "App JWT-only installation route is not available" },
      { status: 403 },
    );
  };
  return { fetchImplementation, requests };
}

async function readiness(
  options: Parameters<typeof fetchFor>[0] = {},
  policy: ForgePolicy = forge,
) {
  const controlled = fetchFor(options);
  const result = await checkForgeReadiness({
    repository,
    forge: policy,
    fetch: controlled.fetchImplementation,
  });
  return { result, requests: controlled.requests };
}

describe("Forge readiness", () => {
  test("reports explicit success from installation metadata and an installation-token repository read", async () => {
    const { result, requests } = await readiness();

    expect(result).toEqual({
      ready: true,
      appSlug: "forge-app",
      installationId: 42,
      repository: "owner/repo",
      permissions: {
        contents: "write",
        pullRequests: "write",
        issues: "write",
      },
    });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/app",
        authorization: "token app-jwt",
      },
      {
        method: "GET",
        path: "/repos/owner/repo",
        authorization: "token installation-token",
      },
    ]);
  });

  test.each([
    ["contents", "Contents", { contents: "read", pull_requests: "write", issues: "write" }],
    [
      "pull_requests",
      "Pull requests",
      { contents: "write", pull_requests: "read", issues: "write" },
    ],
    ["issues", "Issues", { contents: "write", pull_requests: "write", issues: "read" }],
  ] as const)("reports a missing %s write permission", async (permission, label, permissions) => {
    const { result } = await readiness({}, { ...forge, permissions });

    expect(result).toEqual({
      ready: false,
      code: "permission_missing",
      permission,
      expected: `${label}: write`,
      observed: `${label}: ${permissions[permission]}`,
      action: `Update the Forge App installation permission for ${label} to write, then rerun readiness.`,
    });
  });

  test("requires only the selected private-repository pipeline read capability", async () => {
    const { result } = await readiness(
      {},
      {
        ...forge,
        pipeline: { checkRuns: ["build"], statusContexts: [] },
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          checks: "read",
        },
      },
    );
    expect(result).toEqual({
      ready: true,
      appSlug: "forge-app",
      installationId: 42,
      repository: "owner/repo",
      permissions: {
        contents: "write",
        pullRequests: "write",
        issues: "write",
        checks: "read",
      },
    });
  });

  test("reports selected pipeline capability gaps without requiring the other endpoint", async () => {
    const { result } = await readiness(
      {},
      {
        ...forge,
        pipeline: { checkRuns: [], statusContexts: ["ci/deploy"] },
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          statuses: "none",
        },
      },
    );
    expect(result).toMatchObject({
      ready: false,
      code: "permission_missing",
      permission: "statuses",
      expected: "Commit statuses: read",
    });
  });

  test("reports a wrong nonblank App slug before repository readiness", async () => {
    const { result, requests } = await readiness({}, { ...forge, appSlug: "wrong-slug" });

    expect(result).toEqual({
      ready: false,
      code: "identity_missing",
      expected: "Forge App ID 123 and slug 'wrong-slug'",
      observed: "GitHub returned App ID 123 with a different configured identity",
      action: "Configure the App ID and slug for the installed Forge App, then rerun readiness.",
    });
    expect(requests).toHaveLength(1);
  });

  test("reports a wrong App ID before repository readiness", async () => {
    const { result, requests } = await readiness({}, { ...forge, appId: "999" });

    expect(result).toMatchObject({
      ready: false,
      code: "identity_missing",
      expected: "Forge App ID 999 and slug 'forge-app'",
      observed: "GitHub returned App ID 123 with a different configured identity",
    });
    expect(requests).toHaveLength(1);
  });

  test("reports a repository binding failure when the installation-token read returns another name", async () => {
    const { result } = await readiness({ repository: "owner/other-repo" });

    expect(result).toEqual({
      ready: false,
      code: "repository_binding_missing",
      expected: "Forge App installation access to owner/repo",
      observed: "the installation does not expose the registered repository",
      action: "Install the Forge App on owner/repo, then rerun readiness.",
    });
  });

  test("reports a missing installation when authenticated metadata has no installation ID", async () => {
    const { result } = await readiness({}, { ...forge, installationId: undefined });

    expect(result).toEqual({
      ready: false,
      code: "installation_missing",
      expected: "an authenticated Forge App installation identity",
      observed: "installation authentication returned no installation ID",
      action: "Record the installed App's installation ID, then rerun readiness.",
    });
  });

  test("reports bounded authentication failure without provider details", async () => {
    const { result } = await readiness({ repositoryStatus: 401 });

    expect(result).toEqual({
      ready: false,
      code: "authentication_failed",
      expected: "authenticated access from Forge App installation 42",
      observed: "GitHub rejected the Forge installation authentication",
      action:
        "Check the App ID, installation ID, private key, and App installation, then rerun readiness.",
    });
  });

  test("redacts credentials and private configuration from every failure", async () => {
    const { result } = await readiness({ repositoryStatus: 500 });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("installation-token");
    expect(serialized).not.toContain("private-key-path");
    expect(serialized).not.toContain("provider");
  });
});
