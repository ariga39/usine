import { describe, expect, test } from "vite-plus/test";
import { credentialFreeGitEnvironment } from "@usine/candidate-workspace";
import { approvalAttestationBody, ForgeDelivery } from "../src/index.js";
import type { TaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const contract = { id: "forge-module-test" } as TaskContract;

describe("Forge Delivery module", () => {
  test("attestation is bound to exact candidate SHA", () => {
    const body = approvalAttestationBody(
      contract,
      sha,
      { sha, status: "passed", command: "vp test", exitCode: 0, stdout: "", stderr: "" },
      { sha, verdict: "approved", summary: "ok", findings: [] },
    );
    expect(body).toContain(`usine-approval:${contract.id}:${sha}`);
    expect(body).toContain("Fresh reviewer verdict: `approved`");
  });

  test("fails closed before any effect without exact approval", async () => {
    const forge = new ForgeDelivery({
      repository: "/repo",
      deadlineEpochMs: Date.now() + 10_000,
      forge: {
        mode: "test",
        appSlug: "test-app",
        token: "test-token",
        apiUrl: "http://127.0.0.1:1",
        gitUrl: "http://127.0.0.1:1/owner/repo.git",
      },
      environment: credentialFreeGitEnvironment(process.env),
    });
    await expect(
      forge.deliver(
        contract,
        sha,
        { sha, status: "passed", command: "check", exitCode: 0, stdout: "", stderr: "" },
        { sha, verdict: "changes_requested", summary: "fix", findings: ["fix"] },
      ),
    ).rejects.toThrow("exact-SHA semantic approval");
  });
});
