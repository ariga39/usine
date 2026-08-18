export function projectCheckEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "true" };
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
