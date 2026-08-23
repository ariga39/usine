import { Schema } from "effect";
import { taskListItemSchema } from "./task-state-schema.js";

export const repositoryResourceEffectSchema = Schema.Struct({
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

export const serverHealthSchema = Schema.Struct({
  status: Schema.Literal("ok"),
  revision: Schema.Natural,
});

export const serverSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Natural,
  server: serverHealthSchema,
  repositories: Schema.Array(repositoryResourceEffectSchema),
  tasks: Schema.Array(taskListItemSchema),
  codingSessions: Schema.Array(codingSessionResource),
});

export type CodingSessionResource = Schema.Schema.Type<typeof codingSessionResource>;
export type ServerHealth = Schema.Schema.Type<typeof serverHealthSchema>;
export type ServerSnapshot = Schema.Schema.Type<typeof serverSnapshotSchema>;
