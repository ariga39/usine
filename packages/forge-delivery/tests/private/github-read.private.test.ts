import { describe, expect, test } from "vite-plus/test";
import {
  CodexCodingSession,
  codexMcpConfig,
  explicitWorkerEnvironment,
  implementerOutputSchema,
} from "@usine/coding-session";
import type { TaskContract } from "@usine/task-authority";
import { startGithubReadMcpHttp } from "../../src/index.js";

const enabled = process.env.USINE_PRIVATE_GITHUB_READ_TEST === "1";

describe.skipIf(!enabled)("private GitHub read characterization", () => {
  test("a real CodexCodingSession reads the authorized Issue without worker credentials", async () => {
    const owner = required("USINE_PRIVATE_GITHUB_READ_OWNER");
    const name = required("USINE_PRIVATE_GITHUB_READ_REPOSITORY");
    const issueNumber = positiveNumber("USINE_PRIVATE_GITHUB_READ_ISSUE");
    const token = required("USINE_PRIVATE_GITHUB_READ_TOKEN");
    const apiUrl = required("USINE_PRIVATE_GITHUB_READ_API_URL");
    const codexHome = required("USINE_PRIVATE_GITHUB_READ_CODEX_HOME");
    const profile = required("USINE_PRIVATE_GITHUB_READ_CODEX_PROFILE");
    const stateDirectory = required("USINE_PRIVATE_GITHUB_READ_STATE_DIR");
    const workspace = required("USINE_PRIVATE_GITHUB_READ_WORKSPACE");
    const taskId = required("USINE_PRIVATE_GITHUB_READ_TASK_ID");
    const attempt = required("USINE_PRIVATE_GITHUB_READ_ATTEMPT");
    const contract = characterizationContract(taskId, owner, name, issueNumber);
    const apiPaths: string[] = [];
    let actualIssueTitle: string | undefined;
    const host = await startGithubReadMcpHttp({
      repository: { owner, name },
      issueNumber,
      role: "implementer",
      tools: ["github_issue_get"],
      policy: {
        mode: "test",
        appSlug: "private-read-characterization",
        token,
        apiUrl,
      },
      deadlineEpochMs: Date.now() + 120_000,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        apiPaths.push(url.pathname);
        const response = await globalThis.fetch(input, init);
        if (url.pathname === `/repos/${owner}/${name}/issues/${issueNumber}`) {
          const payload: unknown = await response.clone().json();
          if (typeof payload === "object" && payload !== null && "title" in payload) {
            const title = payload.title;
            if (typeof title === "string") actualIssueTitle = title;
          }
        }
        return response;
      },
    });
    const mcpServer = {
      name: "github_read_implementer",
      url: host.url,
      enabledTools: ["github_issue_get"],
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
      required: true,
    } as const;
    const environment = explicitWorkerEnvironment({ ...process.env, CODEX_HOME: codexHome });
    const prompt = [
      `Use github_issue_get for ${owner}/${name} Issue ${issueNumber}.`,
      "Read the authorized Issue before answering.",
      "Return the exact Issue title in summary and set status to proposed.",
    ].join("\n");
    const observations: unknown[] = [];
    try {
      expect(prompt).not.toContain(token);
      expect(JSON.stringify(codexMcpConfig(mcpServer))).not.toContain(token);
      expect(JSON.stringify(explicitWorkerEnvironment(environment))).not.toContain(token);
      const observation = await new CodexCodingSession(undefined, {
        environment,
        executionStateDirectory: stateDirectory,
      }).run({
        role: "implementer",
        workspace,
        contract,
        prompt,
        profile,
        sandbox: "workspace-write",
        deadlineEpochMs: Date.now() + 120_000,
        outputSchema: implementerOutputSchema,
        mcpServer,
        execution: { taskId, role: "implementer", attempt },
        environment,
        onObservation: (event) => {
          observations.push(event);
        },
      });
      expect(observation.status).toBe("completed");
      expect(observation.output).toMatchObject({ status: "proposed" });
      if (typeof actualIssueTitle !== "string")
        throw new Error("host did not observe the authorized Issue title");
      const summaryContainsIssueTitle =
        typeof observation.output?.summary === "string" &&
        observation.output.summary.includes(actualIssueTitle);
      expect(summaryContainsIssueTitle).toBe(true);
      expect(observations).toContainEqual({
        type: "mcp_tool_completed",
        server: "github_read_implementer",
        tool: "github_issue_get",
        outcome: "succeeded",
      });
      expect(apiPaths).toContain(`/repos/${owner}/${name}/issues/${issueNumber}`);
      expect(JSON.stringify(observation)).not.toContain(token);
      expect(JSON.stringify(observations)).not.toContain(token);
      expect(JSON.stringify(mcpServer)).not.toContain(token);
      expect(JSON.stringify(environment)).not.toContain(token);
    } finally {
      await host.close();
    }
  }, 150_000);
});

function characterizationContract(
  id: string,
  owner: string,
  name: string,
  issue: number,
): TaskContract {
  return {
    id,
    repositoryId: "private-read-characterization",
    baseSha: "a".repeat(40),
    instructions: "Read the authorized Issue through the configured host MCP.",
    acceptance: ["The authorized Issue is read through MCP."],
    nonGoals: ["delivery"],
    budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 120_000 },
    authorization: {
      source: `https://github.com/${owner}/${name}/issues/${issue}`,
      delivery: true,
    },
    delivery: {
      branch: "private-read-characterization",
      issue,
      title: "Private read characterization",
      body: "Private read characterization",
    },
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when private characterization is enabled`);
  return value;
}

function positiveNumber(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
