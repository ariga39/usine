import { readFileSync } from "node:fs";
import { taskContractSchema } from "../packages/runtime/src/contract.js";
import { describe, expect, test } from "vitest";

const committedContract = JSON.parse(
  readFileSync(new URL("../task.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function contractWithRepositoryPath(path: string): Record<string, unknown> {
  return {
    ...committedContract,
    repository: {
      ...(committedContract.repository as Record<string, unknown>),
      path,
    },
  };
}

describe("Task Contract repository paths", () => {
  test.each([".", "fixtures/repository"])(
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
