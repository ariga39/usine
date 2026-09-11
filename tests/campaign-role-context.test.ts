import { afterEach, expect, test, vi } from "vite-plus/test";
import { CodexCodingSession, type CodingSessionClientFactory } from "@usine/coding-session";
import {
  goalContractSchema,
  type CampaignAssessmentFact,
  type CampaignAssessment,
} from "@usine/task-authority";
import {
  createCampaignOutcomeAssessor,
  type CampaignAssessmentRequest,
} from "../packages/runtime/src/campaign-assessor.js";
import {
  createCampaignReplacementGenerator,
  type CampaignReplacementRequest,
} from "../packages/runtime/src/campaign-replacement.js";
import { campaignAssessmentFactId } from "../packages/runtime/src/campaign-assessment-reference.js";

afterEach(() => vi.restoreAllMocks());

function captureSdkRequests(assessmentEvidence: readonly unknown[] = []) {
  const calls: { prompt: string; schema: unknown }[] = [];
  const callers: Parameters<CodexCodingSession["run"]>[0][] = [];
  let threads = 0;
  const factory: CodingSessionClientFactory = async (request) => {
    type Thread = ReturnType<Awaited<ReturnType<CodingSessionClientFactory>>["startThread"]>;
    return {
      startThread: () => {
        const id = `fresh-${++threads}`;
        return {
          id,
          runStreamed: async (prompt, options) => {
            if (typeof prompt !== "string") throw new Error("expected text input");
            calls.push({ prompt, schema: options?.outputSchema });
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: id };
                yield { type: "turn.started" };
                yield {
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    id: "message",
                    text:
                      request.role === "replacement-planner"
                        ? "null"
                        : JSON.stringify({
                            verdict: "inconclusive",
                            summary: "fixture",
                            gaps: [],
                            evidence: assessmentEvidence,
                          }),
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                };
              })(),
            };
          },
        } as Thread;
      },
    } as Awaited<ReturnType<CodingSessionClientFactory>>;
  };
  const fixture = new CodexCodingSession(factory, {
    environment: {},
    profileResolver: async () => ({ model: "fixture" }),
  });
  const original = fixture.run.bind(fixture);
  vi.spyOn(CodexCodingSession.prototype, "run").mockImplementation((request) => {
    callers.push(request);
    return original(request);
  });
  return { calls, callers, threads: () => threads };
}

const sha = "a".repeat(40);
const criteria = [
  { id: "required", criterion: "Must work", mandatory: true, checkId: "behavior" },
  { id: "optional", criterion: "Nice to have", mandatory: false },
];
const outcome: CampaignAssessmentRequest["outcome"] = {
  id: "outcome",
  title: "Ship behavior",
  acceptance: criteria.map((c) => c.criterion),
  criteria,
  dependsOn: [],
  parentId: null,
  status: "live",
};
const goal = goalContractSchema.parse({
  id: "goal",
  version: 1,
  objective: "Deliver useful behavior",
  outcomes: [
    { id: outcome.id, title: outcome.title, acceptance: criteria, dependsOn: [] },
    {
      id: "later",
      title: "Keep downstream context",
      acceptance: ["Later"],
      dependsOn: ["outcome"],
    },
  ],
  authority: {
    source: "user",
    publish: true,
    repositories: ["repo-b", "repo-a"],
    effects: ["read", "github"],
  },
  warningThresholdMs: 1000,
});
const evidence: CampaignAssessmentFact[] = [
  {
    repositoryId: "repo-b",
    proposalId: "proposal",
    taskId: "task",
    fact: "candidate",
    status: "frozen",
    sha,
    candidateObservedAtEpochMs: 42,
  },
  {
    repositoryId: "repo-b",
    proposalId: "proposal",
    taskId: "task",
    fact: "check",
    status: "passed",
    sha,
    candidateObservedAtEpochMs: 42,
    criterionId: "required",
    criterion: "Must work",
    mandatory: true,
    checkId: "behavior",
    artifact: "exact_candidate_checkout",
  },
];
const repositories = ["repo-b", "repo-a"].map((id) => ({
  id,
  path: ".",
  owner: "fixture",
  name: id,
  reviewerProfile: "fixture",
  baseSha: sha,
  headSha: sha,
  baseBranch: "main",
}));
function assessorRequest(): CampaignAssessmentRequest {
  return {
    invocationId: "invocation",
    campaignId: "campaign",
    goalId: goal.id,
    goalVersion: goal.version,
    goal,
    outcome,
    evidence,
    repositories,
    environment: {},
  };
}
function plannerRequest(): CampaignReplacementRequest {
  const assessment: CampaignAssessment = {
    role: "assessor",
    assessmentId: "assessment",
    outcomeId: outcome.id,
    evidenceHash: "evidence-hash",
    verdict: "gaps",
    summary: "Repair required behavior",
    gaps: ["Must work"],
    evidence: evidence.map((fact) => ({ ...fact, criterionIndex: 0 })),
    usage: null,
    startedAtEpochMs: 100,
    completedAtEpochMs: 200,
  };
  return {
    ...assessorRequest(),
    assessment,
    evidenceHash: assessment.evidenceHash,
    priorProposals: ["proposal-b", "proposal-a"].map((proposalId) => ({
      proposalId,
      outcomeId: outcome.id,
      repositoryId: "repo-b",
      instructions: "Implement behavior",
      acceptance: criteria,
      dependsOn: ["earlier-b", "earlier-a"],
      nonGoals: [],
      effects: ["github", "read"],
      merge: false,
    })),
    supersedableProposalIds: ["proposal-b", "proposal-a"],
    rejectionFeedback: null,
    repositories,
  };
}
function section(prompt: string, label: string): unknown {
  const line = prompt.split("\n").find((line) => line.startsWith(`${label}: `));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(label.length + 2));
}

type PromptEvidence = { fact: CampaignAssessmentFact; evidenceId: string };

function promptEvidence(prompt: string): PromptEvidence[] {
  const value = section(prompt, "Exact evidence facts");
  if (!Array.isArray(value)) throw new Error("expected exact evidence facts array");
  return value as PromptEvidence[];
}
function prefix(prompt: string, boundary: string) {
  expect(prompt).toContain(boundary);
  return prompt.slice(0, prompt.indexOf(boundary));
}

test("assessor sends stable requirements and ordered exact facts through the SDK boundary", async () => {
  const seam = captureSdkRequests();
  const assess = createCampaignOutcomeAssessor();
  const request = assessorRequest();
  expect((await assess(request)).verdict).toBe("inconclusive");
  await assess({
    ...request,
    invocationId: "another",
    evidence: [...evidence]
      .reverse()
      .map(({ sha: factSha, ...fact }) => ({ sha: factSha, ...fact })),
  });
  expect(seam.calls).toHaveLength(2);
  expect(seam.calls[0]).toEqual(seam.calls[1]);
  expect(section(seam.calls[0]!.prompt, "Outcome requirements")).toEqual(outcome);
  expect(seam.calls[0]!.prompt).toContain(
    "exact candidate, review, and delivery evidence, plus selected check evidence when that condition names a checker",
  );
  expect(seam.calls[0]!.prompt).toContain(
    "a criterion without a selected checker must not acquire one from generic instructions",
  );
  expect(promptEvidence(seam.calls[0]!.prompt).map((item) => item.fact)).toEqual(
    expect.arrayContaining(evidence),
  );
  expect(
    promptEvidence(seam.calls[0]!.prompt).every(
      (item) => typeof item.evidenceId === "string" && item.evidenceId.startsWith("fact-"),
    ),
  ).toBe(true);
  await assess({
    ...request,
    evidence: evidence.map((fact) => ({
      ...fact,
      sha: "b".repeat(40),
      candidateObservedAtEpochMs: 43,
    })),
  });
  expect(prefix(seam.calls[2]!.prompt, "Exact evidence facts:")).toBe(
    prefix(seam.calls[0]!.prompt, "Exact evidence facts:"),
  );
  expect(seam.calls[2]!.prompt).toContain('"candidateObservedAtEpochMs":43');
  expect(seam.calls[2]!.prompt).toContain("b".repeat(40));
  const late = {
    id: "late",
    criterion: "New required behavior",
    mandatory: true,
    checkId: "late-check",
  };
  await assess({
    ...request,
    outcome: {
      ...outcome,
      acceptance: [...outcome.acceptance, late.criterion],
      criteria: [...criteria, late],
    },
  });
  expect(seam.calls[3]!.prompt).not.toBe(seam.calls[0]!.prompt);
  expect(section(seam.calls[3]!.prompt, "Outcome requirements")).toMatchObject({
    criteria: [...criteria, late],
  });
  expect(promptEvidence(seam.calls[3]!.prompt)).toEqual(promptEvidence(seam.calls[0]!.prompt));
  expect(
    seam.calls.every(
      (call) => JSON.stringify(call.schema) === JSON.stringify(seam.calls[0]!.schema),
    ),
  ).toBe(true);
  expect(seam.threads()).toBe(4);
});

test("default assessor accepts a compact 33-reference response shape", async () => {
  const assessmentEvidence = Array.from({ length: 33 }, (_, criterionIndex) => ({
    criterionIndex,
    evidenceId: `fact-${"a".repeat(64)}`,
  }));
  const seam = captureSdkRequests(assessmentEvidence);
  const assess = createCampaignOutcomeAssessor();
  const result = await assess(assessorRequest());
  expect(result.evidence).toHaveLength(33);
  expect(seam.calls[0]!.schema).toBeDefined();
});

test("fact references remain stable when nested observation keys are reordered", () => {
  const left = {
    ...evidence[1]!,
    checkObservation: { artifact: "artifact", entry: "entry", observation: "observation" },
  };
  const right = {
    ...evidence[1]!,
    checkObservation: { observation: "observation", artifact: "artifact", entry: "entry" },
  };
  expect(campaignAssessmentFactId(left)).toBe(campaignAssessmentFactId(right));
});

test("compact report references reduce a deterministic representative payload", () => {
  const factKinds = ["candidate", "check", "review", "delivery"] as const;
  const representativeFacts: CampaignAssessmentFact[] = Array.from({ length: 132 }, (_, index) => ({
    ...evidence[0]!,
    fact: factKinds[index % factKinds.length]!,
    status: "passed",
    criterionId: `criterion-${Math.floor(index / 4)}`,
    criterion: `Criterion ${Math.floor(index / 4)} is delivered.`,
    mandatory: true,
    ...(index % factKinds.length === 1 ? { checkId: `check-${Math.floor(index / 4)}` } : {}),
    ...(index % factKinds.length === 2
      ? { reviewSummary: "fixture approved", reviewFindings: [] }
      : {}),
    ...(index % factKinds.length === 3
      ? { deliveryPrNumber: 1, deliveryAttestationId: "fixture-delivery" }
      : {}),
  }));
  const legacyOutput = representativeFacts.map((fact, index) => ({
    ...fact,
    criterionIndex: Math.floor(index / 4),
  }));
  const compactOutput = representativeFacts.map((fact, index) => ({
    criterionIndex: Math.floor(index / 4),
    evidenceId: campaignAssessmentFactId(fact),
  }));
  const legacyInputBytes = Buffer.byteLength(
    JSON.stringify({ evidence: representativeFacts }),
    "utf8",
  );
  const compactInputBytes = Buffer.byteLength(
    JSON.stringify({
      evidence: representativeFacts.map((fact) => ({
        evidenceId: campaignAssessmentFactId(fact),
        fact,
      })),
    }),
    "utf8",
  );
  const legacyOutputBytes = Buffer.byteLength(JSON.stringify(legacyOutput), "utf8");
  const compactOutputBytes = Buffer.byteLength(JSON.stringify(compactOutput), "utf8");

  expect({
    legacyInputBytes,
    compactInputBytes,
    legacyOutputBytes,
    compactOutputBytes,
  }).toEqual({
    legacyInputBytes: 40052,
    compactInputBytes: 52460,
    legacyOutputBytes: 42639,
    compactOutputBytes: 14085,
  });
  expect(compactOutput).toHaveLength(132);
  expect(compactInputBytes).toBeGreaterThan(legacyInputBytes);
  expect(compactOutputBytes).toBeLessThan(legacyOutputBytes);
});

test("planner excludes accounting churn but retains requirements, authority and evidence lineage", async () => {
  const seam = captureSdkRequests();
  const plan = createCampaignReplacementGenerator();
  const request = plannerRequest();
  expect((await plan(request)).proposal).toBeNull();
  await plan({
    ...request,
    invocationId: "another",
    goal: {
      ...goal,
      warningThresholdMs: 9999,
      authority: {
        ...goal.authority,
        repositories: [...goal.authority.repositories].reverse(),
        effects: [...goal.authority.effects].reverse(),
      },
    },
    assessment: {
      ...request.assessment,
      startedAtEpochMs: 900,
      completedAtEpochMs: 950,
      usageSource: "model_run",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 5,
        uncachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
    },
    evidence: [...evidence].reverse(),
    priorProposals: request.priorProposals.map((proposal) => ({
      ...proposal,
      effects: [...proposal.effects].reverse(),
    })),
    supersedableProposalIds: [...request.supersedableProposalIds].reverse(),
    repositories: [...repositories].reverse(),
  });
  expect(seam.calls).toHaveLength(2);
  expect(seam.calls[0]).toEqual(seam.calls[1]);
  expect(seam.callers[0]!.profile).toBe(repositories[0]!.reviewerProfile);
  const planning = section(seam.calls[0]!.prompt, "Planning context");
  expect(planning).toMatchObject({
    goal: {
      outcomes: goal.outcomes,
      authority: {
        ...goal.authority,
        repositories: ["repo-a", "repo-b"],
        effects: ["github", "read"],
      },
    },
    outcome,
    priorProposals: request.priorProposals,
  });
  const dynamic = section(seam.calls[0]!.prompt, "Current assessment and evidence");
  expect(dynamic).toMatchObject({
    assessment: {
      assessmentId: "assessment",
      evidenceHash: "evidence-hash",
      evidence: expect.arrayContaining([...request.assessment.evidence]),
    },
    evidence: expect.arrayContaining(evidence),
  });
  expect(seam.calls[0]!.prompt).not.toMatch(
    /warningThresholdMs|startedAtEpochMs|completedAtEpochMs|"usage"|reviewerProfile|"path"/,
  );
  await plan({
    ...request,
    assessment: { ...request.assessment, assessmentId: "new-assessment", evidenceHash: "new-hash" },
    evidence: evidence.map((fact) => ({ ...fact, sha: "c".repeat(40) })),
    repositories: repositories.map((repo) => ({ ...repo, headSha: "c".repeat(40) })),
  });
  expect(prefix(seam.calls[2]!.prompt, "Current assessment and evidence:")).toBe(
    prefix(seam.calls[0]!.prompt, "Current assessment and evidence:"),
  );
  expect(seam.calls[2]!.prompt).toContain("new-assessment");
  expect(seam.calls[2]!.prompt).toContain("new-hash");
  expect(seam.calls[2]!.prompt).toContain("c".repeat(40));
  await plan({
    ...request,
    outcome: { ...outcome, acceptance: [...outcome.acceptance, "Late requirement"] },
  });
  expect(section(seam.calls[3]!.prompt, "Planning context")).not.toEqual(planning);
  expect(section(seam.calls[3]!.prompt, "Current assessment and evidence")).toEqual(dynamic);
  expect(
    seam.calls.every(
      (call) => JSON.stringify(call.schema) === JSON.stringify(seam.calls[0]!.schema),
    ),
  ).toBe(true);
  await plan({ ...request, priorProposals: [...request.priorProposals].reverse() });
  expect(section(seam.calls[4]!.prompt, "Planning context")).toMatchObject({
    priorProposals: [...request.priorProposals].reverse(),
  });
  expect(seam.calls[4]!.prompt).not.toBe(seam.calls[0]!.prompt);
  expect(seam.threads()).toBe(5);
});
