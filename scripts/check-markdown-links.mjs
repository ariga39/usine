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

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (target.startsWith("https://") || target.startsWith("http://") || target.startsWith("#"))
      continue;
    const pathTarget = target.split("#", 1)[0].split("?", 1)[0];
    if (!pathTarget || isAbsolute(pathTarget)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    const resolved = resolve(dirname(file), pathTarget);
    const fromRoot = relative(root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) failures.push(`${file}: ${target}`);
  }
}

if (failures.length > 0) {
  console.error("Unresolved local Markdown links:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown file(s); all local links resolve.`);
}
