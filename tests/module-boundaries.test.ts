import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { approvalAttestationBody } from "../packages/runtime/src/forge-delivery.js";
import type { TaskContract } from "@usine/task-authority";
import { ForgeDelivery } from "../packages/runtime/src/forge-delivery.js";
import { capabilityEnvironments } from "../packages/runtime/src/runtime-policy.js";

const sha = "a".repeat(40);
const contract = { id: "module-test" } as TaskContract;

describe("module contracts", () => {
  test("Forge Delivery attestation is bound to exact candidate SHA", () => {
    const body = approvalAttestationBody(
      contract,
      sha,
      { sha, status: "passed", command: "vp test", exitCode: 0, stdout: "", stderr: "" },
      { sha, verdict: "approved", summary: "ok", findings: [] },
    );
    expect(body).toContain(`usine-approval:${contract.id}:${sha}`);
    expect(body).toContain("Fresh reviewer verdict: `approved`");
  });

  test("Forge Delivery fails closed before any effect without exact approval", async () => {
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
      environment: capabilityEnvironments(process.env),
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

test("CLI keeps invalid contract input at the public parse boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid.json");
  await writeFile(path, "{}");
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], { reject: false });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain("invalid_task_contract");
});
