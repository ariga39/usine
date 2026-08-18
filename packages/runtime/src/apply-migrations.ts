import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { fileURLToPath } from "node:url";
import { openSqliteDatabase } from "./sqlite-database.js";

const migrationsDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function applyMigrations(databasePath: string): Promise<void> {
  const handle = openSqliteDatabase(databasePath);
  try {
    await handle.exclusiveTransaction(() =>
      migrate(handle.database, handle.migrate, { migrationsFolder: migrationsDirectory }),
    );
  } finally {
    handle.close();
  }
}
