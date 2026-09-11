import {
  campaignResourceFromContract,
  resolveTaskContract,
  taskContractSchema,
  taskProposalSchema,
  type CampaignAssessment,
  type GoalContract,
} from "@usine/task-authority";
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
  test.each([null, 4])("accepts a repair/review count policy of %s", (limit) => {
    const parsed = taskContractSchema.parse({
      ...committedContract,
      budget: {
        maxImplementerActivations: limit,
        maxReviewCycles: limit,
        maxElapsedMs: 1_000,
      },
    });
    expect(JSON.parse(JSON.stringify(parsed)).budget).toEqual({
      maxImplementerActivations: limit,
      maxReviewCycles: limit,
      maxElapsedMs: 1_000,
    });
  });

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

test("allows a Campaign Task Issue that is separate from the Goal Issue", () => {
  const campaign = taskContractSchema.parse({
    ...committedContract,
    authorization: {
      source: "https://github.com/example/usine/issues/2",
      delivery: true,
    },
    delivery: { ...committedContract.delivery, issue: 3 },
    campaign: {
      campaignId: "campaign-367:v1",
      goalId: "campaign-367",
      goalVersion: 1,
      outcomeId: "outcome-one",
    },
  });
  expect(
    resolveTaskContract(campaign, {
      id: "usine-repository",
      path: "/registered/usine",
      owner: "example",
      name: "usine",
      baseBranch: "main",
      projectCheck: { command: "true", timeoutMs: 1_000 },
    }).delivery.issue,
  ).toBe(3);
});

test.each([0, -1, 1.5])(
  "rejects a non-positive or non-integer proposal Task Issue: %s",
  (issue) => {
    expect(
      taskProposalSchema.safeParse({
        proposalId: "proposal-test",
        outcomeId: "outcome-test",
        repositoryId: "usine-repository",
        instructions: "Implement the task.",
        acceptance: ["The task is complete."],
        nonGoals: [],
        effects: ["github"],
        budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
        delivery: { issue },
      }).success,
    ).toBe(false);
  },
);

test("rejects an issue-less standalone Task contract", () => {
  const { issue: _issue, ...delivery } = committedContract.delivery;
  const result = taskContractSchema.safeParse({ ...committedContract, delivery });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues.some((issue) => issue.path.join(".") === "delivery.issue")).toBe(
      true,
    );
});

test("does not display an assessed Outcome as accepted without verified evidence", () => {
  const contract = {
    schemaVersion: 1,
    id: "assessment-projection-test",
    version: 1,
    objective: "Keep assessment display subordinate to verified evidence.",
    outcomes: [
      {
        id: "outcome-one",
        title: "Verify the first Outcome",
        acceptance: ["The first Outcome has verified evidence."],
        dependsOn: [],
        parentId: null,
        status: "live",
      },
    ],
    authority: {
      source: "https://github.com/example/usine/issues/403",
      publish: true,
      delivery: true,
      merge: false,
      repositories: [],
      effects: [],
    },
  } satisfies GoalContract;
  const assessment = {
    role: "assessor",
    assessmentId: "assessment-one",
    outcomeId: "outcome-one",
    evidenceHash: "evidence-hash",
    verdict: "satisfied",
    summary: "the assessor claims satisfaction",
    gaps: [],
    evidence: [],
    usage: null,
    startedAtEpochMs: 1,
    completedAtEpochMs: 2,
  } satisfies CampaignAssessment;

  const resource = campaignResourceFromContract(contract, "contract-hash", "planning", 1, {
    proposals: [],
    planHandedOff: false,
    decisionRequest: null,
    assessments: new Map([["outcome-one", assessment]]),
  });

  expect(resource.outcomes[0]?.assessment?.verdict).toBe("satisfied");
  expect(resource.outcomes[0]?.status).toBe("planned");
});
