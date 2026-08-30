import { describe, expect, test } from "vite-plus/test";
import { renderTaskEvidence, type TaskEvidence } from "../src/task-evidence.js";

describe("task evidence", () => {
  test("renders separate implementer and reviewer Role Runs for one exact Task outcome", () => {
    const evidence: TaskEvidence = {
      schemaVersion: 1,
      taskId: "evidence-task",
      roleRuns: {
        implementer: [
          {
            role: "implementer",
            activation: 1,
            requestedProfile: "writer-profile",
            effectiveProfile: {
              profileName: "writer-profile",
              configSha256: "1".repeat(64),
              adapter: "sdk",
              model: "writer-model",
              modelProvider: "openai",
              reasoningEffort: "low",
              developerInstructionsSha256: "2".repeat(64),
            },
            effort: {
              phase: "output",
              failureClass: null,
              observations: [{ type: "turn_completed", turn: 1, outcome: "succeeded" }],
            },
            usage: { inputTokens: 12, outputTokens: 7 },
            archive: { archiveId: "archive_writer", status: "complete" },
            outcome: { status: "succeeded", candidateSha: "a".repeat(40) },
          },
        ],
        reviewer: [
          {
            role: "reviewer",
            activation: 1,
            requestedProfile: "review-profile",
            effectiveProfile: {
              profileName: "review-profile",
              configSha256: "3".repeat(64),
              adapter: "app-server",
              model: "review-model",
              modelProvider: "openai",
              reasoningEffort: "high",
              developerInstructionsSha256: "4".repeat(64),
            },
            effort: {
              phase: "output",
              failureClass: null,
              observations: [{ type: "turn_completed", turn: 1, outcome: "succeeded" }],
            },
            usage: { inputTokens: 5, outputTokens: 3 },
            archive: { archiveId: "archive_reviewer", status: "complete" },
            outcome: { status: "succeeded", candidateSha: "a".repeat(40) },
          },
        ],
      },
      task: {
        state: "reviewed_pr",
        candidateSha: "a".repeat(40),
        relation: "accepted_exact_sha",
      },
    };

    expect(JSON.parse(renderTaskEvidence(evidence, true))).toEqual(evidence);
    expect(renderTaskEvidence(evidence, false)).toContain("IMPLEMENTER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("REVIEWER ROLE RUNS");
    expect(renderTaskEvidence(evidence, false)).toContain("accepted_exact_sha");
  });
});
