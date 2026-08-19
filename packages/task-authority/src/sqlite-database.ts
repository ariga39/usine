import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { RemoteCallback, SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { repositoryLeases, taskRuns } from "./schema.js";

const transactionQueues = new Map<string, Promise<void>>();

function enqueueTransaction<T>(path: string, transaction: () => Promise<T>): Promise<T> {
  const previous = transactionQueues.get(path) ?? Promise.resolve();
  const current = previous.then(transaction);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  transactionQueues.set(path, settled);
  void settled.then(() => {
    if (transactionQueues.get(path) === settled) transactionQueues.delete(path);
  });
  return current;
}

export type RuntimeDatabase = SqliteRemoteDatabase<{
  repositoryLeases: typeof repositoryLeases;
  taskRuns: typeof taskRuns;
}>;

export function openSqliteDatabase(
  path: string,
  options: { readOnly?: boolean } = {},
): {
  database: RuntimeDatabase;
  close: () => void;
  exclusiveTransaction: <T>(transaction: () => Promise<T>) => Promise<T>;
  migrate: (queries: string[]) => Promise<void>;
} {
  const client = new DatabaseSync(path, { timeout: 5_000, readOnly: options.readOnly ?? false });
  const execute: RemoteCallback = async (query, params, method) => {
    const statement = client.prepare(query);
    const values = params as SQLInputValue[];
    statement.setReturnArrays(true);
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    if (method === "get") return { rows: statement.get(...values) as unknown as [] };
    return { rows: statement.all(...values) };
  };
  const database = drizzle(execute, { schema: { repositoryLeases, taskRuns } });

  const databaseWithTransaction = database as unknown as {
    transaction: (...args: unknown[]) => Promise<unknown>;
  };
  const runDatabaseTransaction = databaseWithTransaction.transaction.bind(database);
  databaseWithTransaction.transaction = (...args) =>
    enqueueTransaction(path, () => runDatabaseTransaction(...args));

  return {
    database,
    close: () => client.close(),
    exclusiveTransaction: (operation) =>
      enqueueTransaction(path, async () => {
        client.exec("begin exclusive");
        try {
          const result = await operation();
          client.exec("commit");
          return result;
        } catch (error) {
          client.exec("rollback");
          throw error;
        }
      }),
    migrate: async (queries) => {
      for (const query of queries) client.exec(query);
    },
  };
}
