import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import {
  resolveTaskContract,
  taskContractSchema,
  type RepositorySnapshot,
  type TaskContract,
} from "@usine/task-authority";

const repository: RepositorySnapshot = {
  id: "registered-repository",
  path: "/registered/repository",
  owner: "example",
  name: "usine",
  baseBranch: "main",
  implementerProfile: "writer-profile",
  reviewerProfile: "reviewer-profile",
  projectCheck: { command: "true", timeoutMs: 1_000 },
  gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
};

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: "module-boundary-test",
    repositoryId: repository.id,
    baseSha: "a".repeat(40),
    instructions: "Validate the public contract boundary.",
    acceptance: ["The contract contains only caller-owned task facts."],
    nonGoals: [],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
    authorization: {
      source: "https://github.com/example/usine/issues/1",
      delivery: true,
    },
    delivery: {
      branch: "agent/module-boundary-test",
      issue: 1,
      title: "Contract test",
      body: "Contract test",
    },
    ...overrides,
  };
}

test("CLI keeps invalid contract input at the public parse boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid.json");
  await writeFile(path, "{}");
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "submit", path], { reject: false });
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
  { name: "issue mismatch", source: "https://github.com/example/usine/issues/2" },
])(
  "CLI rejects malformed $name authorization source before admission",
  async ({ omitSource, source }) => {
    const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
    const path = join(directory, "invalid-authorization-source.json");
    const input = {
      ...contract(),
      authorization: omitSource ? { delivery: true } : { source: source ?? "", delivery: true },
    };
    await writeFile(path, JSON.stringify(input));

    const run = await execa("node", ["apps/cli/dist/cli.mjs", "submit", path], {
      env: { USINE_STATE_DIR: join(directory, "state") },
      reject: false,
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('"error":"invalid_task_contract"');
    expect(run.stderr).toContain('"path":"authorization.source"');
    await expect(access(join(directory, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([["repository mismatch", "https://github.com/other/usine/issues/1"]])(
  "admission owns authorization-source matching: %s",
  (_name, source) => {
    const parsed = taskContractSchema.parse(
      contract({ authorization: { source, delivery: true } }),
    );
    expect(() => resolveTaskContract(parsed, repository)).toThrow(
      "task authorization does not match the registered repository",
    );
  },
);

test("CLI rejects whitespace-only repository IDs before admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid-repository-id.json");
  await writeFile(path, JSON.stringify(contract({ repositoryId: " \t\n " })));

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "submit", path], { reject: false });

  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('"error":"invalid_task_contract"');
  expect(run.stderr).toContain('"path":"repositoryId"');
});

test("CLI rejects whitespace-only delivery branches before admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid-delivery-branch.json");
  await writeFile(
    path,
    JSON.stringify(contract({ delivery: { ...contract().delivery, branch: " \t\n " } })),
  );

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "submit", path], {
    env: { USINE_STATE_DIR: join(directory, "state") },
    reject: false,
  });

  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('"error":"invalid_task_contract"');
  expect(run.stderr).toContain('"path":"delivery.branch"');
  await expect(access(join(directory, "state"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("CLI does not retain the removed one-shot run command", async () => {
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "run", "task.json"], {
    reject: false,
  });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('"error":"usage"');
});
