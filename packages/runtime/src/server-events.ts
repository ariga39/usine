import { decodeApiEventEnvelope, type ApiEventEnvelope } from "./http-api.js";

export type TaskEventEnvelope = ApiEventEnvelope;

/** Compatibility alias for callers that still import the historical decoder. */
export function decodeTaskEventEnvelope(input: unknown): TaskEventEnvelope {
  return decodeApiEventEnvelope(input);
}
