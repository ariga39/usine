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
  const persistentEnvironment = {
    USINE_DATABASE_URL: "server-secret-database",
    USINE_GITHUB_TEST_TOKEN: "server-secret-github",
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") {
      const [key, value = ""] = args[index + 1].split("=", 2);
      if (key in persistentEnvironment) persistentEnvironment[key] = value;
    }
  }
  if (Object.values(persistentEnvironment).some(Boolean))
    throw new Error("fake Herdr pane retained persistent coordinator secrets");
  await writeFile(".fake-herdr-server.json", JSON.stringify(persistentEnvironment));
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
  const addDirIndex = args.indexOf("--add-dir");
  const configIndex = args.indexOf("--config");
  if (addDirIndex < 0 || args[addDirIndex + 1] !== process.env.USINE_EXPECTED_OBSERVATION_DIR)
    throw new Error("fake Herdr start is missing the exact observation directory");
  if (configIndex < 0 || args[configIndex + 1] !== "shell_environment_policy.inherit=core")
    throw new Error("fake Herdr start is missing the core shell environment policy");
  const persistentEnvironment = JSON.parse(await readFile(".fake-herdr-server.json", "utf8"));
  await rm(".fake-herdr-server.json", { force: true });
  await record({ command: args, type: "start" });
  await writeFile(
    ".fake-herdr-agent.json",
    JSON.stringify({
      args: args.slice(8),
      observationDir: args[addDirIndex + 1],
      environment: persistentEnvironment,
    }),
  );
} else if (args[0] === "agent" && args[1] === "prompt") {
  const state = JSON.parse(await readFile(".fake-herdr-agent.json", "utf8"));
  await record({ command: args, type: "prompt" });
  const prompt = args[3];
  const outputPath = prompt.match(/to (\/[^;]+); this file is coordinator evidence/)?.[1];
  if (!outputPath) throw new Error("fake Herdr prompt is missing coordinator output path");
  if (state.observationDir !== outputPath.slice(0, outputPath.lastIndexOf("/")))
    throw new Error("fake Herdr did not grant the observation directory");
  if (process.env.USINE_HERDR_MODE === "early-settle") {
    await writeFile(
      ".fake-herdr-agent.json",
      JSON.stringify({ ...state, earlySettle: true, outputPath, prompt, readCount: 0 }),
    );
  } else {
    const codex = process.env.USINE_CODEX_BIN.endsWith(".mjs")
      ? [process.execPath, process.env.USINE_CODEX_BIN]
      : [process.env.USINE_CODEX_BIN];
    await execa(codex[0], [...codex.slice(1), ...state.args, "--json", "-o", outputPath, prompt], {
      cwd: process.cwd(),
      env: { ...process.env, ...state.environment },
    });
    await rm(".fake-herdr-agent.json", { force: true });
  }
} else if (args[0] === "agent" && args[1] === "read") {
  await record({ command: args, type: "read" });
  let settled = true;
  if (process.env.USINE_HERDR_MODE === "early-settle") {
    const state = JSON.parse(await readFile(".fake-herdr-agent.json", "utf8"));
    if (state.readCount === 0) {
      await writeFile(".fake-herdr-agent.json", JSON.stringify({ ...state, readCount: 1 }));
      settled = false;
    } else {
      const codex = process.env.USINE_CODEX_BIN.endsWith(".mjs")
        ? [process.execPath, process.env.USINE_CODEX_BIN]
        : [process.env.USINE_CODEX_BIN];
      await execa(
        codex[0],
        [...codex.slice(1), ...state.args, "--json", "-o", state.outputPath, state.prompt],
        { cwd: process.cwd(), env: { ...process.env, ...state.environment } },
      );
      await rm(".fake-herdr-agent.json", { force: true });
    }
  }
  if (settled) process.stdout.write('{"type":"thread.started","thread_id":"fake-herdr-session"}\n');
} else if (args[0] === "pane" && args[1] === "close") {
  await record({ command: args, type: "close" });
  await rm(".fake-herdr-agent.json", { force: true });
  await rm(".fake-herdr-server.json", { force: true });
} else {
  process.stderr.write(`unknown fake herdr command: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
