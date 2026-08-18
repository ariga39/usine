import { taskContractSchema } from "../packages/runtime/src/contract.js";
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
