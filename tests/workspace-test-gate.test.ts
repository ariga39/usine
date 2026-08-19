import { readFile } from "node:fs/promises";
import { expect, test } from "vite-plus/test";

type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
};

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
  ) as PackageManifest;
}

test("the root test command covers the root suite and declared package test scripts", async () => {
  const root = await readManifest("package.json");
  const packages = await Promise.all(
    [
      "packages/candidate-workspace/package.json",
      "packages/coding-session/package.json",
      "packages/delivery-run/package.json",
      "packages/forge-delivery/package.json",
      "packages/quality-gate/package.json",
      "packages/task-authority/package.json",
      "packages/runtime/package.json",
      "apps/cli/package.json",
    ].map(readManifest),
  );

  expect(root.scripts?.test).toBe(
    "vp test && vp run --filter './packages/*' --filter './apps/*' test",
  );
  expect(
    packages.filter((manifest) => manifest.scripts?.test).map((manifest) => manifest.name),
  ).toEqual([
    "@usine/candidate-workspace",
    "@usine/coding-session",
    "@usine/delivery-run",
    "@usine/forge-delivery",
    "@usine/quality-gate",
    "@usine/task-authority",
    "@usine/cli",
  ]);
  expect(
    packages.filter((manifest) => !manifest.scripts?.test).map((manifest) => manifest.name),
  ).toEqual(["@usine/runtime"]);
});
