import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";

test("CLI keeps invalid contract input at the public parse boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid.json");
  await writeFile(path, "{}");
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], { reject: false });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain("invalid_task_contract");
});

test.each([{ field: "owner" as const }, { field: "name" as const }])(
  "CLI rejects whitespace-only repository $field before admission",
  async ({ field }) => {
    const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
    const path = join(directory, "invalid-repository-identity.json");
    const contract = {
      id: "cli-contract-test",
      repository: { path: ".", owner: "example", name: "usine" },
      baseSha: "a".repeat(40),
      instructions: "Validate repository identity handling.",
      acceptance: ["Whitespace-only repository identity is rejected."],
      nonGoals: [],
      projectCheck: { command: "true", timeoutMs: 1_000 },
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
      authorization: { source: "test", delivery: true },
      delivery: {
        baseBranch: "main",
        branch: "agent/cli-contract-test",
        issue: 1,
        title: "Contract test",
        body: "Contract test",
      },
    };
    contract.repository[field] = " \t\n ";
    await writeFile(path, JSON.stringify(contract));

    const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], { reject: false });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('"error":"invalid_task_contract"');
    expect(run.stderr).toContain(`"path":"repository.${field}"`);
  },
);
