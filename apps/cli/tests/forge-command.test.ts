import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

const runtime = { forgeReadinessFromEnvironment: vi.fn() };
let runForgeReadinessCommand: typeof import("../src/forge-command.js").runForgeReadinessCommand;

const registration = {
  id: "repo",
  path: "/private/repository",
  owner: "owner",
  name: "repo",
  baseBranch: "main",
  implementerProfile: "implementer",
  reviewerProfile: "reviewer",
  forgeProfile: "release",
  githubReadProfile: null,
  projectCheck: { command: "true", timeoutMs: 1_000 },
  gitAuthor: { name: "Usine", email: "usine@example.invalid" },
};

describe("forge readiness CLI entry path", () => {
  beforeAll(async () => {
    vi.doMock("@usine/runtime", () => runtime);
    runForgeReadinessCommand = (await import("../src/forge-command.js")).runForgeReadinessCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.forgeReadinessFromEnvironment.mockReset();
    process.exitCode = undefined;
  });

  test("prints explicit success from the shared readiness result", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-forge-cli-"));
    const registrationPath = join(root, "repository.json");
    await writeFile(registrationPath, JSON.stringify(registration));
    runtime.forgeReadinessFromEnvironment.mockResolvedValue({
      ready: true,
      appSlug: "forge-app",
      installationId: 42,
      repository: "owner/repo",
      permissions: { contents: "write", pullRequests: "write", issues: "write" },
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runForgeReadinessCommand({ registrationPath, json: true }, {});

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ ready: true });
  });

  test("returns bounded expected-versus-observed failure without secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "usine-forge-cli-"));
    const registrationPath = join(root, "repository.json");
    await writeFile(registrationPath, JSON.stringify(registration));
    runtime.forgeReadinessFromEnvironment.mockResolvedValue({
      ready: false,
      code: "authentication_failed",
      expected: "authenticated access from the configured Forge App installation",
      observed: "GitHub rejected the Forge installation authentication",
      action:
        "Check the App ID, installation ID, private key, and App installation, then rerun readiness.",
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runForgeReadinessCommand(
      { registrationPath, json: true },
      {
        USINE_FORGE_PROFILE_RELEASE_PRIVATE_KEY_PATH: "private-key-secret-path",
      },
    );

    const diagnostic = JSON.parse(String(stderr.mock.calls[0]?.[0]));
    expect(diagnostic).toMatchObject({
      error: "forge_not_ready",
      code: "authentication_failed",
      expected: expect.any(String),
      observed: expect.any(String),
      action: expect.any(String),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-key-secret-path");
    expect(process.exitCode).toBe(7);
  });
});
