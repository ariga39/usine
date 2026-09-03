import { Schema } from "effect";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CURSOR_LENGTH = 4096;
const CURSOR_VERSION = 1 as const;
const taskIdCursorSchema = Schema.Struct({
  version: Schema.Literal(CURSOR_VERSION),
  scope: Schema.Unknown,
  upperTaskId: Schema.String.check(Schema.isPattern(TASK_ID_PATTERN)),
  afterTaskId: Schema.String.check(Schema.isPattern(TASK_ID_PATTERN)),
});

export interface TaskIdCursor<Scope = unknown> {
  readonly version: typeof CURSOR_VERSION;
  readonly scope: Scope;
  readonly upperTaskId: string;
  readonly afterTaskId: string;
}

export class TaskIdCursorError extends Error {
  readonly code = "task_list_cursor_invalid";

  constructor() {
    super("task list cursor is invalid");
    this.name = "TaskIdCursorError";
  }
}

export function encodeTaskIdCursor<Scope>(cursor: TaskIdCursor<Scope>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTaskIdCursor<Scope>(value: string, scope: Scope): TaskIdCursor<Scope> {
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) throw new Error();
    const decoded = Schema.decodeUnknownSync(taskIdCursorSchema, {
      onExcessProperty: "error",
    })(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (JSON.stringify(decoded.scope) !== JSON.stringify(scope)) throw new Error();
    if (compareTaskIds(decoded.afterTaskId, decoded.upperTaskId) > 0) throw new Error();
    return {
      version: decoded.version,
      scope,
      upperTaskId: decoded.upperTaskId,
      afterTaskId: decoded.afterTaskId,
    };
  } catch {
    throw new TaskIdCursorError();
  }
}

export interface TaskIdPage<Scope = unknown> {
  readonly taskIds: readonly string[];
  readonly nextCursor: TaskIdCursor<Scope> | null;
}

export function pageTaskIds<Scope>(
  taskIds: readonly string[],
  cursor: TaskIdCursor<Scope> | null,
  limit: number,
  scope: Scope,
): TaskIdPage<Scope> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("page limit is out of range");
  const upperTaskId = cursor?.upperTaskId ?? taskIds.at(-1) ?? null;
  const afterTaskId = cursor?.afterTaskId ?? null;
  if (
    cursor !== null &&
    (upperTaskId === null ||
      afterTaskId === null ||
      !taskIds.includes(upperTaskId) ||
      !taskIds.includes(afterTaskId))
  )
    throw new TaskIdCursorError();
  const selected = taskIds
    .filter(
      (taskId) =>
        (afterTaskId === null || compareTaskIds(taskId, afterTaskId) > 0) &&
        (upperTaskId === null || compareTaskIds(taskId, upperTaskId) <= 0),
    )
    .slice(0, limit);
  const lastTaskId = selected.at(-1);
  const hasNext =
    lastTaskId !== undefined &&
    taskIds.some(
      (taskId) =>
        compareTaskIds(taskId, lastTaskId) > 0 &&
        (upperTaskId === null || compareTaskIds(taskId, upperTaskId) <= 0),
    );
  return {
    taskIds: selected,
    nextCursor:
      hasNext && lastTaskId !== undefined && upperTaskId !== null
        ? {
            version: CURSOR_VERSION,
            scope,
            upperTaskId,
            afterTaskId: lastTaskId,
          }
        : null,
  };
}

function compareTaskIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
