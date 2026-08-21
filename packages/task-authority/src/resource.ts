import { Schema } from "effect";
import { taskListItemSchema } from "./task-state-schema.js";

const repositoryResource = Schema.Struct({
  id: Schema.String,
  revision: Schema.Natural,
  owner: Schema.String,
  name: Schema.String,
  baseBranch: Schema.String,
});
const codingSessionResource = Schema.Struct({
  taskId: Schema.String,
  sessionId: Schema.String,
  role: Schema.Literals(["implementer", "reviewer", "coordinator"]),
  activation: Schema.Natural,
  revision: Schema.Natural,
});

const serverHealth = Schema.Struct({
  status: Schema.Literal("ok"),
  revision: Schema.Natural,
});

const serverSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Natural,
  server: serverHealth,
  repositories: Schema.Array(repositoryResource),
  tasks: Schema.Array(taskListItemSchema),
  codingSessions: Schema.Array(codingSessionResource),
});

export type RepositoryResourceShape = Schema.Schema.Type<typeof repositoryResource>;
export type CodingSessionResource = Schema.Schema.Type<typeof codingSessionResource>;
export type ServerHealth = Schema.Schema.Type<typeof serverHealth>;
export type ServerSnapshot = Schema.Schema.Type<typeof serverSnapshot>;

export function decodeServerHealth(input: unknown): ServerHealth {
  return Schema.decodeUnknownSync(serverHealth)(input);
}

export function decodeServerSnapshot(input: unknown): ServerSnapshot {
  return Schema.decodeUnknownSync(serverSnapshot)(input);
}
