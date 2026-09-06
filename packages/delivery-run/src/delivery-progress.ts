import type { CodingSessionObservation, CodingSessionPhase } from "@usine/coding-session";
import type {
  TaskBlockerClassification,
  TaskFailureClass,
  TaskObservationEventData,
  TaskObservationEventInput,
  TaskResult,
} from "@usine/task-authority";
import type { DeliveryRunServices } from "./delivery-run.js";

export function emitObservation(
  services: DeliveryRunServices,
  taskId: string,
  input: TaskObservationEventInput,
): Promise<unknown> {
  return services.authority.appendObservation(taskId, input);
}

export function emitCodingObservation(
  services: DeliveryRunServices,
  taskId: string,
  role: "implementer" | "reviewer",
  activation: number,
  sessionId: string,
  eventPrefix: string,
  counter: { value: number },
  observation: CodingSessionObservation,
  reviewCycle?: number,
): Promise<void> {
  const data: TaskObservationEventData = (() => {
    switch (observation.type) {
      case "thread_started":
        return { type: "coding_thread_started", role, activation, sessionId };
      case "usage_observed":
        return {
          type: "coding_usage_observed",
          role,
          activation,
          sessionId,
          ...(reviewCycle === undefined ? {} : { reviewCycle }),
          source: observation.source,
          semantics: observation.semantics,
          ...(observation.actualModel ? { actualModel: observation.actualModel } : {}),
          usage: observation.usage,
        };
      case "sandbox_verified":
        return {
          type: "coding_sandbox_verified",
          role,
          activation,
          sessionId,
          host: observation.host,
          workspaceRead: observation.workspaceRead,
          workspaceWrite: observation.workspaceWrite,
          externalRead: observation.externalRead,
          externalWrite: observation.externalWrite,
          subprocess: observation.subprocess,
        };
      case "turn_started":
        return { type: "coding_turn_started", role, activation, turn: observation.turn, sessionId };
      case "tool_completed":
        return {
          type: "coding_tool_completed",
          role,
          activation,
          sessionId,
          outcomeId: `${eventPrefix}:${counter.value}:outcome`,
          tool: observation.tool,
          outcome: observation.outcome,
        };
      case "mcp_tool_completed":
        return {
          type: "coding_mcp_tool_completed",
          role,
          activation,
          sessionId,
          outcomeId: `${eventPrefix}:${counter.value}:outcome`,
          server: observation.server,
          tool: observation.tool,
          outcome: observation.outcome,
        };
      case "mcp_unavailable":
        return {
          type: "coding_mcp_unavailable",
          role,
          activation,
          sessionId,
          server: observation.server,
          reason: observation.reason,
        };
      case "turn_completed":
        return {
          type: "coding_turn_completed",
          role,
          activation,
          sessionId,
          outcomeId: `${eventPrefix}:${counter.value}:outcome`,
          turn: observation.turn,
          outcome: observation.outcome,
        };
      default:
        throw new Error("unknown coding session observation");
    }
  })();
  return emitObservation(services, taskId, {
    eventId: `${eventPrefix}:${counter.value++}:${data.type}`,
    occurredAtEpochMs: Date.now(),
    data,
  }).then(() => undefined);
}

export function emitCodingInterruption(
  services: DeliveryRunServices,
  taskId: string,
  role: "implementer" | "reviewer",
  activation: number,
  sessionId: string,
  eventPrefix: string,
  counter: { value: number },
  interruption: {
    phase: CodingSessionPhase;
    failureClass: TaskFailureClass;
  },
): Promise<void> {
  return emitObservation(services, taskId, {
    eventId: `${eventPrefix}:${counter.value++}:coding_session_interrupted`,
    occurredAtEpochMs: Date.now(),
    data: {
      type: "coding_session_interrupted",
      role,
      activation,
      sessionId,
      phase: interruption.phase,
      failureClass: interruption.failureClass,
    },
  }).then(() => undefined);
}

export async function blockTask(
  services: DeliveryRunServices,
  result: TaskResult,
  blocker: string,
  classification?: TaskBlockerClassification,
): Promise<TaskResult> {
  return services.authority.block(
    { taskId: result.taskId, revision: result.revision },
    blocker,
    classification,
  );
}
