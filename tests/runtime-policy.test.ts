import { describe, expect, test } from "vite-plus/test";
import { runtimePolicyFromEnvironment } from "../packages/runtime/src/runtime.js";

describe("runtime composition", () => {
  test("validates deployment inputs once and derives capability-safe values", () => {
    const policy = runtimePolicyFromEnvironment(
      {
        PATH: "/portable/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "coordinator-secret",
        GITHUB_TOKEN: "delivery-secret",
        USINE_STATE_DIR: "/state",
        USINE_GIT_AUTHOR_NAME: "Release Bot",
        USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
        USINE_IMPLEMENTER_MODEL: "implementer-model",
        USINE_REVIEWER_MODEL: "reviewer-model",
        USINE_REVIEWER_REASONING_EFFORT: "medium",
        USINE_GITHUB_APP_SLUG: "usine-app",
        USINE_GITHUB_TEST_TOKEN: "test-token",
        USINE_GITHUB_API_URL: "http://127.0.0.1:8787",
        USINE_GITHUB_GIT_URL: "http://127.0.0.1:8787/owner/repo.git",
      },
      { owner: "owner", name: "repo" },
    );

    expect(policy).toMatchObject({
      stateDirectory: "/state",
      stopAfterAdmitted: false,
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
      roles: {
        implementer: {
          role: "implementer",
          model: "implementer-model",
          reasoningEffort: "high",
          sandbox: "workspace-write",
        },
        reviewer: {
          role: "reviewer",
          model: "reviewer-model",
          reasoningEffort: "medium",
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
    expect(policy.capabilities.worker).toMatchObject({ CI: "true", PATH: "/portable/bin" });
    expect(policy.capabilities.worker).not.toHaveProperty("OPENAI_API_KEY");
    expect(policy.capabilities.worker).not.toHaveProperty("GITHUB_TOKEN");
    expect(policy.capabilities.check).toEqual(policy.capabilities.worker);
    expect(policy.capabilities.credentialFreeGit).toMatchObject({
      PATH: "/portable/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test.each([
    ["name", { USINE_GIT_AUTHOR_NAME: "", USINE_GIT_AUTHOR_EMAIL: "release@example.invalid" }],
    ["email", { USINE_GIT_AUTHOR_NAME: "Release Bot", USINE_GIT_AUTHOR_EMAIL: "   " }],
  ])("rejects a blank Git author %s before activation", (_field, identity) => {
    expect(() => runtimePolicyFromEnvironment(identity, { owner: "owner", name: "repo" })).toThrow(
      /USINE_GIT_AUTHOR_(NAME|EMAIL)/,
    );
  });

  test("rejects test forge credentials outside loopback", () => {
    expect(() =>
      runtimePolicyFromEnvironment(
        {
          USINE_GIT_AUTHOR_NAME: "Release Bot",
          USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
          USINE_GITHUB_APP_SLUG: "usine-app",
          USINE_GITHUB_TEST_TOKEN: "test-token",
          USINE_GITHUB_API_URL: "https://github.com",
        },
        { owner: "owner", name: "repo" },
      ),
    ).toThrow("loopback");
  });

  test("retains the production GitHub App authentication policy without test credentials", () => {
    const policy = runtimePolicyFromEnvironment(
      {
        USINE_GIT_AUTHOR_NAME: "Release Bot",
        USINE_GIT_AUTHOR_EMAIL: "release@example.invalid",
        USINE_GITHUB_APP_SLUG: "usine-app",
        USINE_GITHUB_APP_ID: "123",
        USINE_GITHUB_INSTALLATION_ID: "456",
        USINE_GITHUB_PRIVATE_KEY_PATH: "app.pem",
        USINE_GITHUB_GIT_URL: "https://github.com/owner/repo.git",
      },
      { owner: "owner", name: "repo" },
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
