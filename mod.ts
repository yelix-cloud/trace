/**
 * @yelix/trace — dev-time request tracing for Yelix apps.
 *
 * The library entry point is the reporter; the terminal UI ships as the
 * `./cli` export and is meant to be executed, e.g.:
 * `dx jsr:@yelix/trace/cli --secret=dev --port=7357`
 */
export { attachYelixTrace } from "./src/reporter.ts";
export type {
  YelixEventSource,
  YelixTraceReporter,
  YelixTraceReporterOptions,
} from "./src/reporter.ts";
export { startTraceServer } from "./src/server.ts";
export type { RunningTraceServer, TraceServerOptions } from "./src/server.ts";
export { TraceStore } from "./src/store.ts";
export type {
  MiddlewareLogEntry,
  MiddlewareSpan,
  Session,
  Trace,
  TraceStoreOptions,
} from "./src/store.ts";
export {
  bearerToken,
  EVENTS_PATH,
  SESSION_START_PATH,
  TRACE_EVENT_NAMES,
  TRACE_PROTOCOL_VERSION,
} from "./src/protocol.ts";
export type {
  EventsBatchBody,
  SessionStartBody,
  TraceEventEnvelope,
  TraceEventName,
} from "./src/protocol.ts";
