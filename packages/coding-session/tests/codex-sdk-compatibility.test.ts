import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { expect, test } from "vite-plus/test";

test("the SDK-bundled CLI parses structured feature configuration without a model request", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "usine-sdk-config-"));
  try {
    await writeFile(
      join(configHome, "config.toml"),
      "[features]\ncontext_management.experimental_mode = true\n",
    );
    // Inspect the SDK's resolved executable so an unrelated CLI on PATH cannot pass this check.
    const executablePath = Reflect.get(Reflect.get(new Codex(), "exec"), "executablePath");
    expect(typeof executablePath).toBe("string");
    const result = spawnSync(executablePath, ["features", "list"], {
      env: { PATH: process.env.PATH, CODEX_HOME: configHome },
      cwd: configHome,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^context_management\s+under development\s+true$/m);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});
