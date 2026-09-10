#!/usr/bin/env node

import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = "a".repeat(40);
const contractHash = "b".repeat(64);
const now = Date.now();

function outcome(id, title, status = "planned", evidence = null, assessment) {
  return {
    id,
    title,
    acceptance: [`${title} is evidenced by the Campaign.`],
    dependsOn: [],
    parentId: null,
    status,
    evidence,
    ...(assessment === undefined ? {} : { assessment }),
  };
}

function campaign(id, objective, status, planHandedOff, outcomes, proposals = [], authority = {}) {
  return {
    schemaVersion: 1,
    campaignId: `${id}:v1`,
    goalId: id,
    goalVersion: 1,
    contractHash,
    objective,
    outcomes,
    authority: {
      source: "fixture-authority",
      publish: true,
      delivery: true,
      merge: true,
      repositories: ["fixture-repository"],
      effects: ["github"],
      ...authority,
    },
    budget: { maxElapsedMs: 3_600_000, maxTasks: 6 },
    status,
    planHandedOff,
    decisionRequest: null,
    revision: 1,
    proposals,
  };
}

function proposal(proposalId, outcomeId, taskId, status = "ready") {
  return {
    proposalId,
    outcomeId,
    sequence: Number(proposalId.at(-1)),
    status,
    blocker: null,
    ready: {
      repositoryId: "fixture-repository",
      baseSha: sha,
      repositoryRevision: 1,
      taskId,
      instructions: "Controlled fixture proposal.",
      acceptance: ["The controlled fixture exposes the proposal."],
      nonGoals: [],
      effects: ["github"],
      budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 60_000 },
      merge: true,
    },
  };
}

const campaigns = new Map([
  [
    "campaign-a:v1",
    campaign(
      "campaign-a",
      "Controlled dependent progression",
      "planning",
      true,
      [
        outcome("outcome-a1", "Predecessor delivery", "accepted", {
          outcomeId: "outcome-a1",
          taskId: "task-a-predecessor",
          effect: "github",
          sha,
          merged: true,
          mergeCommitSha: sha,
        }),
        outcome("outcome-a2", "Successor delivery"),
      ],
      [
        proposal("proposal-1", "outcome-a1", "task-a-predecessor"),
        proposal("proposal-2", "outcome-a2", "task-a-successor"),
      ],
    ),
  ],
  [
    "campaign-d:v1",
    campaign(
      "campaign-d",
      "Controlled deferred observation",
      "planning",
      true,
      [outcome("outcome-d1", "Continue the authorized work")],
      [proposal("proposal-1", "outcome-d1", "task-d-work")],
    ),
  ],
  [
    "campaign-e:v1",
    campaign(
      "campaign-e",
      "Controlled stop or missing authority",
      "blocked",
      true,
      [outcome("outcome-e1", "Work requiring unavailable authority")],
      [],
      { delivery: false, merge: false },
    ),
  ],
  [
    "campaign-f:v1",
    campaign(
      "campaign-f",
      "Controlled merged delivery with inconclusive assessment",
      "blocked",
      true,
      [
        outcome(
          "outcome-f1",
          "Merged delivery whose assessment is inconclusive",
          "planned",
          {
            outcomeId: "outcome-f1",
            taskId: "task-f",
            effect: "github",
            sha,
            merged: true,
            mergeCommitSha: sha,
          },
          {
            role: "assessor",
            assessmentId: "assessment-f1",
            outcomeId: "outcome-f1",
            evidenceHash: "c".repeat(64),
            verdict: "inconclusive",
            summary: "Controlled fixture leaves assessment usage unavailable.",
            gaps: [],
            evidence: [],
            usage: null,
            usageSource: "unavailable",
            startedAtEpochMs: now,
            completedAtEpochMs: now,
          },
        ),
      ],
      [],
    ),
  ],
]);

const tasks = new Map([
  [
    "task-a-predecessor",
    task("task-a-predecessor", "merged", {
      candidateSha: sha,
      candidateFence: 1,
      check: { sha, status: "passed", exitCode: 0 },
      review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
      delivery: {
        sha,
        effect: "github",
        prNumber: 1,
        url: "https://example.invalid/pull/1",
        attestationId: "fixture-attestation-a",
        merge: { prNumber: 1, approvedHeadSha: sha, mergeCommitSha: sha, observedState: "merged" },
      },
      activeActivation: null,
    }),
  ],
  ["task-a-successor", task("task-a-successor", "admitted", { activeActivation: 1 })],
  ["task-d", task("task-d", "admitted", { activeActivation: 1 })],
  [
    "task-b",
    task("task-b", "checked", {
      candidateSha: sha,
      candidateFence: 1,
      check: { sha, status: "passed", exitCode: 0 },
      activeActivation: 1,
      evidence: {
        implementerActivations: 1,
        reviewCycles: 2,
        changesRequestedBatches: 0,
        restartRecoveries: 0,
      },
    }),
  ],
  [
    "task-c",
    task("task-c", "waiting", {
      candidateSha: sha,
      candidateFence: 1,
      check: { sha, status: "passed", exitCode: 0 },
      review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
      delivery: {
        sha,
        effect: "github",
        prNumber: 1,
        url: "https://example.invalid/pull/1",
        attestationId: "fixture-attestation",
        merge: null,
      },
      waiting: {
        reason: "external_review",
        diagnostic: "Controlled fixture retry remains authorized.",
      },
      retryable: true,
      activeActivation: null,
    }),
  ],
  [
    "task-f",
    task("task-f", "merged", {
      candidateSha: sha,
      candidateFence: 1,
      check: { sha, status: "passed", exitCode: 0 },
      review: { sha, verdict: "approved", classification: "approved", findingCount: 0 },
      delivery: {
        sha,
        effect: "github",
        prNumber: 1,
        url: "https://example.invalid/pull/1",
        attestationId: "fixture-attestation",
        merge: { prNumber: 1, approvedHeadSha: sha, mergeCommitSha: sha, observedState: "merged" },
      },
      activeActivation: null,
    }),
  ],
]);

const histories = new Map([
  [
    "task-b",
    [
      event("event-b-1", { type: "review_started", sha, cycle: 1 }, 1, "task-b"),
      event(
        "event-b-2",
        {
          type: "review_interrupted",
          sha,
          cycle: 1,
          failureClass: "transient_transport",
        },
        2,
        "task-b",
      ),
      event("event-b-3", { type: "review_released", sha, cycle: 1 }, 3, "task-b"),
      event("event-b-4", { type: "review_started", sha, cycle: 2 }, 4, "task-b"),
    ],
  ],
  [
    "task-c",
    [
      event(
        "event-c-1",
        {
          type: "task_waiting",
          reason: "external_review",
          activation: 1,
          diagnostic: "Controlled fixture retry remains authorized.",
        },
        1,
        "task-c",
      ),
    ],
  ],
]);

function task(taskId, state, overrides = {}) {
  return {
    schemaVersion: 3,
    taskId,
    contractHash,
    revision: 1,
    deadlineEpochMs: now + 3_600_000,
    state,
    mergeAuthorized: true,
    candidateSha: null,
    candidateFence: null,
    check: null,
    review: null,
    delivery: null,
    blocker: null,
    waiting: null,
    retryable: false,
    activeActivation: null,
    writer: { repositoryIdentity: "fixture-repository" },
    repository: {
      id: "fixture-repository",
      owner: "fixture",
      name: "repository",
      baseBranch: "main",
    },
    evidence: {
      implementerActivations: 1,
      reviewCycles: 1,
      changesRequestedBatches: 0,
      restartRecoveries: 0,
    },
    ...overrides,
  };
}

function event(eventId, data, sequence, taskId) {
  return { taskId, sequence, eventId, occurredAtEpochMs: now, data };
}

const evidence = {
  schemaVersion: 1,
  campaignId: "campaign-f:v1",
  goalId: "campaign-f",
  goalVersion: 1,
  cursor: null,
  nextCursor: null,
  progress: { revision: 1, occurredAtEpochMs: now },
  coverage: "unavailable",
  runs: [],
  aggregates: [],
  totals: {
    invocations: 0,
    elapsedMs: null,
    reviewCycles: 0,
    repairBatches: 0,
    blockedProposals: 0,
    guardianTouches: 0,
    acceptedDeliveries: 1,
    terminalTaskCounts: {
      elapsed_budget: 0,
      implementation_budget: 0,
      invalid_phase: 0,
      missing_evidence: 0,
      provider_failure: 0,
      project_check_failure: 0,
      review_inconclusive: 0,
      delivery_failure: 0,
      unknown: 0,
    },
    usage: {
      inputTokens: null,
      cachedInputTokens: null,
      uncachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      coverage: "unavailable",
    },
  },
  touches: [],
  deliveries: [
    {
      taskId: "task-f",
      goalVersion: 1,
      outcomeId: "outcome-f1",
      effect: "github",
      pullRequest: 1,
      sha,
      url: "https://example.invalid/pull/1",
      attestationId: "fixture-attestation",
      merged: true,
      mergeCommitSha: sha,
      occurredAtEpochMs: now,
    },
  ],
};

const runRoot = await mkdtemp(join(tmpdir(), "usine-464-operator-fixture-"));
const requestLog = join(runRoot, "requests.jsonl");
await writeFile(requestLog, "");

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function record(request, status, responseBody, requestBody) {
  await appendFile(
    requestLog,
    `${JSON.stringify({
      method: request.method,
      path: request.url,
      requestBody: requestBody ? JSON.parse(requestBody) : null,
      responseStatus: status,
      response: responseBody,
    })}\n`,
  );
}

const server = createServer(async (request, response) => {
  const requestBody = request.method === "POST" ? await body(request) : "";
  const path = decodeURIComponent((request.url ?? "").split("?", 1)[0]);
  let status = 404;
  let responseBody = { error: "not_found", message: "fixture resource not found" };
  const campaignMatch = path.match(/^\/v1\/campaigns\/([^/]+)(?:\/(evidence|touches|abandon))?$/);
  const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(events|retry))?$/);

  if (campaignMatch) {
    const resource = campaigns.get(campaignMatch[1]);
    if (resource && request.method === "GET" && !campaignMatch[2]) {
      status = 200;
      responseBody = resource;
    } else if (
      resource &&
      campaignMatch[2] === "evidence" &&
      request.method === "GET" &&
      campaignMatch[1] === "campaign-f:v1"
    ) {
      status = 200;
      responseBody = evidence;
    } else if (resource && campaignMatch[2] === "touches" && request.method === "POST") {
      status = 200;
      responseBody = { ...resource, revision: resource.revision + 1 };
    } else if (resource && campaignMatch[2] === "abandon" && request.method === "POST") {
      status = 403;
      responseBody = {
        code: "campaign_abandonment_unauthorized",
        message: "fixture Campaign has no abandonment authority",
        retryable: false,
      };
    }
  } else if (taskMatch) {
    const resource = tasks.get(taskMatch[1]);
    if (resource && request.method === "GET" && !taskMatch[2]) {
      status = 200;
      responseBody = resource;
    } else if (resource && taskMatch[2] === "events" && request.method === "GET") {
      status = 200;
      const events = histories.get(resource.taskId) ?? [];
      const url = new URL(request.url ?? "", "http://fixture");
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const page = events.filter((event) => event.sequence > after).slice(0, limit);
      responseBody = {
        taskId: resource.taskId,
        events: page,
        nextSequence: page.at(-1)?.sequence ?? after,
      };
    } else if (
      resource &&
      taskMatch[2] === "retry" &&
      request.method === "POST" &&
      resource.retryable
    ) {
      status = 200;
      const retried = {
        ...resource,
        revision: resource.revision + 1,
        state: "reviewed",
        waiting: null,
        retryable: false,
      };
      tasks.set(resource.taskId, retried);
      const events = histories.get(resource.taskId) ?? [];
      histories.set(resource.taskId, [
        ...events,
        event(
          "event-c-2",
          { type: "task_retry_accepted", reason: "external_review", activation: 1 },
          events.at(-1)?.sequence + 1 ?? 1,
          resource.taskId,
        ),
      ]);
      responseBody = retried;
    } else if (resource && taskMatch[2] === "retry" && request.method === "POST") {
      status = 409;
      responseBody = {
        code: "task_retry_conflict",
        message: "fixture Task is not waiting",
        retryable: false,
        state: resource.state,
      };
    }
  }

  await record(request, status, responseBody, requestBody);
  json(response, status, responseBody);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("operator fixture did not bind");

const cases = [
  { caseId: "case-a", resource: "campaign-a:v1", kind: "campaign" },
  { caseId: "case-b", resource: "task-b", kind: "task" },
  { caseId: "case-c", resource: "task-c", kind: "task" },
  { caseId: "case-d", resource: "campaign-d:v1", kind: "campaign" },
  { caseId: "case-e", resource: "campaign-e:v1", kind: "campaign" },
  { caseId: "case-f", resource: "campaign-f:v1", kind: "campaign" },
];

process.stdout.write(
  `${JSON.stringify({
    fixture: "operator-cli-fixture",
    serverUrl: `http://127.0.0.1:${address.port}`,
    requestLog,
    cli: "node apps/cli/dist/cli.mjs",
    cases,
    stop: "SIGINT",
  })}\n`,
);

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
