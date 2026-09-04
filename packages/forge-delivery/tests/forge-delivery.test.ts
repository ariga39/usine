import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import {
  approvalAttestationBody,
  ForgeDelivery,
  ForgeDeliveryReconciliationError,
  forgeGitEnvironment,
} from "../src/index.js";
import { taskContractSchema, type ResolvedTaskContract } from "@usine/task-authority";

const sha = "a".repeat(40);
const simpleContract = {
  id: "forge-module-test",
  repositoryId: "repo",
  repository: { path: "/repo", owner: "owner", name: "repo" },
  baseSha: sha,
  instructions: "test",
  acceptance: ["test"],
  nonGoals: [],
  projectCheck: { command: "true", timeoutMs: 10_000 },
  budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 10_000 },
  authorization: { source: "https://github.com/owner/repo/issues/100", delivery: true },
  delivery: {
    baseBranch: "main",
    branch: "agent/test",
    issue: 100,
    title: "test",
    body: "test",
  },
} satisfies ResolvedTaskContract;

describe("Forge Delivery module", () => {
  test("attestation is bound to exact candidate SHA", () => {
    const body = approvalAttestationBody(
      simpleContract,
      sha,
      { sha, status: "passed", command: "vp test", exitCode: 0, stdout: "", stderr: "" },
      { sha, verdict: "approved", summary: "ok", findings: [] },
    );
    expect(body).toContain(`usine-approval:${simpleContract.id}:${sha}`);
    expect(body).toContain(`- Task: \`${simpleContract.id}\``);
    expect(body).toContain("- Project check: `passed`");
    expect(body).toContain("Fresh reviewer verdict: `approved`");
  });

  test("attestation omits untrusted contract, check, and review content", () => {
    const sentinels = {
      localPath: "excluded-local-path-value",
      machineUser: "excluded-machine-identity-value",
      privateTarget: "excluded-private-target-value",
      credential: "excluded-credential-value",
    };
    const excludedContent = Object.values(sentinels).join(" ");
    const unsafeContract: ResolvedTaskContract = {
      ...simpleContract,
      repository: { ...simpleContract.repository, path: sentinels.localPath },
      projectCheck: { ...simpleContract.projectCheck, command: excludedContent },
      instructions: excludedContent,
      acceptance: [excludedContent],
      nonGoals: [excludedContent],
      delivery: {
        ...simpleContract.delivery,
        title: excludedContent,
        body: excludedContent,
      },
    };
    const body = approvalAttestationBody(
      unsafeContract,
      sha,
      {
        sha,
        status: "passed",
        command: excludedContent,
        exitCode: 0,
        stdout: excludedContent,
        stderr: excludedContent,
      },
      {
        sha,
        verdict: "approved",
        summary: excludedContent,
        findings: [excludedContent],
      },
    );

    for (const sentinel of Object.values(sentinels)) expect(body).not.toContain(sentinel);
  });

  test("fails closed before any effect without exact approval", async () => {
    const delivery = new ForgeDelivery({
      repository: "/repo",
      deadlineEpochMs: Date.now() + 10_000,
      forge: {
        mode: "test",
        appSlug: "test-app",
        token: "test-token",
        apiUrl: "http://127.0.0.1:1",
        gitUrl: "http://127.0.0.1:1/owner/repo.git",
      },
      environment: process.env,
    });
    await expect(
      delivery.deliver(
        simpleContract,
        sha,
        { sha, status: "passed", command: "check", exitCode: 0, stdout: "", stderr: "" },
        { sha, verdict: "changes_requested", summary: "fix", findings: ["fix"] },
      ),
    ).rejects.toThrow("exact-SHA semantic approval");
  });

  test("emits one typed reconciliation signal after bounded unresolved transport failures", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new TypeError("provider response details stay at the Forge boundary");
    };
    try {
      await expect(
        new ForgeDelivery({
          repository: "/repo",
          deadlineEpochMs: Date.now() + 10_000,
          forge: {
            mode: "test",
            appSlug: "test-app",
            token: "test-token",
            apiUrl: "http://127.0.0.1:1",
            gitUrl: "http://127.0.0.1:1/owner/repo.git",
          },
          environment: process.env,
        }).deliver(
          simpleContract,
          sha,
          { sha, status: "passed", command: "check", exitCode: 0, stdout: "", stderr: "" },
          { sha, verdict: "approved", summary: "approved", findings: [] },
        ),
      ).rejects.toBeInstanceOf(ForgeDeliveryReconciliationError);
      expect(attempts).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("leaves a definite 4xx refusal outside the reconciliation signal", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ message: "definite refusal" }, { status: 400 });
    try {
      await expect(
        new ForgeDelivery({
          repository: "/repo",
          deadlineEpochMs: Date.now() + 10_000,
          forge: {
            mode: "test",
            appSlug: "test-app",
            token: "test-token",
            apiUrl: "http://127.0.0.1:1",
            gitUrl: "http://127.0.0.1:1/owner/repo.git",
          },
          environment: process.env,
        }).deliver(
          simpleContract,
          sha,
          { sha, status: "passed", command: "check", exitCode: 0, stdout: "", stderr: "" },
          { sha, verdict: "approved", summary: "approved", findings: [] },
        ),
      ).rejects.not.toBeInstanceOf(ForgeDeliveryReconciliationError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sanitizes Git credentials before adding the GitHub auth header", () => {
    const env = forgeGitEnvironment(
      {
        PATH: "/portable/bin",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        NPM_TOKEN: "package-secret",
        GITHUB_TOKEN: "unrelated-secret",
      },
      "test-token",
      "https://github.com/owner/repo.git",
    );
    expect(env).toMatchObject({
      PATH: "/portable/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
    });
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:test-token").toString("base64")}`,
    );
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("NPM_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });
});

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
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
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
  mergeCalls?: number;
  failAfterMerge?: boolean;
  mergeResponseSha?: "missing" | "malformed";
  mergeRefusal?: string;
  authoritativeHeadSha?: string;
  lastPullRequest?: { title: string; body: string };
  requests: string[];
};

function contract(id: string, merge = false): ResolvedTaskContract {
  const parsed = taskContractSchema.parse({
    id,
    repositoryId: "repo",
    baseSha: "a".repeat(40),
    instructions: "deliver the candidate",
    acceptance: ["the candidate is delivered"],
    nonGoals: [],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
    authorization: {
      source: "https://github.com/owner/repo/issues/100",
      delivery: true,
      ...(merge ? { merge: true } : {}),
    },
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

function campaignContract(id: string): ResolvedTaskContract {
  const standalone = contract(id);
  const { issue: _issue, ...delivery } = standalone.delivery;
  return {
    ...standalone,
    authorization: { source: "campaign:campaign-367", delivery: true },
    delivery,
    campaign: {
      campaignId: "campaign-367:v1",
      goalId: "campaign-367",
      goalVersion: 1,
      outcomeId: "outcome-one",
    },
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
    if (method === "GET" && pathname === "/repos/owner/repo/pulls/1") {
      const pullRequest = state.pullRequests[0];
      if (!pullRequest) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        ...pullRequest,
        head: { sha: state.authoritativeHeadSha ?? pullRequest.head.sha },
      });
    }
    if (method === "POST" && pathname === "/repos/owner/repo/pulls") {
      const inputBody = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
        head: string;
        title: string;
        body: string;
      };
      state.headSha = state.candidateSha;
      state.lastPullRequest = { title: inputBody.title, body: inputBody.body };
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
    if (method === "PUT" && pathname === "/repos/owner/repo/pulls/1/merge") {
      state.mergeCalls = (state.mergeCalls ?? 0) + 1;
      if (state.mergeRefusal)
        return Response.json({ merged: false, message: state.mergeRefusal }, { status: 405 });
      const pullRequest = state.pullRequests[0];
      if (!pullRequest) return Response.json({ message: "Not Found" }, { status: 404 });
      pullRequest.state = "closed";
      pullRequest.merged = true;
      pullRequest.merged_at = "2026-08-22T00:00:00Z";
      pullRequest.merge_commit_sha = "d".repeat(40);
      if (state.failAfterMerge) {
        state.failAfterMerge = false;
        throw new TypeError("response lost after merge");
      }
      return Response.json({
        merged: true,
        ...(state.mergeResponseSha === "missing"
          ? {}
          : { sha: state.mergeResponseSha === "malformed" ? "not-a-sha" : "d".repeat(40) }),
        message: "Pull Request successfully merged",
      });
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

const attestationSentinels = [
  "excluded-local-path-value",
  "excluded-machine-identity-value",
  "excluded-private-target-value",
  "excluded-credential-value",
] as const;
const excludedAttestationContent = attestationSentinels.join(" ");

function unsafeAttestationContract(id: string): ResolvedTaskContract {
  const task = contract(id);
  return {
    ...task,
    repository: { ...task.repository, path: attestationSentinels[0] },
    projectCheck: { ...task.projectCheck, command: excludedAttestationContent },
    instructions: excludedAttestationContent,
    acceptance: [excludedAttestationContent],
    nonGoals: [excludedAttestationContent],
    delivery: {
      ...task.delivery,
      title: excludedAttestationContent,
      body: excludedAttestationContent,
    },
  };
}

function unsafeAttestationCheck(candidateSha: string) {
  return {
    ...passingCheck,
    sha: candidateSha,
    command: excludedAttestationContent,
    stdout: excludedAttestationContent,
    stderr: excludedAttestationContent,
  };
}

function unsafeAttestationReview(candidateSha: string) {
  return {
    ...approvedReview,
    sha: candidateSha,
    summary: excludedAttestationContent,
    findings: [excludedAttestationContent],
  };
}

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

describe.sequential("Forge Delivery reconciliation", () => {
  test("does not execute a repository pre-push hook during credentialed push", async () => {
    const fixture = await repositoryFixture();
    const hookMarker = join(fixture.repository, ".git", "pre-push-ran");
    await writeFile(
      join(fixture.repository, ".git", "hooks", "pre-push"),
      `#!/bin/sh\nprintf 'hook ran\\n' > '${hookMarker}'\nexit 1\n`,
    );
    await chmod(join(fixture.repository, ".git", "hooks", "pre-push"), 0o755);
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
    const task = unsafeAttestationContract("forge-disable-hooks");
    const check = unsafeAttestationCheck(fixture.candidateSha);
    const review = unsafeAttestationReview(fixture.candidateSha);

    await withControlledFetch(state, (apiUrl) =>
      forge(fixture.repository, apiUrl, fixture.remote).deliver(
        task,
        fixture.candidateSha,
        check,
        review,
      ),
    );

    await expect(readFile(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.commentCreates).toBe(1);
    for (const sentinel of attestationSentinels)
      expect(state.comments[0]?.body).not.toContain(sentinel);
  });

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
    const task = unsafeAttestationContract("forge-recovery");
    const check = unsafeAttestationCheck(fixture.candidateSha);
    const review = unsafeAttestationReview(fixture.candidateSha);

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
    for (const sentinel of attestationSentinels)
      expect(state.comments[0]?.body).not.toContain(sentinel);
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

  test("merges an explicitly authorized exact head after the live PR and attestation probe", async () => {
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
          mergeable: null,
          mergeable_state: "blocked",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const task = contract("forge-authorized-merge", true);
    const check = { ...passingCheck, sha: fixture.candidateSha };
    const review = { ...approvedReview, sha: fixture.candidateSha };
    state.pullRequests[0].mergeable = true;
    state.pullRequests[0].mergeable_state = "clean";

    await withControlledFetch(state, async (apiUrl) => {
      const result = await forge(fixture.repository, apiUrl, fixture.remote).deliver(
        task,
        fixture.candidateSha,
        check,
        review,
      );
      expect(result).toMatchObject({
        sha: fixture.candidateSha,
        prNumber: 1,
        attestationId: "7",
        merge: {
          prNumber: 1,
          approvedHeadSha: fixture.candidateSha,
          mergeCommitSha: "d".repeat(40),
          observedState: "merged",
        },
      });
    });
    expect(state.mergeCalls).toBe(1);
  }, 30_000);

  test("stops at the reviewed PR without merge authority", async () => {
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
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const result = await withControlledFetch(state, (apiUrl) =>
      forge(fixture.repository, apiUrl, fixture.remote).deliver(
        contract("forge-no-merge-authority"),
        fixture.candidateSha,
        { ...passingCheck, sha: fixture.candidateSha },
        { ...approvedReview, sha: fixture.candidateSha },
      ),
    );
    expect(result.merge).toBeNull();
    expect(state.mergeCalls ?? 0).toBe(0);
  }, 30_000);

  test("delivers an issue-less Campaign without a fabricated Closes reference", async () => {
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
    const task = campaignContract("forge-campaign");
    const check = { ...passingCheck, sha: fixture.candidateSha };
    const review = { ...approvedReview, sha: fixture.candidateSha };

    await withControlledFetch(state, (apiUrl) =>
      forge(fixture.repository, apiUrl, fixture.remote).deliver(
        task,
        fixture.candidateSha,
        check,
        review,
      ),
    );

    expect(state.lastPullRequest).toEqual({ title: "Forge delivery", body: "Forge delivery" });
    expect(state.lastPullRequest?.body).not.toContain("Closes #");
    expect(state.lastPullRequest?.body).not.toContain("undefined");
  }, 30_000);

  test("blocks a changed live head before calling merge", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      authoritativeHeadSha: "e".repeat(40),
      pullRequests: [
        {
          number: 1,
          state: "open",
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
          contract("forge-live-head-changed", true),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("approved open head");
    expect(state.mergeCalls ?? 0).toBe(0);
  }, 30_000);

  test("turns a platform merge refusal into a concrete quarantine", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      mergeRefusal: "Required approval is missing",
      pullRequests: [
        {
          number: 1,
          state: "open",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
          mergeable: false,
          mergeable_state: "blocked",
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
          contract("forge-platform-refusal", true),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      ),
    ).rejects.toThrow("platform policy blocked merge");
    expect(state.mergeCalls).toBe(1);
  }, 30_000);

  test("recovers a lost successful merge response with one external merge", async () => {
    const fixture = await repositoryFixture();
    const state: ForgeServerState = {
      candidateSha: fixture.candidateSha,
      headSha: fixture.candidateSha,
      failAfterMerge: true,
      pullRequests: [
        {
          number: 1,
          state: "open",
          head: { sha: fixture.candidateSha },
          html_url: "http://example.invalid/pull/1",
          mergeable: true,
          mergeable_state: "clean",
        },
      ],
      comments: [],
      failAfterPullRequestCreate: false,
      failAfterCommentCreate: false,
      pullRequestCreates: 0,
      commentCreates: 0,
      requests: [],
    };
    const result = await withControlledFetch(state, (apiUrl) =>
      forge(fixture.repository, apiUrl, fixture.remote).deliver(
        contract("forge-merge-recovery", true),
        fixture.candidateSha,
        { ...passingCheck, sha: fixture.candidateSha },
        { ...approvedReview, sha: fixture.candidateSha },
      ),
    );
    expect(result.merge?.mergeCommitSha).toBe("d".repeat(40));
    expect(result.attestationId).toBe("7");
    expect(state.mergeCalls).toBe(1);
  }, 30_000);

  test.each(["missing", "malformed"] as const)(
    "probes a successful merge response with a %s merge SHA",
    async (mergeResponseSha) => {
      const fixture = await repositoryFixture();
      const state: ForgeServerState = {
        candidateSha: fixture.candidateSha,
        headSha: fixture.candidateSha,
        mergeResponseSha,
        pullRequests: [
          {
            number: 1,
            state: "open",
            head: { sha: fixture.candidateSha },
            html_url: "http://example.invalid/pull/1",
            mergeable: true,
            mergeable_state: "clean",
          },
        ],
        comments: [],
        failAfterPullRequestCreate: false,
        failAfterCommentCreate: false,
        pullRequestCreates: 0,
        commentCreates: 0,
        requests: [],
      };

      const result = await withControlledFetch(state, (apiUrl) =>
        forge(fixture.repository, apiUrl, fixture.remote).deliver(
          contract(`forge-merge-${mergeResponseSha}-sha-recovery`, true),
          fixture.candidateSha,
          { ...passingCheck, sha: fixture.candidateSha },
          { ...approvedReview, sha: fixture.candidateSha },
        ),
      );

      expect(result).toMatchObject({
        sha: fixture.candidateSha,
        prNumber: 1,
        attestationId: "7",
        merge: {
          prNumber: 1,
          approvedHeadSha: fixture.candidateSha,
          mergeCommitSha: "d".repeat(40),
          observedState: "merged",
        },
      });
      expect(state.mergeCalls).toBe(1);
      expect(
        state.requests.filter((request) => request === "GET /repos/owner/repo/pulls/1"),
      ).toHaveLength(2);
    },
    30_000,
  );
});
