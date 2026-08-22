import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vite-plus/test";
import {
  ForgeProfileResolutionError,
  forgePolicyFromEnvironment,
  githubReadPolicyFromEnvironment,
  runtimePolicyFromEnvironment,
} from "@usine/runtime";

async function documentedProductionEnvironment(): Promise<NodeJS.ProcessEnv> {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const command = readme.match(/```sh\n([\s\S]*?)\n```/)?.[1];
  if (!command) throw new Error("README startup command is missing");

  const environment: NodeJS.ProcessEnv = {};
  for (const line of command.split("\n")) {
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|([^ ]+)) \\$/);
    const key = assignment?.[1];
    if (key) environment[key] = assignment[2] ?? assignment[3];
  }
  return environment;
}

const repository = {
  owner: "owner",
  name: "repo",
  implementerProfile: "implementer-profile",
  reviewerProfile: "reviewer-profile",
  forgeProfile: "release",
};

const forgeEnvironment = {
  USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "release-app",
  USINE_FORGE_PROFILE_RELEASE_APP_ID: "123",
  USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID: "456",
  USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "app.pem",
  USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
};

const roleOutputEnvironment = {
  USINE_ROLE_OUTPUT_API_KEY: "placeholder-coordinator-key",
  USINE_ROLE_OUTPUT_API_URL: "https://placeholder.invalid/v1",
  USINE_ROLE_OUTPUT_MODEL: "placeholder-normalization-model",
};

describe("runtime composition", () => {
  test("accepts the documented production startup shape before external delivery", async () => {
    const environment = await documentedProductionEnvironment();
    expect(environment).not.toHaveProperty("USINE_IMPLEMENTER_PROFILE");

    const policy = runtimePolicyFromEnvironment(environment, {
      owner: "example-owner",
      name: "example-repository",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "release",
    });

    expect(policy).toMatchObject({
      roles: {
        implementer: { profile: "writer-profile" },
        reviewer: { profile: "reviewer-profile" },
      },
      forge: {
        mode: "app",
        appId: "123456",
        installationId: 123456,
        appSlug: "example-app",
        privateKeyPath: "./app-private-key.pem",
      },
    });
  });

  test("validates deployment inputs once and derives capability-safe values", () => {
    const policy = runtimePolicyFromEnvironment(
      {
        PATH: "/portable/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "coordinator-secret",
        GITHUB_TOKEN: "delivery-secret",
        USINE_STATE_DIR: "/state",
        USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "usine-app",
        USINE_FORGE_PROFILE_RELEASE_TEST_TOKEN: "test-token",
        USINE_FORGE_PROFILE_RELEASE_API_URL: "http://127.0.0.1:8787",
        USINE_FORGE_PROFILE_RELEASE_GIT_URL: "http://127.0.0.1:8787/owner/repo.git",
        USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
        USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "private-key.pem",
      },
      {
        owner: "owner",
        name: "repo",
        implementerProfile: "implementer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "release",
      },
    );

    expect(policy).toMatchObject({
      stateDirectory: "/state",
      roles: {
        implementer: {
          role: "implementer",
          profile: "implementer-profile",
          sandbox: "workspace-write",
        },
        reviewer: {
          role: "reviewer",
          profile: "reviewer-profile",
          sandbox: "read-only",
        },
      },
      forge: {
        mode: "test",
        appSlug: "usine-app",
        token: "test-token",
        apiUrl: "http://127.0.0.1:8787",
        gitUrl: "http://127.0.0.1:8787/owner/repo.git",
      },
    });
    expect(policy.workerEnvironment).toMatchObject({ CI: "true", PATH: "/portable/bin" });
    expect(policy.workerEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(policy.workerEnvironment).not.toHaveProperty("GITHUB_TOKEN");
    expect(policy.workerEnvironment).not.toHaveProperty("USINE_FORGE_PROFILE_RELEASE_TEST_TOKEN");
    expect(policy.workerEnvironment).not.toHaveProperty(
      "USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH",
    );
    expect(policy.credentialFreeGitEnvironment).toMatchObject({
      PATH: "/portable/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(policy.credentialFreeGitEnvironment).not.toHaveProperty(
      "USINE_FORGE_PROFILE_RELEASE_TEST_TOKEN",
    );
  });

  test.each([
    ["all settings", roleOutputEnvironment, true],
    ["no settings", {}, false],
  ])("resolves role output configuration with %s", (_name, roleOutput, configured) => {
    const policy = runtimePolicyFromEnvironment({ ...forgeEnvironment, ...roleOutput }, repository);

    if (configured) expect(policy.roleOutputTransform).toEqual(expect.any(Function));
    else expect(policy.roleOutputTransform).toBeUndefined();
  });

  test.each([
    ["API key", { USINE_ROLE_OUTPUT_API_KEY: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_KEY }],
    ["API URL", { USINE_ROLE_OUTPUT_API_URL: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_URL }],
    ["model", { USINE_ROLE_OUTPUT_MODEL: roleOutputEnvironment.USINE_ROLE_OUTPUT_MODEL }],
    [
      "API key and API URL",
      {
        USINE_ROLE_OUTPUT_API_KEY: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_KEY,
        USINE_ROLE_OUTPUT_API_URL: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_URL,
      },
    ],
    [
      "API key and model",
      {
        USINE_ROLE_OUTPUT_API_KEY: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_KEY,
        USINE_ROLE_OUTPUT_MODEL: roleOutputEnvironment.USINE_ROLE_OUTPUT_MODEL,
      },
    ],
    [
      "API URL and model",
      {
        USINE_ROLE_OUTPUT_API_URL: roleOutputEnvironment.USINE_ROLE_OUTPUT_API_URL,
        USINE_ROLE_OUTPUT_MODEL: roleOutputEnvironment.USINE_ROLE_OUTPUT_MODEL,
      },
    ],
  ])("rejects partial role output configuration: %s", (_name, roleOutput) => {
    expect(() =>
      runtimePolicyFromEnvironment({ ...forgeEnvironment, ...roleOutput }, repository),
    ).toThrow("role output transform configuration is incomplete");
  });

  test("does not read Git author policy from global environment", () => {
    expect(() =>
      runtimePolicyFromEnvironment(
        {
          USINE_GIT_AUTHOR_NAME: "Release Bot",
          USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
          USINE_FORGE_PROFILE_WRITER_APP_SLUG: "app",
          USINE_FORGE_PROFILE_WRITER_APP_ID: "1",
          USINE_FORGE_PROFILE_WRITER_INSTALLATION_ID: "2",
          USINE_FORGE_PROFILE_WRITER_PRIVATE_KEY_PATH: "app.pem",
          USINE_FORGE_PROFILE_WRITER_REPOSITORY: "owner/repo",
        },
        {
          owner: "owner",
          name: "repo",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
          forgeProfile: "writer",
        },
      ),
    ).not.toThrow();
  });

  test("keeps separately credentialed GitHub reads scoped by worker role", () => {
    const environment = {
      USINE_GITHUB_READ_PROFILE_READ_ONLY_APP_SLUG: "read-app",
      USINE_GITHUB_READ_PROFILE_READ_ONLY_TEST_TOKEN: "read-secret",
      USINE_GITHUB_READ_PROFILE_READ_ONLY_API_URL: "http://127.0.0.1:8787",
      USINE_GITHUB_READ_PROFILE_READ_ONLY_REPOSITORY: "owner/repo",
      USINE_GITHUB_READ_PROFILE_READ_ONLY_IMPLEMENTER_TOOLS:
        "github_issue_get,github_issue_comments",
      USINE_GITHUB_READ_PROFILE_READ_ONLY_REVIEWER_TOOLS:
        "github_pull_request_get,github_pull_request_reviews,github_pull_request_checks",
      USINE_GITHUB_READ_PROFILE_OTHER_READ_APP_SLUG: "other-read-app",
      USINE_GITHUB_READ_PROFILE_OTHER_READ_TEST_TOKEN: "other-read-secret",
      USINE_GITHUB_READ_PROFILE_OTHER_READ_API_URL: "http://127.0.0.1:8787",
      USINE_GITHUB_READ_PROFILE_OTHER_READ_REPOSITORY: "other/repo",
    };
    const policy = githubReadPolicyFromEnvironment(environment, {
      owner: "owner",
      name: "repo",
      githubReadProfile: "read-only",
    });
    expect(policy).toEqual({
      policy: {
        mode: "test",
        appSlug: "read-app",
        token: "read-secret",
        apiUrl: "http://127.0.0.1:8787",
      },
      implementerTools: ["github_issue_get", "github_issue_comments"],
      reviewerTools: [
        "github_pull_request_get",
        "github_pull_request_reviews",
        "github_pull_request_checks",
      ],
    });
    const runtime = runtimePolicyFromEnvironment(
      { ...forgeEnvironment, ...environment },
      { ...repository, githubReadProfile: "read-only" },
    );
    expect(runtime.githubRead).toEqual(policy);
    expect(runtime.workerEnvironment).not.toHaveProperty(
      "USINE_GITHUB_READ_PROFILE_READ_ONLY_TEST_TOKEN",
    );
    expect(
      githubReadPolicyFromEnvironment(environment, {
        owner: "other",
        name: "repo",
        githubReadProfile: "other-read",
      }),
    ).toEqual(
      expect.objectContaining({
        policy: expect.objectContaining({ token: "other-read-secret" }),
      }),
    );
  });

  test("rejects test forge credentials outside loopback", () => {
    expect(() =>
      runtimePolicyFromEnvironment(
        {
          USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "usine-app",
          USINE_FORGE_PROFILE_RELEASE_TEST_TOKEN: "test-token",
          USINE_FORGE_PROFILE_RELEASE_API_URL: "https://github.com",
          USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
        },
        {
          owner: "owner",
          name: "repo",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
          forgeProfile: "release",
        },
      ),
    ).toThrow("loopback");
  });

  test("retains the production GitHub App authentication policy without test credentials", () => {
    const policy = runtimePolicyFromEnvironment(
      {
        USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "usine-app",
        USINE_FORGE_PROFILE_RELEASE_APP_ID: "123",
        USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID: "456",
        USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "app.pem",
        USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
      },
      {
        owner: "owner",
        name: "repo",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
        forgeProfile: "release",
      },
    );

    expect(policy.forge).toEqual({
      mode: "app",
      appSlug: "usine-app",
      appId: "123",
      installationId: 456,
      privateKeyPath: "app.pem",
      gitUrl: "https://github.com/owner/repo.git",
    });
  });

  test("resolves the repository forge profile from host configuration", () => {
    expect(
      forgePolicyFromEnvironment(
        {
          USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "release-app",
          USINE_FORGE_PROFILE_RELEASE_APP_ID: "123",
          USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID: "456",
          USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "release.pem",
          USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
        },
        {
          owner: "owner",
          name: "repo",
          forgeProfile: "release",
        },
      ),
    ).toEqual({
      mode: "app",
      appSlug: "release-app",
      appId: "123",
      installationId: 456,
      privateKeyPath: "release.pem",
      gitUrl: "https://github.com/owner/repo.git",
    });
  });

  test("does not select forge credentials from the deleted global path", () => {
    expect(() =>
      forgePolicyFromEnvironment(
        {
          USINE_GITHUB_APP_SLUG: "legacy",
          USINE_GITHUB_APP_ID: "123",
          USINE_GITHUB_INSTALLATION_ID: "456",
          USINE_GITHUB_PRIVATE_KEY_PATH: "legacy.pem",
        },
        { owner: "owner", name: "repo", forgeProfile: "release" },
      ),
    ).toThrow("forge profile");
  });

  test("rejects profile names that could alias another host variable", () => {
    expect(() =>
      forgePolicyFromEnvironment({}, { owner: "owner", name: "repo", forgeProfile: "release_app" }),
    ).toThrow("malformed");
  });

  test.each([
    ["missing", {}, "unauthorized"],
    [
      "malformed",
      {
        USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "release-app",
        USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "owner/repo",
      },
      "malformed",
    ],
    [
      "repository mismatch",
      {
        USINE_FORGE_PROFILE_RELEASE_APP_SLUG: "release-app",
        USINE_FORGE_PROFILE_RELEASE_APP_ID: "123",
        USINE_FORGE_PROFILE_RELEASE_INSTALLATION_ID: "456",
        USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "release.pem",
        USINE_FORGE_PROFILE_RELEASE_REPOSITORY: "other/repo",
      },
      "repository_mismatch",
    ],
  ])("rejects a %s forge profile before delivery", (_name, environment, code) => {
    try {
      forgePolicyFromEnvironment(environment, {
        owner: "owner",
        name: "repo",
        forgeProfile: "release",
      });
      throw new Error("expected forge profile resolution to fail");
    } catch (error) {
      if (!(error instanceof ForgeProfileResolutionError)) throw error;
      expect(error.code).toBe(code);
      expect(error.message).toContain("release");
      if (code === "repository_mismatch") expect(error.message).toContain("owner/repo");
    }
  });
});
