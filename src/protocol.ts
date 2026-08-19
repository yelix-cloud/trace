/** Wire protocol shared between the reporter (client) and the trace CLI server. */

export const TRACE_PROTOCOL_VERSION = 1;

export const TRACE_EVENT_NAMES = [
  "request.start",
  "request.end",
  "middleware.start",
  "middleware.end",
  "middleware.log",
  "response.schema.mismatch",
] as const;

export type TraceEventName = (typeof TRACE_EVENT_NAMES)[number];

export interface TraceEventEnvelope {
  /** Epoch milliseconds captured by the reporter; used for ordering, not arrival time. */
  at: number;
  event: TraceEventName;
  payload: Record<string, unknown>;
}

export interface SessionStartBody {
  v: number;
  startedAt: number;
  meta: Record<string, unknown>;
}

export interface EventsBatchBody {
  v: number;
  events: TraceEventEnvelope[];
}

export const SESSION_START_PATH = "/session/start";
export const EVENTS_PATH = "/events";

export function bearerToken(secret: string): string {
  return `Bearer ${secret}`;
}
