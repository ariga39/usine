import { chmod, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

const PRIVATE_STATE_DIRECTORY_MODE = 0o700;
const PRIVATE_DATABASE_MODE = 0o600;

export async function ensurePrivateStateDirectory(stateDirectory: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: PRIVATE_STATE_DIRECTORY_MODE });
  await chmod(stateDirectory, PRIVATE_STATE_DIRECTORY_MODE);
}

export async function ensurePrivateStateDatabase(stateDirectory: string): Promise<string> {
  await ensurePrivateStateDirectory(stateDirectory);
  const databasePath = resolve(stateDirectory, "usine.sqlite");
  const file = await open(databasePath, "a", PRIVATE_DATABASE_MODE);
  await file.close();
  await chmod(databasePath, PRIVATE_DATABASE_MODE);
  return databasePath;
}
