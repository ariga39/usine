import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  applyMigrations,
  openSqliteDatabase,
  TaskAuthority,
  taskContractSchema,
  type TaskContract,
} from "@usine/task-authority";
import { executeDeliveryRun } from "../packages/runtime/src/delivery-run.js";
import type { WriterWorkspace } from "@usine/candidate-workspace";
import { approvalAttestationBody, ForgeDelivery } from "../packages/runtime/src/forge-delivery.js";
import { capabilityEnvironments } from "../packages/runtime/src/runtime-policy.js";

const baseSha = "a".repeat(40);

type Comment = {
  id: number;
  body: string;
  performed_via_github_app?: { slug?: string };
  user?: { type?: string };
};

type PullRequest = {
  number: number;
  state: "open" | "closed";
  head: { sha: string };
  html_url: string;
};

type ForgeServerState = {
  candidateSha: string;
  headSha: string | null;
  pullRequests: PullRequest[];
  comments: Comment[];
  failAfterPullRequestCreate: boolean;
  failAfterCommentCreate: boolean;
  pullRequestCreates: number;
  commentCreates: number;
  requests: string[];
};

function contract(id: string): TaskContract {
  return taskContractSchema.parse({
    id,
    repository: { path: ".", owner: "owner", name: "repo" },
    baseSha,
    instructions: "deliver the candidate",
    acceptance: ["the candidate is delivered"],
    nonGoals: [],
    projectCheck: { command: "true", timeoutMs: 10_000 },
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: { source: "Issue #100", delivery: true },
    delivery: {
      baseBranch: "main",
      branch: "agent/forge-e2e",
      issue: 100,
      title: "Forge delivery",
      body: "Forge delivery",
    },
  });
}

function controlledFetch(state: ForgeServerState): typeof fetch {
  return async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestUrl);
    const pathname = decodeURIComponent(url.pathname);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    state.requests.push(`${method} ${pathname}${url.search}`);
    if (headers.get("authorization") !== "token test-token")
      return Response.json({ message: "bad credentials" }, { status: 401 });

    if (method === "GET" && pathname.endsWith("/git/ref/heads/agent/forge-e2e")) {
      return state.headSha
        ? Response.json({ object: { sha: state.headSha } })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (method === "GET" && pathname === "/repos/owner/repo/pulls")
      return Response.json(state.pullRequests);
    if (method === "POST" && pathname === "/repos/owner/repo/pulls") {
      const inputBody = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
        head: string;
      };
      state.headSha = state.candidateSha;
      const pullRequest: PullRequest = {
        number: 1,
        state: "open",
        head: { sha: state.headSha },
        html_url: "http://example.invalid/pull/1",
      };
      expect(inputBody.head).toBe("agent/forge-e2e");
      state.pullRequests.push(pullRequest);
      state.pullRequestCreates += 1;
      if (state.failAfterPullRequestCreate) {
        state.failAfterPullRequestCreate = false;
        throw new TypeError("response lost after pull request creation");
      }
      return Response.json(pullRequest, { status: 201 });
    }
    if (pathname === "/repos/owner/repo/issues/1/comments") {
      if (method === "GET") return Response.json(state.comments);
      if (method === "POST") {
        const inputBody = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
          body: string;
        };
        const comment: Comment = {
          id: 7,
          body: inputBody.body,
          performed_via_github_app: { slug: "usine-app" },
          user: { type: "Bot" },
        };
        state.comments.push(comment);
        state.commentCreates += 1;
        if (state.failAfterCommentCreate) {
          state.failAfterCommentCreate = false;
          throw new TypeError("response lost after attestation creation");
        }
        return Response.json(comment, { status: 201 });
      }
    }
    return Response.json({ message: `unhandled ${method} ${pathname}` }, { status: 404 });
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "usine-forge-e2e-"));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  await mkdir(repository);
  await execa("git", ["init", "--initial-branch=main"], { cwd: repository });
  await execa("git", ["config", "user.name", "Test"], { cwd: repository });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await writeFile(join(repository, "base.txt"), "base\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "base"], { cwd: repository });
  const actualBaseSha = await git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "candidate.txt"), "candidate\n");
  await execa("git", ["add", "."], { cwd: repository });
  await execa("git", ["commit", "-m", "candidate"], { cwd: repository });
  const candidateSha = await git(repository, "rev-parse", "HEAD");

  await execa("git", ["init", "--bare", remote]);
  const hook = join(remote, "hooks", "update");
  await writeFile(
    hook,
    '#!/bin/sh\ncount_file="$GIT_DIR/update-count"\ncount=$(cat "$count_file" 2>/dev/null || printf 0)\nprintf "%s\\n" $((count + 1)) > "$count_file"\n',
  );
  await chmod(hook, 0o755);
  return { root, repository, remote, actualBaseSha, candidateSha };
}

function forge(repository: string, apiUrl: string, gitUrl: string): ForgeDelivery {
  return new ForgeDelivery({
    repository,
    deadlineEpochMs: Date.now() + 60_000,
    forge: {
      mode: "test",
      appSlug: "usine-app",
      token: "test-token",
      apiUrl,
      gitUrl,
    },
    environment: capabilityEnvironments(process.env),
  });
}

const passingCheck = {
  sha: "",
  status: "passed" as const,
  command: "true",
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const approvedReview = {
  sha: "",
  verdict: "approved" as const,
  summary: "approved",
  findings: [],
};

async function withControlledFetch<T>(
  state: ForgeServerState,
  action: (apiUrl: string) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = controlledFetch(state);
  try {
    return await action("http://127.0.0.1:8787");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe.sequential("Forge Delivery controlled protocol", () => {
  test("drives Delivery Run from durable candidate/check/review facts through one branch, PR, and attestation", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: null,
      pullRequests: [],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const apiUrl = "http://127.0.0.1:8787";
    const databasePath = join(fixture.root, "state.sqlite");
    await applyMigrations(databasePath);
    const database = openSqliteDatabase(databasePath);
    const authority = new TaskAuthority(database.database);
    const task = contract("forge-e2e");
    const input = {
      contract: taskContractSchema.parse({ ...task, baseSha: fixture.actualBaseSha }),
      contractHash: "forge-e2e-contract",
      repository: fixture.repository,
      repositoryIdentity: "owner/repo",
      deadlineEpochMs: Date.now() + 60_000,
      implementer: {
        role: "implementer" as const,
        model: "test",
        reasoningEffort: "high",
        sandbox: "workspace-write" as const,
      },
      environments: capabilityEnvironments(process.env),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = controlledFetch(state);
    try {
      const result = await executeDeliveryRun(input, {
        authority,
        workspace: {
          quarantinePriorWriters: async () => undefined,
          prepareWriter: async (_taskId: string, activation: number, parent: string) => ({
            taskId: input.contract.id,
            activation,
            fence: activation,
            path: fixture.repository,
            baseSha: parent,
          }),
          freeze: async (writer: WriterWorkspace) => ({
            sha: fixture.candidateSha,
            baseSha: writer.baseSha,
            workspace: writer,
          }),
          quarantine: async () => undefined,
        },
        session: {
          run: async () => ({
            status: "completed",
            output: { status: "proposed", summary: "candidate" },
          }),
        },
        quality: {
          check: async (_contract: TaskContract, sha: string) => ({
            sha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
          review: async (_contract: TaskContract, sha: string) => ({
            sha,
            verdict: "approved" as const,
            summary: "approved",
            findings: [],
          }),
        },
        forge: forge(fixture.repository, apiUrl, fixture.remote),
      } as never);

      expect(result).toMatchObject({
        state: "reviewed_pr",
        candidateSha: fixture.candidateSha,
        delivery: { prNumber: 1, attestationId: "7", sha: fixture.candidateSha },
      });
      expect(await git(fixture.remote, "rev-parse", "refs/heads/agent/forge-e2e")).toBe(
        fixture.candidateSha,
      );
      expect(await readFile(join(fixture.remote, "update-count"), "utf8")).toBe("1\n");
      expect(state.pullRequestCreates).toBe(1);
      expect(state.commentCreates).toBe(1);
      expect(
        state.requests.some((request) => request.startsWith("GET /repos/owner/repo/git/ref/")),
      ).toBe(true);
      expect(
        state.requests.some((request) => request.startsWith("POST /repos/owner/repo/pulls")),
      ).toBe(true);
      expect(
        state.requests.some((request) =>
          request.startsWith("POST /repos/owner/repo/issues/1/comments"),
        ),
      ).toBe(true);
      expect(state.comments[0]?.body).toContain(
        `usine-approval:${input.contract.id}:${fixture.candidateSha}`,
      );
      expect((await authority.lookupExisting(input.contract.id, input.contractHash))?.state).toBe(
        "reviewed_pr",
      );
    } finally {
      database.close();
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("reconciles lost PR and attestation responses without duplicate effects", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: null,
      pullRequests: [],
      comments: [],
      failAfterPullRequestCreate: true,
      failAfterCommentCreate: true,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const task = contract("forge-recovery");
    const check = { ...passingCheck, sha: fixture.candidateSha };
    const review = { ...approvedReview, sha: fixture.candidateSha };

    await withControlledFetch(state, async (apiUrl) => {
      const result = await forge(fixture.repository, apiUrl, fixture.remote).deliver(
        task,
        fixture.candidateSha,
        check,
        review,
      );
      expect(result).toMatchObject({ sha: fixture.candidateSha, prNumber: 1, attestationId: "7" });
    });

    expect(await git(fixture.remote, "rev-parse", "refs/heads/agent/forge-e2e")).toBe(
      fixture.candidateSha,
    );
    expect(await readFile(join(fixture.remote, "update-count"), "utf8")).toBe("1\n");
    expect(state.pullRequestCreates).toBe(1);
    expect(state.commentCreates).toBe(1);
  }, 30_000);

  test("quarantines a conflicting branch head before any Git update", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: "c".repeat(40),
      pullRequests: [],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const task = contract("forge-conflict");
    await expect(
      withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          task,
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("conflicting head");
    await expect(readFile(join(fixture.remote, "update-count"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("quarantines a closed PR that already targets the approved candidate", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      pullRequests: [
        {
          number: 1,
          state: "closed",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    await expect(
      withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          contract("forge-closed"),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("closed delivery PR");
  });

  test("durably quarantines a closed PR before creating a missing branch", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: null,
      pullRequests: [
        {
          number: 1,
          state: "closed",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const task = taskContractSchema.parse({
      ...contract("forge-closed-public"),
      baseSha: fixture.actualBaseSha,
    });
    const databasePath = join(fixture.root, "state.sqlite");
    await applyMigrations(databasePath);
    const database = openSqliteDatabase(databasePath);
    const authority = new TaskAuthority(database.database);
    const input = {
      contract: task,
      contractHash: "forge-closed-public-contract",
      repository: fixture.repository,
      repositoryIdentity: "owner/repo",
      deadlineEpochMs: Date.now() + 60_000,
      implementer: {
        role: "implementer" as const,
        model: "test",
        reasoningEffort: "high",
        sandbox: "workspace-write" as const,
      },
      environments: capabilityEnvironments(process.env),
    };
    const admitted = await authority.admit({
      contract: task,
      contractHash: input.contractHash,
      repository: fixture.repository,
      repositoryIdentity: input.repositoryIdentity,
      deadlineEpochMs: input.deadlineEpochMs,
    });
    const activation = await authority.reserveActivation(task.id, 1);
    const candidate = await authority.recordCandidate(
      { taskId: admitted.taskId, revision: activation.result.revision },
      {
        sha: fixture.candidateSha,
        baseSha: fixture.actualBaseSha,
        generation: admitted.writer.generation,
        fence: activation.activation,
      },
    );
    const checked = await authority.recordCheck(
      { taskId: candidate.taskId, revision: candidate.revision },
      { ...passingCheck, sha: fixture.candidateSha },
    );
    const reviewed = await authority.recordReview(
      { taskId: checked.taskId, revision: checked.revision },
      { ...approvedReview, sha: fixture.candidateSha },
    );
    expect(reviewed.state).toBe("reviewed");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = controlledFetch(state);
    try {
      const forgeDelivery = forge(fixture.repository, "http://127.0.0.1:8787", fixture.remote);
      const services = {
        authority,
        workspace: {},
        session: {},
        quality: {},
        forge: forgeDelivery,
      } as never;
      const result = await executeDeliveryRun(input, services);

      expect(result.state).toBe("blocked");
      expect(result.blocker).toContain("closed delivery PR");
      await expect(readFile(join(fixture.remote, "update-count"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const requestsAfterFirstRun = state.requests.length;
      const restarted = await executeDeliveryRun(input, services);
      expect(restarted).toEqual(result);
      expect(state.requests).toHaveLength(requestsAfterFirstRun);
    } finally {
      database.close();
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("quarantines duplicate matching PRs without creating another PR", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      pullRequests: [
        {
          number: 1,
          state: "open",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
        },
        {
          number: 2,
          state: "open",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/2",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };

    await expect(
      withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          contract("forge-duplicate-pr"),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("multiple delivery PRs");
    expect(state.pullRequestCreates).toBe(0);
    expect(state.commentCreates).toBe(0);
  });

  test("quarantines an open PR with a conflicting head instead of creating another PR", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      pullRequests: [
        {
          number: 1,
          state: "open",
          head: { sha: "d".repeat(40) },
          html_url: "http://example.invalid/pull/1",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };

    await expect(
      withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          contract("forge-pr-conflict"),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("conflicting head");
    expect(state.pullRequestCreates).toBe(0);
  });

  test("quarantines a marker-matching attestation with the wrong App/Bot identity", async () => {
    const fixture = await repositoryFixture();
    const task = contract("forge-identity");
    const check = { ...passingCheck, sha: fixture.candidateSha };
    const review = { ...approvedReview, sha: fixture.candidateSha };
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      pullRequests: [
        {
          number: 1,
          state: "open",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
        },
      ],
      comments: [
        {
          id: 8,
          body: approvalAttestationBody(task, fixture.candidateSha, check, review),
          performed_via_github_app: { slug: "different-app" },
          user: { type: "Bot" },
        },
      ],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };

    await expect(
      withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          task,
          fixture.candidateSha,
          check,
          review,
        ),
      ),
    ).rejects.toThrow("App/Bot");
    expect(state.commentCreates).toBe(0);
  });
});
