import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vite-plus/test";
import { runtimePolicyFromEnvironment } from "@usine/runtime";

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

describe("runtime composition", () => {
  test("accepts the documented production startup shape before external delivery", async () => {
    const environment = await documentedProductionEnvironment();
    expect(environment).not.toHaveProperty("USINE_IMPLEMENTER_PROFILE");

    const policy = runtimePolicyFromEnvironment(environment, {
      owner: "example-owner",
      name: "example-repository",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
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
        USINE_GITHUB_APP_SLUG: "usine-app",
        USINE_GITHUB_TEST_TOKEN: "test-token",
        USINE_GITHUB_API_URL: "http://127.0.0.1:8787",
        USINE_GITHUB_GIT_URL: "http://127.0.0.1:8787/owner/repo.git",
      },
      {
        owner: "owner",
        name: "repo",
        implementerProfile: "implementer-profile",
        reviewerProfile: "reviewer-profile",
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
    expect(policy.credentialFreeGitEnvironment).toMatchObject({
      PATH: "/portable/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("does not read Git author policy from global environment", () => {
    expect(() =>
      runtimePolicyFromEnvironment(
        {
          USINE_GIT_AUTHOR_NAME: "Release Bot",
          USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
        },
        {
          owner: "owner",
          name: "repo",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
        },
      ),
    ).not.toThrow();
  });

  test("rejects test forge credentials outside loopback", () => {
    expect(() =>
      runtimePolicyFromEnvironment(
        {
          USINE_GITHUB_APP_SLUG: "usine-app",
          USINE_GITHUB_TEST_TOKEN: "test-token",
          USINE_GITHUB_API_URL: "https://github.com",
        },
        {
          owner: "owner",
          name: "repo",
          implementerProfile: "writer-profile",
          reviewerProfile: "reviewer-profile",
        },
      ),
    ).toThrow("loopback");
  });

  test("retains the production GitHub App authentication policy without test credentials", () => {
    const policy = runtimePolicyFromEnvironment(
      {
        USINE_GITHUB_APP_SLUG: "usine-app",
        USINE_GITHUB_APP_ID: "123",
        USINE_GITHUB_INSTALLATION_ID: "456",
        USINE_GITHUB_PRIVATE_KEY_PATH: "app.pem",
        USINE_GITHUB_GIT_URL: "https://github.com/owner/repo.git",
      },
      {
        owner: "owner",
        name: "repo",
        implementerProfile: "writer-profile",
        reviewerProfile: "reviewer-profile",
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
});
