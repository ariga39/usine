import { Option } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { CampaignEvidencePage, UsageReport } from "@usine/task-authority";
import { renderCampaignEvidence, renderUsageReport } from "../src/cli-renderer.js";
import { runUsageCommand } from "../src/usage-command.js";

function usageReportRow(
  taskId: string,
  coverage: "complete" | "unavailable" = "complete",
): UsageReport["invocations"][number] {
  return {
    invocationId: `${taskId}:implementer:1:session`,
    taskId,
    pullRequest: null,
    repositoryId: "repo-1",
    repository: "owner/repository",
    role: "implementer",
    activation: 1,
    reviewCycle: null,
    profile: "profile-1",
    configuredModel: "alias-1",
    configuredProvider: "provider-configured",
    actualModel: coverage === "complete" ? "provider/gpt-5" : "unavailable",
    actualProvider: coverage === "complete" ? "provider-reported" : "unavailable",
    provider: "provider-reported",
    adapter: "sdk",
    model: "provider/gpt-5",
    serviceTier: "unavailable",
    reasoningEffort: "minimal",
    outcome: "succeeded",
    occurredAtEpochMs: 100,
    elapsedMs: 1,
    usage: {
      inputTokens: coverage === "complete" ? 10 : null,
      cachedInputTokens: coverage === "complete" ? 2 : null,
      uncachedInputTokens: coverage === "complete" ? 8 : null,
      cacheWriteInputTokens: null,
      outputTokens: coverage === "complete" ? 1 : null,
      reasoningOutputTokens: null,
      coverage,
    },
  };
}

describe("usage command", () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write.bind(process.stdout);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });

  test("uses the persisted usage endpoint and emits machine-readable rows", async () => {
    const output: string[] = [];
    let requested: URL | undefined;
    globalThis.fetch = async (input) => {
      requested = new URL(input instanceof Request ? input.url : String(input));
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          scope: { taskId: null, repositoryId: "repo-1", fromEpochMs: 100, toEpochMs: 200 },
          cursor: null,
          nextCursor: null,
          coverage: "complete",
          invocations: [],
          aggregates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    process.stdout.write = (chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };

    await runUsageCommand(
      {
        taskId: Option.none(),
        repositoryId: Option.some("repo-1"),
        fromEpochMs: Option.some(100),
        toEpochMs: Option.some(200),
        json: true,
      },
      "http://server.test",
    );

    expect(requested?.pathname).toBe("/v1/usage");
    expect(requested?.searchParams.get("repositoryId")).toBe("repo-1");
    expect(requested?.searchParams.get("fromEpochMs")).toBe("100");
    expect(requested?.searchParams.get("limit")).toBe("200");
    expect(JSON.parse(output.join(""))).toMatchObject({ coverage: "complete" });
  });

  test("drains every bounded usage page without repeating or omitting rows", async () => {
    const output: string[] = [];
    const requests: URL[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      const cursor = url.searchParams.get("cursor");
      const invocations =
        cursor === null
          ? [usageReportRow("task-001", "unavailable"), usageReportRow("task-002")]
          : [usageReportRow("task-003")];
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          scope: { taskId: null, repositoryId: "repo-1", fromEpochMs: null, toEpochMs: null },
          cursor,
          nextCursor: cursor === null ? "page-1" : null,
          coverage: "complete",
          invocations,
          aggregates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    process.stdout.write = (chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };

    await runUsageCommand(
      {
        taskId: Option.none(),
        repositoryId: Option.some("repo-1"),
        fromEpochMs: Option.none(),
        toEpochMs: Option.none(),
        json: true,
      },
      "http://server.test",
    );

    const report = JSON.parse(output.join(""));
    expect(report).toMatchObject({
      invocations: [{ taskId: "task-001" }, { taskId: "task-002" }, { taskId: "task-003" }],
      aggregates: [{ taskId: "task-001" }, { taskId: "task-002" }, { taskId: "task-003" }],
      coverage: "partial",
    });
    expect(report.invocations[0]).toMatchObject({
      configuredModel: "alias-1",
      configuredProvider: "provider-configured",
      actualModel: "unavailable",
      actualProvider: "unavailable",
    });
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "page-1"]);
    expect(requests.every((url) => url.searchParams.get("limit") === "200")).toBe(true);
  });

  test("uses the canonical identity vocabulary in human-readable rows", () => {
    const report: UsageReport = {
      schemaVersion: 1,
      scope: { taskId: null, repositoryId: null, fromEpochMs: null, toEpochMs: null },
      coverage: "complete" as const,
      invocations: [usageReportRow("task-identity")],
      aggregates: [],
    };
    const output = renderUsageReport(report, false);
    expect(output).toContain(
      "CONFIGURED_MODEL\tCONFIGURED_PROVIDER\tACTUAL_MODEL\tACTUAL_PROVIDER",
    );
    expect(output).toContain("alias-1\tprovider-configured\tprovider/gpt-5\tprovider-reported");
  });

  test("uses the canonical identity vocabulary in Campaign rows", () => {
    const report: CampaignEvidencePage & { totals: NonNullable<CampaignEvidencePage["totals"]> } = {
      schemaVersion: 1,
      campaignId: "campaign-identity",
      goalId: "goal-identity",
      goalVersion: 1,
      cursor: null,
      nextCursor: null,
      progress: { revision: 1, occurredAtEpochMs: 1 },
      coverage: "complete",
      runs: [
        {
          invocationId: "campaign-identity:implementer:1:session",
          goalVersion: 1,
          outcomeId: "outcome-identity",
          taskId: "task-identity",
          pullRequest: null,
          repositoryId: "repo-identity",
          repository: "owner/repository",
          role: "implementer",
          activation: 1,
          reviewCycle: null,
          configuredModel: "alias-1",
          configuredProvider: "provider-configured",
          actualModel: "provider/gpt-5",
          actualProvider: "provider-reported",
          provider: "provider-reported",
          adapter: "sdk",
          model: "provider/gpt-5",
          outcome: "succeeded",
          failureClass: null,
          occurredAtEpochMs: 1,
          elapsedMs: 1,
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            cacheWriteInputTokens: null,
            outputTokens: 1,
            reasoningOutputTokens: null,
            coverage: "complete",
          },
        },
      ],
      aggregates: [],
      totals: {
        invocations: 1,
        elapsedMs: 1,
        reviewCycles: 0,
        repairBatches: 0,
        blockedProposals: 0,
        guardianTouches: 0,
        acceptedDeliveries: 0,
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
          inputTokens: 1,
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          cacheWriteInputTokens: null,
          outputTokens: 1,
          reasoningOutputTokens: null,
          coverage: "complete",
        },
      },
      touches: [],
      deliveries: [],
    };
    const output = renderCampaignEvidence(report, false);
    expect(output).toContain(
      "CONFIGURED_MODEL\tCONFIGURED_PROVIDER\tACTUAL_MODEL\tACTUAL_PROVIDER",
    );
    expect(output).toContain("alias-1\tprovider-configured\tprovider/gpt-5\tprovider-reported");
  });
});
