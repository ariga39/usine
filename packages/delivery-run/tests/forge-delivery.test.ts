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
  type ResolvedTaskContract,
} from "@usine/task-authority";
import type { WriterWorkspace } from "@usine/candidate-workspace";
import { ForgeDelivery } from "@usine/forge-delivery";
import { executeDeliveryRun, type DeliveryRunServices } from "../src/delivery-run.js";

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

function contract(id: string): ResolvedTaskContract {
  const parsed = taskContractSchema.parse({
    id,
    repositoryId: "repo",
    baseSha,
    instructions: "deliver the candidate",
    acceptance: ["the candidate is delivered"],
    nonGoals: [],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: { source: "https://github.com/owner/repo/issues/100", delivery: true },
    delivery: {
      branch: "agent/forge-e2e",
      issue: 100,
      title: "Forge delivery",
      body: "Forge delivery",
    },
  });
  return {
    ...parsed,
    repository: { path: ".", owner: "owner", name: "repo" },
    projectCheck: { command: "true", timeoutMs: 10_000 },
    delivery: { ...parsed.delivery, baseBranch: "main" },
  };
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
    environment: process.env,
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
      contract: { ...task, baseSha: fixture.actualBaseSha },
      contractHash: "forge-e2e-contract",
      repositoryIdentity: "owner/repo",
      deadlineEpochMs: Date.now() + 60_000,
      implementer: {
        role: "implementer" as const,
        profile: "implementer-profile",
        sandbox: "workspace-write" as const,
      },
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
            status: "completed" as const,
            output: { status: "proposed" as const, summary: "candidate" },
            summary: "completed",
            failure: null,
          }),
        },
        quality: {
          check: async (_contract: ResolvedTaskContract, sha: string) => ({
            sha,
            status: "passed" as const,
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
          reviewWithObservation: async (_contract: ResolvedTaskContract, sha: string) => ({
            review: {
              sha,
              verdict: "approved" as const,
              summary: "approved",
              findings: [],
            },
            usage: null,
          }),
        },
        forge: forge(fixture.repository, apiUrl, fixture.remote),
      });

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
    const task = { ...contract("forge-closed-public"), baseSha: fixture.actualBaseSha };
    const databasePath = join(fixture.root, "state.sqlite");
    await applyMigrations(databasePath);
    const database = openSqliteDatabase(databasePath);
    const authority = new TaskAuthority(database.database);
    const input = {
      contract: task,
      contractHash: "forge-closed-public-contract",
      repositoryIdentity: "owner/repo",
      deadlineEpochMs: Date.now() + 60_000,
      implementer: {
        role: "implementer" as const,
        profile: "implementer-profile",
        sandbox: "workspace-write" as const,
      },
    };
    const admitted = await authority.admit({
      contract: task,
      contractHash: input.contractHash,
      repositoryIdentity: input.repositoryIdentity,
      deadlineEpochMs: input.deadlineEpochMs,
    });
    const activation = await authority.reserveActivation(task.id, 1);
    const candidate = await authority.recordCandidate(
      { taskId: admitted.taskId, revision: activation.result.revision },
      {
        sha: fixture.candidateSha,
        baseSha: fixture.actualBaseSha,
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
      const services: DeliveryRunServices = {
        authority,
        workspace: {
          quarantinePriorWriters: async () => {
            throw new Error("terminal task must not quarantine writers");
          },
          prepareWriter: async () => {
            throw new Error("terminal task must not prepare a writer");
          },
          freeze: async () => {
            throw new Error("terminal task must not freeze a candidate");
          },
          quarantine: async () => {
            throw new Error("terminal task must not quarantine a workspace");
          },
        },
        session: {
          run: async () => {
            throw new Error("terminal task must not start a session");
          },
        },
        quality: {
          check: async () => {
            throw new Error("terminal task must not check");
          },
          reviewWithObservation: async () => {
            throw new Error("terminal task must not review");
          },
        },
        forge: forgeDelivery,
      };
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
});
