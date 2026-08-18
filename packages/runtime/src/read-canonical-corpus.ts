import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coordinatorRoot = fileURLToPath(new URL("../../../", import.meta.url));
const canonicalDocumentPaths = [
  "AGENTS.md",
  "docs/DESIGN.md",
  "docs/DEVELOPMENT.md",
  "docs/DECISIONS.md",
] as const;

export async function readCanonicalCorpus(): Promise<Array<{ path: string; contents: string }>> {
  return Promise.all(
    canonicalDocumentPaths.map(async (path) => {
      return { path, contents: await readFile(resolve(coordinatorRoot, path), "utf8") };
    }),
  );
}
