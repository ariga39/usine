import { resolveTaskContract, taskContractSchema } from "@usine/task-authority";
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

test("allows an issue-less Campaign contract and resolves the registered Repository facts", () => {
  const { issue: _issue, ...delivery } = committedContract.delivery;
  const campaign = taskContractSchema.parse({
    ...committedContract,
    authorization: { source: "campaign:campaign-367", delivery: true },
    delivery,
    campaign: {
      campaignId: "campaign-367:v1",
      goalId: "campaign-367",
      goalVersion: 1,
      outcomeId: "outcome-one",
    },
  });
  const resolved = resolveTaskContract(campaign, {
    id: "usine-repository",
    path: "/registered/usine",
    owner: "example",
    name: "usine",
    baseBranch: "main",
    projectCheck: { command: "true", timeoutMs: 1_000 },
  });
  expect(resolved.delivery.issue).toBeUndefined();
  expect(resolved.delivery.baseBranch).toBe("main");
  expect(resolved.campaign).toEqual(campaign.campaign);
});

test("rejects an issue-less standalone Task contract", () => {
  const { issue: _issue, ...delivery } = committedContract.delivery;
  const result = taskContractSchema.safeParse({ ...committedContract, delivery });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues.some((issue) => issue.path.join(".") === "delivery.issue")).toBe(
      true,
    );
});
