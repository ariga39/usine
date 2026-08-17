#!/usr/bin/env node

import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";

const args = process.argv.slice(2);
const log = process.env.USINE_HERDR_LOG;
const record = async (event) => {
  if (log) await appendFile(log, `${JSON.stringify(event)}\n`);
};

if (process.env.USINE_HERDR_MODE === "fail") {
  await record({ type: "failure" });
  process.stderr.write("fake Herdr failure\n");
  process.exit(17);
}

if (args[0] === "pane" && args[1] === "split") {
  let previous = 0;
  if (log) {
    try {
      previous = (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const pane = `fake-pane-${previous + 1}`;
  await record({
    command: args,
    context: Object.fromEntries(
      [
        "HERDR_ENV",
        "HERDR_SOCKET_PATH",
        "HERDR_WORKSPACE_ID",
        "HERDR_TAB_ID",
        "HERDR_PANE_ID",
        "HERDR_CONFIG_PATH",
        "USINE_CODEX_BIN",
        "USINE_HERDR_LOG",
      ].map((key) => [key, process.env[key]]),
    ),
    pane,
    type: "split",
  });
  process.stdout.write(JSON.stringify({ result: { pane: { pane_id: pane } } }));
} else if (args[0] === "agent" && args[1] === "start") {
  await record({ command: args, type: "start" });
  await writeFile(".fake-herdr-agent.json", JSON.stringify({ args: args.slice(8) }));
} else if (args[0] === "agent" && args[1] === "prompt") {
  const state = JSON.parse(await readFile(".fake-herdr-agent.json", "utf8"));
  await record({ command: args, type: "prompt" });
  const prompt = args[3];
  const outputPath = prompt.match(/to (\/[^;]+); this file is coordinator evidence/)?.[1];
  if (!outputPath) throw new Error("fake Herdr prompt is missing coordinator output path");
  const codex = process.env.USINE_CODEX_BIN.endsWith(".mjs")
    ? [process.execPath, process.env.USINE_CODEX_BIN]
    : [process.env.USINE_CODEX_BIN];
  await execa(codex[0], [...codex.slice(1), ...state.args, "--json", "-o", outputPath, prompt], {
    cwd: process.cwd(),
    env: process.env,
  });
  await rm(".fake-herdr-agent.json", { force: true });
} else if (args[0] === "agent" && args[1] === "read") {
  await record({ command: args, type: "read" });
  process.stdout.write('{"type":"thread.started","thread_id":"fake-herdr-session"}\n');
} else if (args[0] === "pane" && args[1] === "close") {
  await record({ command: args, type: "close" });
} else {
  process.stderr.write(`unknown fake herdr command: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
