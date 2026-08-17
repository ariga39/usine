export function herdrErrorCode(stderr: unknown): string | undefined {
  if (typeof stderr !== "string") return undefined;
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

export function workerEnvironment(role: "implementer" | "reviewer"): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { USINE_CODEX_ROLE: role };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "COLORTERM",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export function herdrEnvironment(role: "implementer" | "reviewer"): NodeJS.ProcessEnv {
  const environment = workerEnvironment(role);
  for (const key of [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
    "HERDR_CONFIG_PATH",
    "USINE_CODEX_BIN",
    "USINE_HERDR_LOG",
    "USINE_HERDR_MODE",
    "USINE_EXPECTED_OBSERVATION_DIR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export function codexCommand(
  binary: string,
  args: string[],
): { executable: string; args: string[] } {
  return binary.endsWith(".mjs")
    ? { executable: process.execPath, args: [binary, ...args] }
    : { executable: binary, args };
}
