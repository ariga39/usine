import type { DeliveryRunServices } from "./delivery-run.js";
import {
  taskProgressFromResult,
  type TaskHistoryRecordInput,
  type TaskResult,
} from "@usine/task-authority";

export function reportProgress(services: DeliveryRunServices, result: TaskResult): void {
  try {
    services.onProgress?.(taskProgressFromResult(result));
  } catch {
    // Progress is an observation only; a failed sink cannot alter authority.
  }
}

export async function recordHistory(
  services: DeliveryRunServices,
  input: TaskHistoryRecordInput,
): Promise<void> {
  await services.authority.appendHistory(input);
}

export async function blockTask(
  services: DeliveryRunServices,
  result: TaskResult,
  blocker: string,
): Promise<TaskResult> {
  const blocked = await services.authority.block(
    { taskId: result.taskId, revision: result.revision },
    blocker,
  );
  reportProgress(services, blocked);
  return blocked;
}
