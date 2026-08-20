import { taskContractSchema } from "@usine/task-authority";
import { describe, expect, test } from "vite-plus/test";

const committedContract = {
  id: "contract-test",
  repositoryId: "usine-repository",
  baseSha: "a".repeat(40),
  instructions: "Validate repository registration references.",
  acceptance: ["A task names a registered repository by ID."],
  nonGoals: [],
  budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
  authorization: { source: "https://github.com/example/usine/issues/1", delivery: true },
  delivery: {
    branch: "agent/contract-test",
    issue: 1,
    title: "Contract test",
    body: "Contract test",
  },
};

describe("Task Contract repository reference", () => {
  test("accepts a stable repository ID without repository facts", () => {
    expect(taskContractSchema.safeParse(committedContract).success).toBe(true);
  });

  test("rejects caller-owned repository facts and default policy duplication", () => {
    const result = taskContractSchema.safeParse({
      ...committedContract,
      repository: { path: ".", owner: "example", name: "usine" },
      projectCheck: { command: "true", timeoutMs: 1_000 },
      delivery: { ...committedContract.delivery, baseBranch: "main" },
    });
    expect(result.success).toBe(false);
  });
});

describe("Task Contract authorization source", () => {
  test.each([
    { name: "missing", contract: { ...committedContract, authorization: { delivery: true } } },
    { name: "malformed", source: "github.com/example/usine/issues/1" },
    { name: "non-GitHub", source: "https://gitlab.com/example/usine/-/issues/1" },
    { name: "pull-request", source: "https://github.com/example/usine/pull/1" },
    { name: "query", source: "https://github.com/example/usine/issues/1?tab=comments" },
    { name: "fragment", source: "https://github.com/example/usine/issues/1#discussion" },
  ])("rejects $name authorization source", ({ contract, source }) => {
    const result = taskContractSchema.safeParse(
      contract ?? {
        ...committedContract,
        authorization: { ...committedContract.authorization, source },
      },
    );
    expect(result.success).toBe(false);
  });
});

test("rejects whitespace-only task and delivery identifiers", () => {
  expect(
    taskContractSchema.safeParse({
      ...committedContract,
      repositoryId: " \t\n ",
      delivery: { ...committedContract.delivery, branch: " \t\n " },
    }).success,
  ).toBe(false);
});
