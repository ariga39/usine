import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const requested = process.argv.slice(2);
const inputs = requested.length > 0 ? requested : ["AGENTS.md", ".agents", "README.md", "docs"];

function markdownFiles(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return absolute.endsWith(".md") ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    markdownFiles(join(path, entry.name)),
  );
}

const files = [...new Set(inputs.flatMap(markdownFiles))];
const failures = [];
const linkPattern = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const headingCache = new Map();

function headingIds(file) {
  const cached = headingCache.get(file);
  if (cached) return cached;

  const ids = new Set();
  const occurrences = new Map();
  const headingPattern = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  for (const match of readFileSync(file, "utf8").matchAll(headingPattern)) {
    const base = match[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    ids.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  headingCache.set(file, ids);
  return ids;
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (target.startsWith("https://") || target.startsWith("http://")) continue;

    const hashIndex = target.indexOf("#");
    const pathTarget = (hashIndex === -1 ? target : target.slice(0, hashIndex)).split("?", 1)[0];
    const fragment = hashIndex === -1 ? undefined : target.slice(hashIndex + 1);
    if (isAbsolute(pathTarget)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    const resolved = pathTarget ? resolve(dirname(file), pathTarget) : file;
    const fromRoot = relative(root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    if (fragment !== undefined) {
      let decoded;
      try {
        decoded = decodeURIComponent(fragment);
      } catch {
        failures.push(`${file}: ${target}`);
        continue;
      }
      if (!headingIds(resolved).has(decoded)) failures.push(`${file}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Unresolved local Markdown links:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown file(s); all local links resolve.`);
}
