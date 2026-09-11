import { expect, test } from "vite-plus/test";
import { acceptanceCriteriaSchema, combineAcceptanceCriteria } from "../src/acceptance.js";

const required = {
  id: "toolchain",
  criterion: "Use the required toolchain",
  mandatory: true,
  checkId: "toolchain-check",
};

test("deduplicates repeated obligations by meaning without relaxing identity", () => {
  expect(combineAcceptanceCriteria([required, "legacy"], [{ ...required }, "legacy"])).toEqual([
    required,
    "legacy",
  ]);
  for (const revision of [
    { mandatory: false },
    { criterion: "A different requirement" },
    { checkId: "another-check" },
  ]) {
    expect(() => combineAcceptanceCriteria([required], [{ ...required, ...revision }])).toThrow(
      "identity conflicts",
    );
  }
  const additional = { ...required, id: "additional", criterion: "Verify an additional behavior" };
  expect(combineAcceptanceCriteria([required], [additional])).toEqual([required, additional]);
});

test("rejects duplicate structured IDs at the contract boundary and preserves optional intent", () => {
  expect(acceptanceCriteriaSchema.safeParse([required, { ...required }]).success).toBe(false);
  expect(acceptanceCriteriaSchema.parse([{ ...required, mandatory: false }])[0]).toMatchObject({
    mandatory: false,
  });
});
