import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import {
  CampaignEvidenceCursorError,
  lookupCampaignEvidence,
  startUsineServer,
} from "@usine/runtime";
import {
  createOpenAICompatibleRoleOutputTransform,
  implementerOutputSchema,
  type SessionObservation,
} from "@usine/coding-session";
import {
  campaignEvidenceToPostHogEvents,
  captureCampaignEvidence,
} from "../packages/runtime/src/posthog.js";
import { campaignModelRunFromObservation } from "../packages/runtime/src/campaign-model-run.js";
import {
  campaignEvidence,
  getCampaign,
  handoffCampaign,
  proposeCampaign,
  publishCampaign,
  recordCampaignDecisionTouch,
  registerRepository,
  taskEvidence,
  taskEvents,
  usageReport,
} from "../apps/cli/src/server-client.js";
import type { TaskFailureClass } from "@usine/task-authority";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function goalContract(id = "evidence-goal") {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    objective: "Measure the campaign",
    outcomes: [
      { id: "outcome-one", title: "First outcome", acceptance: ["first"] },
      { id: "outcome-two", title: "Second outcome", acceptance: ["second"] },
    ],
    authority: {
      source: "user:evidence",
      publish: true,
      delivery: true,
      merge: false,
      repositories: ["repo-one"],
      effects: ["github"],
    },
  };
}

function proposal(proposalId: string, outcomeId: string, effects = ["github"]) {
  return {
    proposalId,
    outcomeId,
    dependsOn: [],
    repositoryId: "repo-one",
    instructions: `Implement ${proposalId}.`,
    acceptance: [`${proposalId} is complete.`],
    nonGoals: [],
    effects,
    merge: false,
  };
}

type ReviewerInterruptionFixture = {
  readonly providerClass:
    | "rate_limit"
    | "transient_transport"
    | "transport"
    | "configuration"
    | "cancellation"
    | "unknown";
  readonly failureClass: TaskFailureClass;
  readonly outcome: "failed" | "cancelled";
};

async function fixture(
  mode: "successful" | "interrupted" | ReviewerInterruptionFixture = "successful",
  normalizer?: SessionObservation["normalizer"],
  expectedExecutions = 2,
) {
  const root = await mkdtemp(join(tmpdir(), "usine-campaign-evidence-"));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const contractPath = join(root, "goal.json");
  await execa("git", ["init", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.name", "Test"], { cwd: root });
  await execa("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(contractPath, JSON.stringify(goalContract()));
  await execa("git", ["add", "goal.json"], { cwd: root });
  await execa("git", ["commit", "-m", "authorize campaign"], { cwd: root });

  let executions = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const environment: NodeJS.ProcessEnv = {
    USINE_STATE_DIR: stateDirectory,
    USINE_GOAL_PUBLICATION_SOURCE: "user:evidence",
    USINE_ACTIVE_TASK_CAPACITY: "1",
    USINE_FORGE_PROFILE_FORGE_APP_SLUG: "test-app",
    USINE_FORGE_PROFILE_FORGE_TEST_TOKEN: "test-token",
    USINE_FORGE_PROFILE_FORGE_API_URL: "http://127.0.0.1:9",
    USINE_FORGE_PROFILE_FORGE_REPOSITORY: "example/repo-one",
  };
  const server = await startUsineServer({
    environment,
    host: "127.0.0.1",
    port: 0,
    execute: async ({ authority, result, contract }) => {
      const index = executions++;
      if (typeof mode !== "string") {
        const reserved = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        const candidateSha = "a".repeat(40);
        const candidate = await authority.recordCandidate(
          { taskId: result.taskId, revision: reserved.result.revision },
          { sha: candidateSha, baseSha: contract.baseSha, fence: reserved.activation },
        );
        const checked = await authority.recordCheck(
          { taskId: result.taskId, revision: candidate.revision },
          {
            sha: candidateSha,
            status: "passed",
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        );
        const sessionId = `${result.taskId}-interrupted-reviewer`;
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-reviewer-session-started`,
          occurredAtEpochMs: 511_537,
          data: {
            type: "coding_session_started",
            role: "reviewer",
            activation: 0,
            reviewCycle: 1,
            sessionId,
            requestedProfile: "reviewer",
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-reviewer-session-interrupted`,
          occurredAtEpochMs: 511_538,
          data: {
            type: "coding_session_interrupted",
            role: "reviewer",
            activation: 0,
            sessionId,
            phase: "turn",
            failureClass: mode.providerClass,
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-reviewer-session-completed`,
          occurredAtEpochMs: 511_539,
          data: {
            type: "coding_session_completed",
            role: "reviewer",
            activation: 0,
            reviewCycle: 1,
            outcome: mode.outcome,
            sessionId,
            requestedProfile: "reviewer",
          },
        });
        if (mode.outcome === "cancelled") {
          finish();
          return checked;
        }
        if (mode.failureClass === "cancellation") throw new Error("cancellation must not block");
        const reviewAttempt = await authority.reserveReviewAttempt(
          result.taskId,
          contract.budget.maxReviewCycles,
          "campaign-evidence-reviewer",
        );
        const interrupted = await authority.recordReviewInterruption(
          { taskId: result.taskId, revision: reviewAttempt.result.revision },
          candidateSha,
          mode.failureClass,
          "campaign-evidence-reviewer",
        );
        const blocked = await authority.block(
          { taskId: result.taskId, revision: interrupted.revision },
          "private provider diagnostic",
          mode.failureClass,
        );
        finish();
        return blocked;
      }
      if (mode === "interrupted") {
        const sessionId = `${result.taskId}-interrupted-implementer`;
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-session-started`,
          occurredAtEpochMs: 511_537,
          data: {
            type: "coding_session_started",
            role: "implementer",
            activation: 1,
            sessionId,
            requestedProfile: "implementer",
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-usage-observed`,
          occurredAtEpochMs: 511_538,
          data: {
            type: "coding_usage_observed",
            role: "implementer",
            activation: 1,
            sessionId,
            source: "provider",
            semantics: "replacement",
            actualModel: { model: "provider/gpt-5", provider: "provider:actual" },
            usage: {
              inputTokens: 120,
              cachedInputTokens: 20,
              uncachedInputTokens: 100,
              outputTokens: 8,
            },
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-session-interrupted`,
          occurredAtEpochMs: 511_539,
          data: {
            type: "coding_session_interrupted",
            role: "implementer",
            activation: 1,
            sessionId,
            phase: "turn",
            failureClass: "transient_transport",
          },
        });
        await authority.appendObservation(result.taskId, {
          eventId: `${result.taskId}-session-completed`,
          occurredAtEpochMs: 511_540,
          data: {
            type: "coding_session_completed",
            role: "implementer",
            activation: 1,
            outcome: "failed",
            sessionId,
            requestedProfile: "implementer",
            effectiveProfile: {
              profileName: "implementer",
              configSha256: "c".repeat(64),
              adapter: "sdk",
              model: "configured-model",
              modelProvider: "configured-provider",
              actualModel: "provider/gpt-5",
              actualModelProvider: "provider:actual",
              reasoningEffort: "high",
              developerInstructionsSha256: null,
              serviceTier: "default",
            },
            usage: null,
          },
        });
        const blocked = await authority.block(
          { taskId: result.taskId, revision: result.revision },
          "provider interruption",
        );
        finish();
        return blocked;
      }
      const implementationUsage =
        index === 0
          ? { inputTokens: 12, cachedInputTokens: 3, uncachedInputTokens: 9, outputTokens: 7 }
          : null;
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-implementer`,
        occurredAtEpochMs: 100 + index * 100,
        data: {
          type: "coding_session_completed",
          role: "implementer",
          activation: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-implementer`,
          effectiveProfile: {
            profileName: "implementer",
            configSha256: "c".repeat(64),
            adapter: "sdk",
            model: index === 0 ? "configured-model" : "configured-model-two",
            modelProvider: "configured-provider",
            actualModel: "observed-one",
            actualModelProvider: "provider-one",
            reasoningEffort: "high",
            developerInstructionsSha256: null,
            serviceTier: "default",
          },
          usage: implementationUsage,
          ...(index === 0 && normalizer ? { normalizer } : {}),
        },
      });
      await authority.appendObservation(result.taskId, {
        eventId: `${result.taskId}-reviewer`,
        occurredAtEpochMs: 120 + index * 100,
        data: {
          type: "coding_session_completed",
          role: "reviewer",
          activation: 1,
          reviewCycle: 1,
          outcome: "succeeded",
          sessionId: `${result.taskId}-reviewer`,
          effectiveProfile: {
            profileName: "reviewer",
            configSha256: "d".repeat(64),
            adapter: index === 0 ? "app-server" : "opencode2",
            model: "review-model",
            modelProvider: "review-provider",
            ...(index === 0
              ? { actualModel: "review-observed", actualModelProvider: "review-observed-provider" }
              : {}),
            reasoningEffort: "medium",
            developerInstructionsSha256: null,
            serviceTier: "default",
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      });
      const reserved = await authority.reserveActivation(
        result.taskId,
        contract.budget.maxImplementerActivations,
      );
      const firstSha = index === 0 ? "e".repeat(40) : "1".repeat(40);
      const candidate = await authority.recordCandidate(
        { taskId: result.taskId, revision: reserved.result.revision },
        { sha: firstSha, baseSha: contract.baseSha, fence: reserved.activation },
      );
      await authority.recordCheck(
        { taskId: result.taskId, revision: candidate.revision },
        { sha: firstSha, status: "passed", command: "true", exitCode: 0, stdout: "", stderr: "" },
      );
      const reviewAttempt = await authority.reserveReviewAttempt(
        result.taskId,
        contract.budget.maxReviewCycles,
        "campaign-evidence-reviewer",
      );
      const reviewed = await authority.recordReview(
        { taskId: result.taskId, revision: reviewAttempt.result.revision },
        {
          sha: firstSha,
          verdict: index === 0 ? "changes_requested" : "approved",
          summary: "fixture review",
          findings: index === 0 ? ["repair"] : [],
        },
        "campaign-evidence-reviewer",
      );
      let final = reviewed;
      if (index === 0) {
        await authority.recordRepairBatch({ taskId: result.taskId, revision: reviewed.revision });
        const repaired = await authority.reserveActivation(
          result.taskId,
          contract.budget.maxImplementerActivations,
        );
        const repairedCandidate = await authority.recordCandidate(
          { taskId: result.taskId, revision: repaired.result.revision },
          { sha: "f".repeat(40), baseSha: firstSha, fence: repaired.activation },
        );
        await authority.recordCheck(
          { taskId: result.taskId, revision: repairedCandidate.revision },
          {
            sha: "f".repeat(40),
            status: "passed",
            command: "true",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        );
        const repairedReviewAttempt = await authority.reserveReviewAttempt(
          result.taskId,
          contract.budget.maxReviewCycles,
          "campaign-evidence-reviewer",
        );
        final = await authority.recordReview(
          { taskId: result.taskId, revision: repairedReviewAttempt.result.revision },
          { sha: "f".repeat(40), verdict: "approved", summary: "repaired", findings: [] },
          "campaign-evidence-reviewer",
        );
      }
      const delivered = await authority.recordDelivery(
        { taskId: result.taskId, revision: final.revision },
        {
          sha: final.candidateSha!,
          effect: "github",
          prNumber: 41 + index,
          url: `https://github.com/example/repo-one/pull/${41 + index}`,
          attestationId: `attestation-${index}`,
          merge: null,
        },
      );
      if (executions === expectedExecutions) finish();
      return delivered;
    },
  });
  servers.push(server);
  await registerRepository(server.url, {
    id: "repo-one",
    path: root,
    owner: "example",
    name: "repo-one",
    baseBranch: "main",
    implementerProfile: "implementer",
    reviewerProfile: "reviewer",
    forgeProfile: "forge",
    projectCheck: { command: "true", timeoutMs: 1_000 },
    gitAuthor: { name: "Test", email: "test@example.invalid" },
  });
  return { stateDirectory, contractPath, server, finished };
}

test("measures baseline Campaign evidence reads across Campaigns and pages", async () => {
  const persistedResults = new Set<string>();
  const unrelatedResults = new Set<string>();
  let campaignEventCount = 0;
  let maxTaskEventCount = 0;
  const { stateDirectory, contractPath, server, finished } = await fixture(
    "successful",
    undefined,
    4,
  );
  const first = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, first.campaignId, proposal("first-one", "outcome-one"));
  await proposeCampaign(server.url, first.campaignId, proposal("first-two", "outcome-two"));

  const secondContractPath = join(dirname(contractPath), "goal-two.json");
  await writeFile(secondContractPath, JSON.stringify(goalContract("evidence-goal-two")));
  await execa("git", ["add", "goal-two.json"], { cwd: dirname(contractPath) });
  await execa("git", ["commit", "-m", "authorize second campaign"], {
    cwd: dirname(contractPath),
  });
  const second = await publishCampaign(server.url, { contractPath: secondContractPath });
  await proposeCampaign(server.url, second.campaignId, proposal("second-one", "outcome-one"));
  await proposeCampaign(server.url, second.campaignId, proposal("second-two", "outcome-two"));
  await handoffCampaign(server.url, first.campaignId);
  await handoffCampaign(server.url, second.campaignId);
  await finished;
  await expect
    .poll(async () => (await getCampaign(server.url, first.campaignId))?.status)
    .toBe("blocked");
  await expect
    .poll(async () => (await getCampaign(server.url, second.campaignId))?.status)
    .toBe("blocked");

  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    const rows = database
      .prepare("SELECT task_id, result FROM task_runs ORDER BY task_id")
      .all() as Array<{ task_id: string; result: string }>;
    const firstTask = rows.find((row) => {
      const result = JSON.parse(row.result) as { campaign?: { campaignId?: string } };
      return result.campaign?.campaignId === first.campaignId;
    });
    if (!firstTask) throw new Error("first Campaign task was not persisted");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const source of rows) {
        for (let index = 0; index < 100; index += 1) {
          const taskId = `seed-${source.task_id}-${String(index).padStart(3, "0")}`;
          database
            .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
            .run(taskId, source.result.replaceAll(source.task_id, taskId));
          database
            .prepare(`INSERT INTO task_events
          (task_id, sequence, event_id, occurred_at_epoch_ms, data)
          SELECT ?, sequence, event_id, occurred_at_epoch_ms, replace(data, ?, ?)
          FROM task_events WHERE task_id = ?`)
            .run(taskId, source.task_id, taskId, source.task_id);
        }
      }
      database
        .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
        .run(firstTask.result.replace('"goalVersion":1,', '"goalVersion":1.0,'), firstTask.task_id);
      database
        .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
        .run("malformed-unrelated-task", "{ invalid");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    for (const row of database.prepare("SELECT result FROM task_runs").all()) {
      const raw = row.result as string;
      persistedResults.add(raw);
      if (raw.includes(second.campaignId) || raw === "{ invalid") unrelatedResults.add(raw);
    }
    campaignEventCount = Number(
      database
        .prepare(`SELECT count(*) AS count FROM task_events
      WHERE task_id IN (SELECT task_id FROM task_runs WHERE
        json_extract(CASE WHEN json_valid(result) THEN result ELSE '{}' END, '$.campaign.campaignId') = ?)`)
        .get(first.campaignId)!.count,
    );
    maxTaskEventCount = Number(
      database
        .prepare(`SELECT max(event_count) AS count FROM
      (SELECT count(*) AS event_count FROM task_events GROUP BY task_id)`)
        .get()!.count,
    );
  } finally {
    database.close();
  }

  type ReadStats = {
    readonly prepareCount: number;
    readonly taskResultRows: number;
    readonly taskEventRows: number;
    readonly taskDecodes: number;
    readonly unrelatedDecodes: number;
    readonly elapsedMs: number;
  };

  const measure = async <T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly stats: ReadStats }> => {
    const databasePrototype = DatabaseSync.prototype as unknown as {
      prepare: (query: string) => unknown;
    };
    const originalPrepare = databasePrototype.prepare;
    let prepareCount = 0;
    let taskResultRows = 0;
    let taskEventRows = 0;
    let taskDecodes = 0;
    let unrelatedDecodes = 0;
    const originalParse = JSON.parse;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      if (persistedResults.has(args[0])) taskDecodes += 1;
      if (unrelatedResults.has(args[0])) unrelatedDecodes += 1;
      return originalParse(...args);
    };
    const countRows = (query: string, result: unknown): void => {
      const rows = Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
      if (/\btask_runs\b/i.test(query) && /\bresult\b/i.test(query)) taskResultRows += rows;
      if (/\btask_events\b/i.test(query)) taskEventRows += rows;
    };
    databasePrototype.prepare = function (this: unknown, query: string): unknown {
      prepareCount += 1;
      const statement = originalPrepare.call(this, query) as object;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "all" || property === "get") {
            return (...parameters: unknown[]) => {
              const result = (target as Record<string, (...args: unknown[]) => unknown>)[property]!(
                ...parameters,
              );
              countRows(query, result);
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const startedAt = performance.now();
    try {
      const value = await operation();
      return {
        value,
        stats: {
          prepareCount,
          taskResultRows,
          taskEventRows,
          taskDecodes,
          unrelatedDecodes,
          elapsedMs: performance.now() - startedAt,
        },
      };
    } finally {
      JSON.parse = originalParse;
      databasePrototype.prepare = originalPrepare;
      console.info(
        `Issue489 baseline ${label}: ${JSON.stringify({
          prepareCount,
          taskResultRows,
          taskEventRows,
          taskDecodes,
          unrelatedDecodes,
          elapsedMs: performance.now() - startedAt,
        })}`,
      );
    }
  };

  const cli = await measure("cli", () => campaignEvidence(server.url, first.campaignId, 50));
  expect(cli.value?.runs).toHaveLength(404);
  expect(cli.value?.runs.every((run) => run.taskId !== null)).toBe(true);
  expect(cli.value?.totals!.invocations).toBe(404);
  expect(cli.stats.taskResultRows).toBeGreaterThan(0);
  expect(cli.stats.taskEventRows).toBeGreaterThan(0);
  expect(cli.stats.taskDecodes).toBeLessThanOrEqual(2 * 202 + 30);
  expect(cli.stats.unrelatedDecodes).toBe(0);
  expect(cli.stats.taskEventRows).toBeLessThanOrEqual(2 * campaignEventCount);

  const posthog = await measure("posthog", () =>
    captureCampaignEvidence(
      stateDirectory,
      first.campaignId,
      {
        USINE_POSTHOG_API_KEY: "test-key",
        USINE_POSTHOG_DEPLOYMENT: "issue489-baseline",
      },
      async () => new Response(null, { status: 200 }),
    ),
  );
  expect(posthog.stats.taskResultRows).toBeGreaterThan(0);
  expect(posthog.stats.taskEventRows).toBeGreaterThan(0);
  expect(posthog.stats.taskDecodes).toBeLessThanOrEqual(2 * 202 + 30);
  expect(posthog.stats.unrelatedDecodes).toBe(0);
  expect(posthog.stats.taskEventRows).toBeLessThanOrEqual(2 * campaignEventCount);

  const firstPage = await measure("first-page", () =>
    lookupCampaignEvidence(stateDirectory, first.campaignId, { cursor: null, limit: 50 }),
  );
  expect(firstPage.value?.totals?.invocations).toBe(404);
  expect(firstPage.stats.unrelatedDecodes).toBe(0);
  expect(firstPage.stats.taskDecodes).toBeLessThanOrEqual(202 + 10);
  const continuation = await measure("continuation", () =>
    lookupCampaignEvidence(stateDirectory, first.campaignId, {
      cursor: firstPage.value!.nextCursor,
      limit: 50,
    }),
  );
  expect(continuation.value?.totals).toBeNull();
  expect(continuation.stats.unrelatedDecodes).toBe(0);
  expect(continuation.stats.taskDecodes).toBeLessThanOrEqual(50 + 10);
  expect(continuation.stats.taskEventRows).toBeLessThanOrEqual(50 * maxTaskEventCount);
});

function campaignEvidenceCursor(
  campaignId: string,
  upperTaskId: string,
  afterTaskId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      scope: `campaign-evidence:${campaignId}`,
      upperTaskId,
      afterTaskId,
    }),
    "utf8",
  ).toString("base64url");
}

test("skips quarantined Campaign rows and preserves historical cursor membership", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("first-one", "outcome-one"));
  await proposeCampaign(server.url, published.campaignId, proposal("first-two", "outcome-two"));
  await handoffCampaign(server.url, published.campaignId);
  await finished;

  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  let validTaskIds: string[] = [];
  try {
    const rows = database
      .prepare("SELECT task_id, result FROM task_runs ORDER BY task_id")
      .all() as Array<{ task_id: string; result: string }>;
    const targetRows = rows.filter((row) => {
      const result = JSON.parse(row.result) as { campaign?: { campaignId?: string } };
      return result.campaign?.campaignId === published.campaignId;
    });
    validTaskIds = targetRows.map((row) => row.task_id);
    expect(validTaskIds).toHaveLength(2);

    const historical = JSON.parse(targetRows[0]!.result) as Record<string, unknown>;
    historical.schemaVersion = 3;
    delete historical.blockerClassification;
    if (historical.deadlineEpochMs === undefined) historical.deadlineEpochMs = Date.now() + 30_000;
    database
      .prepare("UPDATE task_runs SET result = ? WHERE task_id = ?")
      .run(
        JSON.stringify(historical).replace('"goalVersion":1', '"goalVersion":1.0'),
        targetRows[0]!.task_id,
      );

    const interleavedTaskId = `${validTaskIds[0]}:quarantined`;
    expect(validTaskIds[0]! < interleavedTaskId && interleavedTaskId < validTaskIds[1]!).toBe(true);
    const quarantineResult = JSON.stringify({
      schemaVersion: 4,
      taskId: interleavedTaskId,
      campaign: {
        campaignId: published.campaignId,
        goalId: "evidence-goal",
        goalVersion: 1,
        outcomeId: "outcome-one",
      },
    });
    database
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(interleavedTaskId, quarantineResult);
    database
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run("zzzz-quarantined", quarantineResult.replaceAll(interleavedTaskId, "zzzz-quarantined"));
  } finally {
    database.close();
  }

  const pages = [
    await lookupCampaignEvidence(stateDirectory, published.campaignId, {
      cursor: null,
      limit: 1,
    }),
  ];
  while (pages.at(-1)?.nextCursor !== null)
    pages.push(
      await lookupCampaignEvidence(stateDirectory, published.campaignId, {
        cursor: pages.at(-1)!.nextCursor,
        limit: 1,
      }),
    );
  const observedTaskIds = [
    ...new Set(
      pages
        .flatMap((page) => page?.runs.map((run) => run.taskId) ?? [])
        .filter((id): id is string => id !== null),
    ),
  ];
  expect(observedTaskIds).toEqual(validTaskIds);
  expect(pages).toHaveLength(2);
  expect(pages.flatMap((page) => page?.runs ?? [])).toHaveLength(4);

  await expect(
    lookupCampaignEvidence(stateDirectory, published.campaignId, {
      cursor: campaignEvidenceCursor(published.campaignId, "zzzz-quarantined", validTaskIds[0]!),
      limit: 1,
    }),
  ).rejects.toBeInstanceOf(CampaignEvidenceCursorError);
  await expect(
    lookupCampaignEvidence(stateDirectory, published.campaignId, {
      cursor: campaignEvidenceCursor(
        published.campaignId,
        validTaskIds[1]!,
        `${validTaskIds[0]}:quarantined`,
      ),
      limit: 1,
    }),
  ).rejects.toBeInstanceOf(CampaignEvidenceCursorError);
});

test("retains Campaign model runs when no Task is associated", async () => {
  const { stateDirectory, contractPath, server } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    database
      .prepare(
        `INSERT INTO campaign_model_runs
          (invocation_id, campaign_id, outcome_id, role, status, started_at_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "empty-campaign-assessor",
        published.campaignId,
        "outcome-one",
        "assessor",
        "succeeded",
        100,
      );
  } finally {
    database.close();
  }

  const report = await lookupCampaignEvidence(stateDirectory, published.campaignId);
  expect(report?.runs).toEqual([
    expect.objectContaining({
      invocationId: "empty-campaign-assessor",
      taskId: null,
      role: "assessor",
    }),
  ]);
  expect(report?.totals?.invocations).toBe(1);
});

test("advances continuation progress without leaking Tasks beyond the cursor upper bound", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("first-one", "outcome-one"));
  await proposeCampaign(server.url, published.campaignId, proposal("first-two", "outcome-two"));
  await handoffCampaign(server.url, published.campaignId);
  await finished;

  const first = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: null,
    limit: 1,
  });
  if (!first?.nextCursor) throw new Error("expected a continuation cursor");

  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    const source = database
      .prepare(
        "SELECT task_id, result FROM task_runs WHERE task_id LIKE ? ORDER BY task_id LIMIT 1",
      )
      .get(`campaign-evidence-goal-v1-%`) as { task_id: string; result: string };
    const appendedTaskId = "zzzz-appended-after-upper";
    const appended = JSON.parse(source.result) as Record<string, unknown>;
    appended.taskId = appendedTaskId;
    database
      .prepare("INSERT INTO task_runs (task_id, result) VALUES (?, ?)")
      .run(appendedTaskId, JSON.stringify(appended));
    database
      .prepare("UPDATE campaigns SET revision = revision + 1, updated_at = ? WHERE campaign_id = ?")
      .run(Date.now(), published.campaignId);
  } finally {
    database.close();
  }

  const continuation = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: first.nextCursor,
    limit: 1,
  });
  expect(continuation?.progress.revision).toBeGreaterThan(first.progress.revision);
  expect(continuation?.totals).toBeNull();
  expect(continuation?.runs.some((run) => run.taskId === "zzzz-appended-after-upper")).toBe(false);
  expect(
    continuation?.deliveries.some((delivery) => delivery.taskId === "zzzz-appended-after-upper"),
  ).toBe(false);
  const refreshed = await lookupCampaignEvidence(stateDirectory, published.campaignId);
  expect(
    refreshed?.deliveries.some((delivery) => delivery.taskId === "zzzz-appended-after-upper"),
  ).toBe(true);
  expect(first.totals?.acceptedDeliveries).toBe(2);
  expect(refreshed?.totals?.acceptedDeliveries).toBe(3);
});

test("projects public Campaign writes into deterministic evidence across Tasks and providers", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("proposal-one", "outcome-one"));
  await proposeCampaign(server.url, published.campaignId, proposal("proposal-two", "outcome-two"));
  await proposeCampaign(
    server.url,
    published.campaignId,
    proposal("proposal-blocked", "outcome-two", ["shell"]),
  );
  await recordCampaignDecisionTouch(server.url, published.campaignId, "blocked-review");
  await recordCampaignDecisionTouch(server.url, published.campaignId, "blocked-review");
  await handoffCampaign(server.url, published.campaignId);
  await finished;

  const first = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: null,
    limit: 1,
  });
  expect(first?.runs).toHaveLength(2);
  expect(
    first?.runs.map((run) => [
      run.role,
      run.configuredModel,
      run.configuredProvider,
      run.actualModel,
      run.actualProvider,
      run.model,
      run.provider,
      run.adapter,
    ]),
  ).toEqual([
    [
      "implementer",
      "configured-model",
      "configured-provider",
      "observed-one",
      "provider-one",
      "observed-one",
      "provider-one",
      "sdk",
    ],
    [
      "reviewer",
      "review-model",
      "review-provider",
      "review-observed",
      "review-observed-provider",
      "review-observed",
      "review-observed-provider",
      "app-server",
    ],
  ]);
  expect(first?.totals).toMatchObject({
    invocations: 4,
    reviewCycles: 3,
    repairBatches: 1,
    blockedProposals: 1,
    guardianTouches: 5,
    acceptedDeliveries: 2,
    usage: { inputTokens: null, outputTokens: null, coverage: "partial" },
  });
  expect(first?.runs[0]).toHaveProperty("profile", "implementer");
  expect(first?.runs[0]).toHaveProperty("configuredProvider", "configured-provider");
  expect(first?.deliveries).toHaveLength(1);
  expect(first?.touches.map((touch) => touch.type)).toEqual([
    "plan",
    "plan",
    "plan",
    "plan",
    "decision",
  ]);
  expect(first?.nextCursor).not.toBeNull();

  const second = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: first!.nextCursor,
    limit: 1,
  });
  expect(second?.runs).toHaveLength(2);
  expect(second?.runs[0]?.usage).toMatchObject({
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
  });
  expect(second?.runs[1]?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  expect(second?.deliveries).toHaveLength(1);
  expect(second?.touches).toEqual([]);
  expect(second?.totals).toBeNull();

  const publicReport = await campaignEvidence(server.url, published.campaignId, 1);
  expect(publicReport?.runs).toHaveLength(4);
  expect(publicReport?.runs.find((run) => run.adapter === "sdk")).toMatchObject({
    configuredModel: "configured-model",
    configuredProvider: "configured-provider",
    actualModel: "observed-one",
    actualProvider: "provider-one",
  });
  expect(publicReport?.runs.find((run) => run.adapter === "opencode2")).toMatchObject({
    configuredModel: "review-model",
    configuredProvider: "review-provider",
    actualModel: "unavailable",
    actualProvider: "unavailable",
    model: "unavailable",
    provider: "unavailable",
  });
  const implementerAggregates = publicReport?.aggregates.filter(
    (aggregate) => aggregate.role === "implementer",
  );
  expect(implementerAggregates?.map((aggregate) => aggregate.configuredModel).toSorted()).toEqual([
    "configured-model",
    "configured-model-two",
  ]);
  expect(publicReport?.deliveries).toHaveLength(2);
  expect(publicReport?.touches).toHaveLength(5);
  expect(publicReport?.totals).toEqual(first?.totals);
  expect(
    await lookupCampaignEvidence(stateDirectory, published.campaignId, { cursor: null, limit: 1 }),
  ).toEqual(first);
  await expect(
    lookupCampaignEvidence(stateDirectory, published.campaignId, {
      cursor: "x".repeat(4097),
      limit: 1,
    }),
  ).rejects.toBeInstanceOf(CampaignEvidenceCursorError);
});

test("retains failed interrupted usage in public Campaign runs and totals", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture("interrupted");
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("interrupted", "outcome-one"));
  await handoffCampaign(server.url, published.campaignId);
  await finished;

  const expectedUsage = {
    inputTokens: 120,
    cachedInputTokens: 20,
    uncachedInputTokens: 100,
    cacheWriteInputTokens: null,
    outputTokens: 8,
    reasoningOutputTokens: null,
    coverage: "complete" as const,
  };
  const persisted = await lookupCampaignEvidence(stateDirectory, published.campaignId);
  expect(persisted?.coverage).toBe("complete");
  expect(persisted?.runs).toEqual([
    expect.objectContaining({
      role: "implementer",
      outcome: "failed",
      elapsedMs: 3,
      usage: expectedUsage,
    }),
  ]);
  expect(persisted?.totals).toMatchObject({
    invocations: 1,
    elapsedMs: 3,
    usage: expectedUsage,
  });

  const publicEvidence = await campaignEvidence(server.url, published.campaignId);
  expect(publicEvidence?.coverage).toBe("complete");
  expect(publicEvidence?.runs).toEqual(persisted?.runs);
  expect(publicEvidence?.totals).toEqual(persisted?.totals);
});

test.each([true, false])(
  "retains actual normalizer cache evidence through Task, Campaign and PostHog (cache supplied: %s)",
  async (cacheSupplied) => {
    let observedUsage: SessionObservation["usage"] = null;
    const transform = createOpenAICompatibleRoleOutputTransform({
      apiKey: "fixture-key",
      baseURL: "https://fixture.invalid/v1",
      model: "fixture-normalizer",
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "normalizer",
            object: "chat.completion",
            created: 0,
            model: "fixture-normalizer",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: '{"status":"proposed","summary":"normalized"}',
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 7,
              ...(cacheSupplied
                ? { prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }
                : {}),
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await transform({
      finalResponse: "provider prose",
      outputSchema: implementerOutputSchema,
      signal: new AbortController().signal,
      onUsage: ({ usage }) => {
        observedUsage = usage;
      },
    });
    const { stateDirectory, contractPath, server, finished } = await fixture("successful", {
      status: "succeeded",
      usage: observedUsage,
      adapter: "role-output-normalizer",
      model: "fixture-normalizer",
      modelProvider: "openai-compatible",
      actualModel: "fixture-normalizer",
      actualModelProvider: "openai-compatible",
    });
    const published = await publishCampaign(server.url, { contractPath });
    await proposeCampaign(server.url, published.campaignId, proposal("one", "outcome-one"));
    await proposeCampaign(server.url, published.campaignId, proposal("two", "outcome-two"));
    await handoffCampaign(server.url, published.campaignId);
    await finished;
    const expected = {
      inputTokens: 1000,
      outputTokens: 7,
      cachedInputTokens: cacheSupplied ? 800 : null,
      uncachedInputTokens: cacheSupplied ? 200 : null,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: null,
      coverage: cacheSupplied ? "complete" : "partial",
    };
    const taskReport = await usageReport(server.url, {
      taskId: null,
      repositoryId: null,
      fromEpochMs: null,
      toEpochMs: null,
    });
    const taskRuns = taskReport.invocations.filter(
      (run) => run.adapter === "role-output-normalizer",
    );
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0]?.usage).toEqual(expected);
    expect(taskReport.aggregates.filter((run) => run.adapter === "role-output-normalizer")).toEqual(
      [expect.objectContaining({ invocations: 1, usage: expected })],
    );
    const report = await campaignEvidence(server.url, published.campaignId, 1);
    const campaignRuns = report!.runs.filter((run) => run.adapter === "role-output-normalizer");
    expect(campaignRuns).toHaveLength(1);
    expect(campaignRuns[0]?.usage).toEqual(expected);
    expect(report!.totals.invocations).toBe(taskReport.invocations.length);
    const persisted = await lookupCampaignEvidence(stateDirectory, published.campaignId);
    expect(persisted!.runs.find((run) => run.adapter === "role-output-normalizer")?.usage).toEqual(
      expected,
    );
    const campaign = await getCampaign(server.url, published.campaignId);
    const events = campaignEvidenceToPostHogEvents(campaign!, report!, "fixture-deployment").filter(
      (event) =>
        event.event === "$ai_generation" && event.properties.adapter === "role-output-normalizer",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ $ai_input_tokens: 1000, $ai_output_tokens: 7 });
    if (cacheSupplied)
      expect(events[0]?.properties).toMatchObject({
        $ai_cache_read_input_tokens: 800,
        uncached_input_tokens: 200,
      });
    else expect(events[0]?.properties.$ai_cache_read_input_tokens).toBeNull();
  },
);

test("projects Campaign model invocations, including a normalizer, exactly once", async () => {
  const { stateDirectory, contractPath, server, finished } = await fixture();
  const published = await publishCampaign(server.url, { contractPath });
  await proposeCampaign(server.url, published.campaignId, proposal("one", "outcome-one"));
  await proposeCampaign(server.url, published.campaignId, proposal("two", "outcome-two"));
  await handoffCampaign(server.url, published.campaignId);
  await finished;

  const successfulObservation = {
    status: "completed",
    output: null,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      uncachedInputTokens: 80,
      cacheWriteInputTokens: 4,
      outputTokens: 12,
      reasoningOutputTokens: 5,
    },
    summary: "completed",
    failure: null,
    phase: null,
    failureClass: null,
    requestedProfile: "assessor-profile",
    effectiveProfile: {
      profileName: "assessor-profile",
      configSha256: null,
      adapter: "sdk",
      configuredModel: "configured-assessor",
      configuredProvider: "configured-provider",
      model: "configured-assessor",
      modelProvider: "configured-provider",
      actualModel: "actual-assessor",
      actualProvider: "attested-provider",
      actualModelProvider: "attested-provider",
      reasoningEffort: "high",
      developerInstructionsSha256: null,
      serviceTier: "priority",
    },
    normalizer: {
      status: "succeeded",
      usage: {
        inputTokens: 30,
        cachedInputTokens: 10,
        uncachedInputTokens: 20,
        cacheWriteInputTokens: 1,
        outputTokens: 6,
        reasoningOutputTokens: 2,
      },
      adapter: "role-output-normalizer",
      model: "configured-normalizer",
      modelProvider: "normalizer-provider",
      configuredModel: "configured-normalizer",
      configuredProvider: "normalizer-provider",
      actualModel: "actual-normalizer",
      actualProvider: "attested-normalizer-provider",
      actualModelProvider: "attested-normalizer-provider",
    },
  } satisfies SessionObservation;
  const failedObservation = {
    status: "failed",
    output: null,
    usage: {
      inputTokens: 40,
      cachedInputTokens: 5,
      uncachedInputTokens: 33,
      cacheWriteInputTokens: 2,
      outputTokens: 2,
      reasoningOutputTokens: 1,
    },
    summary: "failed",
    failure: "private provider diagnostic",
    phase: "output",
    failureClass: "transport",
    usageCompleteness: "partial",
  } satisfies SessionObservation;
  const repository = { id: "repo-one", owner: "example", name: "repo-one" };
  const modelRuns = [
    ...campaignModelRunFromObservation(
      "assessor",
      repository,
      "assessor-invocation",
      Date.now() - 10,
      successfulObservation,
    ),
    ...campaignModelRunFromObservation(
      "replacement-planner",
      repository,
      "planner-invocation",
      Date.now() - 20,
      failedObservation,
    ),
  ];
  const noProviderRun = campaignModelRunFromObservation(
    "assessor",
    repository,
    "startup-failure",
    Date.now() - 30,
    {
      ...failedObservation,
      usage: null,
      phase: "startup",
      failureClass: "configuration",
    },
  );
  expect(noProviderRun).toEqual([]);
  const failedNormalizer = campaignModelRunFromObservation(
    "assessor",
    repository,
    "failed-normalizer",
    Date.now() - 40,
    {
      ...successfulObservation,
      status: "failed",
      failureClass: "network",
      normalizer: { ...successfulObservation.normalizer, status: "failed" },
    },
  );
  expect(failedNormalizer[1]).toMatchObject({
    invocationId: "failed-normalizer:role-output-normalizer",
    status: "failed",
    failureClass: "network",
  });
  expect(modelRuns).toHaveLength(3);
  expect(modelRuns.find((run) => run.role === "assessor")?.usage?.coverage).toBe("complete");
  expect(modelRuns.find((run) => run.role === "replacement-planner")?.usage).toMatchObject({
    coverage: "partial",
  });
  const completeButMissingUncached = campaignModelRunFromObservation(
    "assessor",
    repository,
    "complete-but-missing-uncached",
    Date.now() - 50,
    {
      ...successfulObservation,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 9,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      usageCompleteness: "complete",
    },
  );
  expect(completeButMissingUncached[0]?.usage).toEqual({
    inputTokens: 10,
    cachedInputTokens: 9,
    uncachedInputTokens: null,
    cacheWriteInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    coverage: "partial",
  });

  const database = new DatabaseSync(join(stateDirectory, "usine.sqlite"));
  try {
    const insert = database.prepare(
      `INSERT INTO campaign_model_runs (
        invocation_id, campaign_id, outcome_id, role, assessment_id, evidence_hash,
        status, failure_class, started_at_epoch_ms, completed_at_epoch_ms, elapsed_ms,
        repository_id, repository, profile, configured_provider, configured_model,
        actual_provider, actual_model, adapter, service_tier, reasoning_effort, usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const run of modelRuns)
      insert.run(
        run.invocationId,
        published.campaignId,
        "outcome-one",
        run.role,
        run.role === "replacement-planner" ? "assessment-one" : null,
        run.role === "replacement-planner" ? "evidence-one" : null,
        run.status,
        run.failureClass,
        run.startedAtEpochMs,
        run.completedAtEpochMs,
        run.elapsedMs,
        run.repositoryId,
        run.repository,
        run.profile,
        run.configuredProvider,
        run.configuredModel,
        run.actualProvider,
        run.actualModel,
        run.adapter,
        run.serviceTier,
        run.reasoningEffort,
        run.usage === null ? null : JSON.stringify(run.usage),
      );
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM campaign_model_runs WHERE campaign_id = ?")
        .get(published.campaignId),
    ).toEqual({ count: 3 });
  } finally {
    database.close();
  }

  const first = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: null,
    limit: 1,
  });
  const second = await lookupCampaignEvidence(stateDirectory, published.campaignId, {
    cursor: first!.nextCursor,
    limit: 1,
  });
  const campaignRuns = first!.runs.filter((run) => run.taskId === null);
  expect(campaignRuns).toHaveLength(3);
  expect(campaignRuns.map((run) => run.invocationId)).toEqual([
    "assessor-invocation",
    "assessor-invocation:role-output-normalizer",
    "planner-invocation",
  ]);
  expect(campaignRuns[0]).toMatchObject({
    role: "assessor",
    outcome: "succeeded",
    configuredModel: "configured-assessor",
    configuredProvider: "configured-provider",
    actualModel: "actual-assessor",
    actualProvider: "attested-provider",
    profile: "assessor-profile",
    serviceTier: "priority",
    reasoningEffort: "high",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 20,
      uncachedInputTokens: 80,
      outputTokens: 12,
    },
  });
  expect(campaignRuns[1]).toMatchObject({
    invocationId: "assessor-invocation:role-output-normalizer",
    outcome: "succeeded",
    configuredModel: "configured-normalizer",
    configuredProvider: "normalizer-provider",
    actualModel: "actual-normalizer",
    actualProvider: "attested-normalizer-provider",
    adapter: "role-output-normalizer",
    usage: { inputTokens: 30, cachedInputTokens: 10, outputTokens: 6 },
  });
  expect(campaignRuns[2]).toMatchObject({
    role: "replacement-planner",
    outcome: "failed",
    failureClass: "protocol",
    usage: { inputTokens: 40, cachedInputTokens: 5, outputTokens: 2, coverage: "partial" },
  });
  expect(second!.runs.every((run) => run.taskId !== null)).toBe(true);
  const publicReport = await campaignEvidence(server.url, published.campaignId, 1);
  expect(publicReport!.runs.filter((run) => run.taskId === null)).toHaveLength(3);
  expect(publicReport!.totals.invocations).toBe(first!.totals!.invocations);
  expect(new Set(publicReport!.runs.map((run) => run.invocationId)).size).toBe(
    publicReport!.runs.length,
  );
  expect(publicReport!.totals.usage.coverage).toBe("partial");
  expect(
    publicReport!.runs
      .filter((run) => run.taskId === null)
      .reduce((total, run) => total + (run.usage.inputTokens ?? 0), 0),
  ).toBe(170);

  const campaign = await getCampaign(server.url, published.campaignId);
  const postHog = [
    ...campaignEvidenceToPostHogEvents(campaign!, first!, "deployment-test"),
    ...campaignEvidenceToPostHogEvents(campaign!, second!, "deployment-test"),
  ];
  const modelEvents = postHog.filter((event) => event.event === "$ai_generation");
  expect(modelEvents.filter((event) => event.properties.task_id === null)).toHaveLength(3);
  expect(modelEvents.map((event) => event.properties.invocation_id)).toContain(
    "assessor-invocation:role-output-normalizer",
  );
  expect(
    modelEvents.find(
      (event) => event.properties.invocation_id === "assessor-invocation:role-output-normalizer",
    ),
  ).toMatchObject({
    properties: {
      configured_model: "configured-normalizer",
      configured_provider: "normalizer-provider",
      $ai_model: "actual-normalizer",
      $ai_provider: "attested-normalizer-provider",
      adapter: "role-output-normalizer",
    },
  });
  expect(
    modelEvents.find((event) => event.properties.invocation_id === "planner-invocation"),
  ).toMatchObject({
    properties: {
      invocation_id: "planner-invocation",
      $ai_input_tokens: 40,
      $ai_cache_read_input_tokens: 5,
      uncached_input_tokens: 33,
      $ai_cache_creation_input_tokens: 2,
      $ai_output_tokens: 2,
      reasoning_output_tokens: 1,
      token_coverage: "partial",
    },
  });
  expect(JSON.stringify(postHog)).not.toContain("private provider diagnostic");
});

test.each([
  ["transient capacity", "rate_limit", "transient_capacity", "failed"],
  ["transport closure", "transient_transport", "transient_transport", "failed"],
  ["malformed protocol", "transport", "protocol", "failed"],
  ["unusable profile", "configuration", "configuration", "failed"],
  ["cancellation", "cancellation", "cancellation", "cancelled"],
  ["unknown", "unknown", "unknown", "failed"],
] as const)(
  "keeps %s distinct across persisted Task history, Task evidence, Campaign evidence, and PostHog",
  async (_label, providerClass, failureClass, outcome) => {
    const { stateDirectory, contractPath, server, finished } = await fixture({
      providerClass,
      failureClass,
      outcome,
    });
    const published = await publishCampaign(server.url, { contractPath });
    await proposeCampaign(server.url, published.campaignId, proposal("interrupted", "outcome-one"));
    await handoffCampaign(server.url, published.campaignId);
    await finished;

    const persisted = await lookupCampaignEvidence(stateDirectory, published.campaignId);
    const run = persisted?.runs[0];
    expect(run).toMatchObject({ role: "reviewer", outcome, failureClass });
    if (outcome === "failed") expect(persisted?.totals?.terminalTaskCounts[failureClass]).toBe(1);
    else expect(persisted?.totals?.terminalTaskCounts).not.toHaveProperty("cancellation");
    const taskId = run?.taskId;
    expect(taskId).toBeDefined();
    const history = await taskEvents(server.url, taskId!, 0, 100);
    expect(history.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "coding_session_interrupted",
          failureClass,
        }),
      }),
    );
    if (outcome === "failed") {
      expect(history.events).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "review_interrupted",
            failureClass,
          }),
        }),
      );
      expect(history.events.some((event) => event.data.type === "review_completed")).toBe(false);
    }
    const evidence = await taskEvidence(server.url, taskId!);
    expect(evidence?.roleRuns.reviewer[0]?.effort.failureClass).toBe(failureClass);
    expect(evidence?.task.review).toBeNull();

    const campaign = await getCampaign(server.url, published.campaignId);
    const postHog = campaignEvidenceToPostHogEvents(campaign!, persisted!, "deployment-test");
    const progress = postHog.find((event) => event.event === "usine_campaign_progress");
    const roleRun = postHog.find((event) => event.event === "$ai_generation");
    expect(roleRun?.properties.failure_class).toBe(failureClass);
    if (outcome === "failed")
      expect(progress?.properties[`terminal_tasks_${failureClass}`]).toBe(1);
    else expect(progress?.properties).not.toHaveProperty("terminal_tasks_cancellation");
    expect(JSON.stringify(postHog)).not.toContain("private provider diagnostic");
  },
);
