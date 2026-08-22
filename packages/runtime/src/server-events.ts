import { Predicate, Schema } from "effect";
import { decodeTaskEvent, type TaskEvent } from "@usine/task-authority";

const taskEventEnvelope = Schema.Struct({
  taskId: Schema.String,
  repositoryId: Schema.String,
  event: Schema.Unknown,
});

export interface TaskEventEnvelope {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly event: TaskEvent;
}

export function decodeTaskEventEnvelope(input: unknown): TaskEventEnvelope {
  if (!Predicate.isObject(input)) throw new Error("TaskEventEnvelope must be an object");
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "event,repositoryId,taskId") {
    throw new Error("TaskEventEnvelope has unexpected fields");
  }
  const decoded = Schema.decodeUnknownSync(taskEventEnvelope)(input);
  const event = decodeTaskEvent(decoded.event);
  if (event.taskId !== decoded.taskId) throw new Error("event envelope Task ID is inconsistent");
  return { taskId: decoded.taskId, repositoryId: decoded.repositoryId, event };
}
