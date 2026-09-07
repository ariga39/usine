import { describe, expect, test } from "vite-plus/test";
import {
  externalReviewBlocksMerge,
  reviewIdentity,
  type GithubReviewEvidence,
} from "../src/external-review.js";

const headSha = "a".repeat(40);

function evidence(reviews: GithubReviewEvidence["reviews"]): GithubReviewEvidence {
  return { reviews, comments: [], reviewComments: [], reviewsTruncated: false };
}

describe("external GitHub review policy", () => {
  test("uses stable user and verified App identities, never display text", () => {
    expect(
      reviewIdentity({
        user: { id: 7, login: "trusted-name" },
        performedViaGithubApp: { id: 42, slug: "trusted-app" },
      }),
    ).toEqual({ kind: "app", id: 42, slug: "trusted-app" });
    expect(
      reviewIdentity({ user: { id: 7, login: "renamed-user" }, performedViaGithubApp: null }),
    ).toEqual({ kind: "user", id: 7, login: "renamed-user" });
    expect(
      externalReviewBlocksMerge(
        { requireApproval: true, trustedUsers: [7], trustedApps: [] },
        evidence([
          {
            id: 1,
            state: "APPROVED",
            commitSha: headSha,
            body: "<!-- trusted-name --> copied wording",
            identity: { kind: "user", id: 99, login: "untrusted" },
            createdAt: null,
            submittedAt: null,
            updatedAt: null,
          },
        ]),
        headSha,
      ),
    ).toContain("trusted external approval");
  });

  test("requires a trusted current-head approval and honors current-head changes", () => {
    const policy = { requireApproval: true, trustedUsers: [7], trustedApps: [42] } as const;
    const approved = {
      id: 1,
      state: "APPROVED",
      commitSha: headSha,
      body: "approved",
      identity: { kind: "user" as const, id: 7, login: "reviewer" },
      createdAt: null,
      submittedAt: null,
      updatedAt: null,
    };
    expect(externalReviewBlocksMerge(policy, evidence([approved]), headSha)).toBeNull();
    expect(
      externalReviewBlocksMerge(
        policy,
        evidence([{ ...approved, commitSha: "b".repeat(40) }]),
        headSha,
      ),
    ).toContain("trusted external approval");
    expect(
      externalReviewBlocksMerge(
        policy,
        evidence([
          approved,
          {
            ...approved,
            id: 2,
            state: "CHANGES_REQUESTED",
            identity: { kind: "app", id: 42, slug: "review-app" },
          },
        ]),
        headSha,
      ),
    ).toContain("requested changes");
  });

  test("uses the latest decisive review for each trusted identity", () => {
    const policy = { requireApproval: true, trustedUsers: [7], trustedApps: [42] } as const;
    const review = {
      id: 1,
      state: "CHANGES_REQUESTED",
      commitSha: headSha,
      body: "changes",
      identity: { kind: "user" as const, id: 7, login: "reviewer" },
      createdAt: "2026-09-08T00:00:00Z",
      submittedAt: "2026-09-08T00:00:00Z",
      updatedAt: null,
    };
    const approval = {
      ...review,
      id: 2,
      state: "APPROVED",
      body: "approved",
      createdAt: "2026-09-08T00:01:00Z",
      submittedAt: "2026-09-08T00:01:00Z",
    };
    const laterChanges = {
      ...review,
      id: 3,
      createdAt: "2026-09-08T00:02:00Z",
      submittedAt: "2026-09-08T00:02:00Z",
    };
    expect(externalReviewBlocksMerge(policy, evidence([review, approval]), headSha)).toBeNull();
    expect(
      externalReviewBlocksMerge(policy, evidence([approval, laterChanges]), headSha),
    ).toContain("requested changes");
    expect(
      externalReviewBlocksMerge(
        policy,
        evidence([
          { ...approval, identity: { kind: "app", id: 42, slug: "review-app" } },
          { ...laterChanges, identity: { kind: "app", id: 42, slug: "review-app" } },
        ]),
        headSha,
      ),
    ).toContain("requested changes");
    expect(
      externalReviewBlocksMerge(
        policy,
        evidence([
          { ...review, identity: { kind: "app", id: 42, slug: "review-app" } },
          { ...approval, identity: { kind: "app", id: 42, slug: "review-app" } },
        ]),
        headSha,
      ),
    ).toBeNull();
    expect(
      externalReviewBlocksMerge(policy, evidence([{ ...approval, state: "PENDING" }]), headSha),
    ).toContain("trusted external approval");
  });

  test("fails closed when native review evidence overflows its bound", () => {
    const approved = {
      id: 1,
      state: "APPROVED",
      commitSha: headSha,
      body: "approved",
      identity: { kind: "user" as const, id: 7, login: "reviewer" },
      createdAt: null,
      submittedAt: null,
      updatedAt: null,
    };
    expect(
      externalReviewBlocksMerge(
        { requireApproval: true, trustedUsers: [7], trustedApps: [] },
        { ...evidence([approved]), reviewsTruncated: true },
        headSha,
      ),
    ).toContain("truncated");
  });

  test("disabled or omitted policy has no lifecycle effect", () => {
    const requested = evidence([
      {
        id: 1,
        state: "CHANGES_REQUESTED",
        commitSha: headSha,
        body: "changes",
        identity: { kind: "user", id: 7, login: "reviewer" },
        createdAt: null,
        submittedAt: null,
        updatedAt: null,
      },
    ]);
    expect(
      externalReviewBlocksMerge(
        { requireApproval: false, trustedUsers: [7], trustedApps: [] },
        requested,
        headSha,
      ),
    ).toBeNull();
  });
});
