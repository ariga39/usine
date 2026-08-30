import { access, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { startUsineServer } from "@usine/runtime";
import {
  originalTaskContract,
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
  forgeProfile: "default",
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
  expect(run.exitCode).toBe(7);
  expect(run.stderr).toContain("invalid_task_contract");
});

test("CLI keeps server validation distinct from usage", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "validation", message: "server rejected the request" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("validation fixture did not bind");
  try {
    const run = await execa("node", ["apps/cli/dist/cli.mjs", "task", "get", "task-id"], {
      env: { USINE_SERVER_URL: `http://127.0.0.1:${address.port}` },
      reject: false,
    });
    expect(run.exitCode).toBe(7);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: "validation", kind: "validation" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("CLI keeps server failures at exit code 6", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "server_failure", message: "server failed" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server failure fixture did not bind");
  try {
    const run = await execa("node", ["apps/cli/dist/cli.mjs", "task", "get", "task-id"], {
      env: { USINE_SERVER_URL: `http://127.0.0.1:${address.port}` },
      reject: false,
    });
    expect(run.exitCode).toBe(6);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: "server_failure", kind: "server" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("history diagnostics preserve Effect parser facts", async () => {
  const run = await execa(
    "node",
    ["apps/cli/dist/cli.mjs", "task", "history", "--after", "not-a-number", "task-id"],
    { reject: false },
  );
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stderr)).toMatchObject({
    error: "usage",
    commandPath: ["usine", "task", "history"],
    errors: [{ tag: "InvalidValue", message: expect.stringContaining("--after") }],
  });
});

test("Effect CLI owns unknown and missing argument diagnostics", async () => {
  const unknown = await execa(
    "node",
    ["apps/cli/dist/cli.mjs", "task", "get", "task-id", "--unknown"],
    { reject: false },
  );
  expect(unknown.exitCode).toBe(2);
  expect(JSON.parse(unknown.stderr)).toMatchObject({
    error: "usage",
    commandPath: ["usine", "task", "get"],
    errors: [{ tag: "UnrecognizedOption" }],
  });

  const missing = await execa("node", ["apps/cli/dist/cli.mjs", "task", "get", "--json"], {
    reject: false,
  });
  expect(missing.exitCode).toBe(2);
  expect(JSON.parse(missing.stderr)).toMatchObject({
    error: "usage",
    commandPath: ["usine", "task", "get"],
    errors: [{ tag: "MissingArgument" }],
  });
});

test("CLI distinguishes a server connection failure from usage and validation", async () => {
  const run = await execa("node", ["apps/cli/dist/cli.mjs", "task", "get", "missing"], {
    env: { USINE_SERVER_URL: "http://127.0.0.1:1" },
    reject: false,
  });
  expect(run.exitCode).toBe(5);
  expect(JSON.parse(run.stderr)).toMatchObject({
    error: "task_get_failed",
    kind: "connection",
  });
});

test("CLI classifies invalid local repository registration as validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const registrationPath = join(directory, "invalid-registration.json");
  await writeFile(registrationPath, "{");

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "register", registrationPath], {
    reject: false,
  });

  expect(run.exitCode).toBe(7);
  expect(JSON.parse(run.stderr)).toMatchObject({ error: "invalid_repository_registration" });
});

test("CLI preserves registration connection failures for valid local input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const registrationPath = join(directory, "registration.json");
  await writeFile(
    registrationPath,
    JSON.stringify({
      id: "unreachable-registration",
      path: directory,
      owner: "example",
      name: "unreachable-registration",
      baseBranch: "main",
      implementerProfile: "writer-profile",
      reviewerProfile: "reviewer-profile",
      forgeProfile: "default",
      projectCheck: { command: "true", timeoutMs: 1_000 },
      gitAuthor: { name: "Release Bot", email: "release@example.invalid" },
    }),
  );

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "register", registrationPath], {
    env: { USINE_SERVER_URL: "http://127.0.0.1:1" },
    reject: false,
  });

  expect(run.exitCode).toBe(5);
  expect(JSON.parse(run.stderr)).toMatchObject({ error: "register_failed", kind: "connection" });
});

test.each([
  ["task", "list", "--limit", "0"],
  ["repository", "list", "--limit", "201"],
  ["server", "snapshot", "--limit", "not-a-number"],
])("CLI validates bounded %s output locally", async (...args) => {
  const run = await execa("node", ["apps/cli/dist/cli.mjs", ...args], { reject: false });
  expect(run.exitCode).toBe(2);
  expect(JSON.parse(run.stderr)).toMatchObject({ error: "usage" });
});

test("server returns typed validation for invalid cursor and limit inputs", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "usine-server-validation-"));
  const server = await startUsineServer({
    environment: { USINE_STATE_DIR: stateDirectory },
    host: "127.0.0.1",
    port: 0,
  });
  try {
    for (const path of [
      "/v1/tasks?limit=0",
      "/v1/repositories?limit=201",
      "/v1/tasks/example/events?after=not-a-number",
      "/v1/events/wait?after=0",
      "/v1/events/subscribe?limit=1",
    ]) {
      const response = await fetch(new URL(path, server.url));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "validation" });
    }
  } finally {
    await server.close();
  }
});

test("legacy task watch reports a timeout with exit code 4", async () => {
  const taskId = "watch-timeout";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/events")) {
      response.end(JSON.stringify({ taskId, events: [], nextSequence: 0 }));
      return;
    }
    response.end(
      JSON.stringify({
        schemaVersion: 2,
        taskId,
        contractHash: "a".repeat(64),
        revision: 1,
        deadlineEpochMs: Date.now() + 30_000,
        state: "admitted",
        mergeAuthorized: false,
        candidateSha: null,
        candidateFence: null,
        check: null,
        review: null,
        delivery: null,
        blocker: null,
        activeActivation: 1,
        writer: { repositoryIdentity: "example/repository" },
        evidence: {
          implementerActivations: 1,
          reviewCycles: 0,
          changesRequestedBatches: 0,
          restartRecoveries: 0,
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("watch fixture did not bind");
  try {
    const run = await execa(
      "node",
      ["apps/cli/dist/cli.mjs", "task", "watch", taskId, "--timeout", "5"],
      {
        env: { USINE_SERVER_URL: `http://127.0.0.1:${address.port}` },
        reject: false,
      },
    );
    expect(run.exitCode).toBe(4);
    expect(JSON.parse(run.stderr)).toMatchObject({ error: "task_watch_failed", kind: "timeout" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

    expect(run.exitCode).toBe(7);
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

test("resolved host facts never enter the original Task Contract passed to a role", () => {
  const parsed = taskContractSchema.parse(contract());
  const resolved = resolveTaskContract(parsed, repository);
  expect(originalTaskContract(resolved)).toEqual(parsed);
  expect(originalTaskContract(resolved)).not.toHaveProperty("repository");
  expect(originalTaskContract(resolved)).not.toHaveProperty("projectCheck");
  expect(originalTaskContract(resolved)).not.toHaveProperty("delivery.baseBranch");
});

test("CLI rejects whitespace-only repository IDs before admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usine-cli-"));
  const path = join(directory, "invalid-repository-id.json");
  await writeFile(path, JSON.stringify(contract({ repositoryId: " \t\n " })));

  const run = await execa("node", ["apps/cli/dist/cli.mjs", "submit", path], { reject: false });

  expect(run.exitCode).toBe(7);
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

  expect(run.exitCode).toBe(7);
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
