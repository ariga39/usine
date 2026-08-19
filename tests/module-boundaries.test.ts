import { access, writeFile, mkdtemp } from "node:fs/promises";
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

test.each([
  { name: "missing", omitSource: true },
  { name: "malformed", source: "github.com/example/usine/issues/1" },
  { name: "non-GitHub", source: "https://gitlab.com/example/usine/-/issues/1" },
  { name: "pull-request", source: "https://github.com/example/usine/pull/1" },
  { name: "query", source: "https://github.com/example/usine/issues/1?tab=comments" },
  { name: "fragment", source: "https://github.com/example/usine/issues/1#discussion" },
  { name: "repository mismatch", source: "https://github.com/other/usine/issues/1" },
  { name: "issue mismatch", source: "https://github.com/example/usine/issues/2" },
])("CLI rejects $name authorization source before admission", async ({ omitSource, source }) => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid-authorization-source.json");
  const stateDirectory = join(directory, "state");
  const contract = {
    id: "cli-authorization-source-test",
    repository: { path: ".", owner: "example", name: "usine" },
    baseSha: "a".repeat(40),
    instructions: "Validate authorization source handling.",
    acceptance: ["Authorization source mismatches are rejected before admission."],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 1_000 },
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
    authorization: omitSource ? { delivery: true } : { source, delivery: true },
    delivery: {
      baseBranch: "main",
      branch: "agent/cli-authorization-source-test",
      issue: 1,
      title: "Contract test",
      body: "Contract test",
    },
  };
  await writeFile(path, JSON.stringify(contract));

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], {
    env: { USINE_STATE_DIR: stateDirectory },
    reject: false,
  });

  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('"error":"invalid_task_contract"');
  expect(run.stderr).toContain('"path":"authorization.source"');
  await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
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
      authorization: { source: "https://github.com/example/usine/issues/1", delivery: true },
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

test.each([{ field: "baseBranch" as const }, { field: "branch" as const }])(
  "CLI rejects whitespace-only delivery $field before admission",
  async ({ field }) => {
    const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
    const path = join(directory, "invalid-delivery-branch.json");
    const stateDirectory = join(directory, "state");
    const contract = {
      id: "cli-delivery-branch-test",
      repository: { path: ".", owner: "example", name: "usine" },
      baseSha: "a".repeat(40),
      instructions: "Validate delivery branch handling.",
      acceptance: ["Whitespace-only delivery branch values are rejected."],
      nonGoals: [],
      projectCheck: { command: "true", timeoutMs: 1_000 },
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
      authorization: { source: "https://github.com/example/usine/issues/1", delivery: true },
      delivery: {
        baseBranch: "main",
        branch: "agent/cli-delivery-branch-test",
        issue: 1,
        title: "Contract test",
        body: "Contract test",
      },
    };
    contract.delivery[field] = " \t\n ";
    await writeFile(path, JSON.stringify(contract));

    const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", path], {
      env: { USINE_STATE_DIR: stateDirectory },
      reject: false,
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('"error":"invalid_task_contract"');
    expect(run.stderr).toContain(`"path":"delivery.${field}"`);
    await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
