import { taskContractSchema } from "@usine/task-authority";
import { describe, expect, test } from "vite-plus/test";

const committedContract = {
  id: "contract-test",
  repository: { path: ".", owner: "example", name: "usine" },
  baseSha: "a".repeat(40),
  instructions: "Validate repository path handling.",
  acceptance: ["Repository paths use the native JSON contract."],
  nonGoals: [],
  projectCheck: { command: "true", timeoutMs: 1_000 },
  budget: { maxImplementerActivations: 1, maxReviewCycles: 1, maxElapsedMs: 1_000 },
  authorization: { source: "test", delivery: true },
  delivery: {
    baseBranch: "main",
    branch: "agent/contract-test",
    issue: 1,
    title: "Contract test",
    body: "Contract test",
  },
};

function contractWithRepositoryPath(path: string): Record<string, unknown> {
  return {
    ...committedContract,
    repository: {
      ...committedContract.repository,
      path,
    },
  };
}

function contractWithRepositoryIdentity(
  identity: Partial<{ owner: string; name: string }>,
): Record<string, unknown> {
  return {
    ...committedContract,
    repository: {
      ...committedContract.repository,
      ...identity,
    },
  };
}

describe("Task Contract repository paths", () => {
  test.each([".", "fixtures/repository", "release..candidate"])(
    "accepts repository-relative path %j in the native JSON format",
    (path) => {
      const result = taskContractSchema.safeParse(contractWithRepositoryPath(path));

      expect(result.success).toBe(true);
    },
  );

  test.each([
    ["/var/lib/usine", "POSIX absolute"],
    ["C:\\Users\\example\\usine", "Windows drive-qualified"],
    ["D:/work/usine", "Windows drive-qualified"],
    ["E:relative\\usine", "Windows drive-qualified"],
    ["\\\\server\\share\\usine", "UNC"],
    ["//server/share/usine", "UNC"],
    ["..", "parent-directory traversal"],
    ["../target", "parent-directory traversal"],
    ["..\\target", "parent-directory traversal"],
  ])("rejects %s as a %s repository path", (path) => {
    const result = taskContractSchema.safeParse(contractWithRepositoryPath(path));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["repository", "path"],
          message: expect.stringContaining("repository-relative"),
        }),
      ]),
    );
  });
});

describe("Task Contract repository identity", () => {
  test.each([
    { field: "owner" as const, value: " \t\n ", path: ["repository", "owner"] },
    { field: "name" as const, value: "\n\t ", path: ["repository", "name"] },
  ])("rejects whitespace-only repository $field", ({ field, value, path }) => {
    const result = taskContractSchema.safeParse(contractWithRepositoryIdentity({ [field]: value }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path, message: "must not be blank" })]),
    );
  });

  test("preserves valid repository owner and name values unchanged", () => {
    const repository = { path: ".", owner: " octocat ", name: " usine-repo " };
    const result = taskContractSchema.safeParse({ ...committedContract, repository });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.repository).toEqual(repository);
  });
});

describe("Task Contract delivery branches", () => {
  test.each([
    { field: "baseBranch" as const, value: " \t\n ", path: ["delivery", "baseBranch"] },
    { field: "branch" as const, value: "\n\t ", path: ["delivery", "branch"] },
  ])("rejects whitespace-only delivery $field", ({ field, value, path }) => {
    const result = taskContractSchema.safeParse({
      ...committedContract,
      delivery: { ...committedContract.delivery, [field]: value },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path, message: "must not be blank" })]),
    );
  });

  test("preserves valid delivery branch values unchanged", () => {
    const delivery = {
      ...committedContract.delivery,
      baseBranch: " release/main ",
      branch: " agent/contract-test ",
    };
    const result = taskContractSchema.safeParse({ ...committedContract, delivery });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.delivery).toEqual(delivery);
  });
});
