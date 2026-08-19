import type { TraceEventEnvelope } from "./protocol.ts";

export interface MiddlewareLogEntry {
  at: number;
  messages: unknown[];
}

export interface MiddlewareSpan {
  name: string;
  count: number;
  startedAt: number;
  duration?: string;
  logs: MiddlewareLogEntry[];
}

export interface Trace {
  requestId: string;
  startedAt: number;
  endedAt?: number;
  method?: string;
  url?: string;
  pathname?: string;
  status?: number;
  duration?: string;
  /** Raw `request.start` payload (headers, body, query, params, ...). */
  start?: Record<string, unknown>;
  /** Raw `request.end` payload (responseHeaders, responseBody, ...). */
  end?: Record<string, unknown>;
  middlewares: MiddlewareSpan[];
  mismatches: Record<string, unknown>[];
}

export interface Session {
  id: number;
  startedAt: number;
  meta: Record<string, unknown>;
  /** True when the session was created because events arrived before any session/start. */
  implicit: boolean;
  traces: Map<string, Trace>;
}

export interface TraceStoreOptions {
  /** Defaults to `50`; oldest sessions are evicted beyond this. */
  maxSessions?: number;
  /** Defaults to `1_000` per session; oldest traces are evicted beyond this. */
  maxTracesPerSession?: number;
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * In-memory session/trace store. Incoming events attach to the most recent
 * session — there is no session negotiation beyond `session/start`.
 */
export class TraceStore {
  readonly sessions: Session[] = [];
  current: Session | null = null;

  private readonly listeners = new Set<() => void>();
  private nextSessionId = 1;
  private readonly maxSessions: number;
  private readonly maxTraces: number;

  constructor(options: TraceStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? 50;
    this.maxTraces = options.maxTracesPerSession ?? 1_000;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  startSession(
    startedAt: number,
    meta: Record<string, unknown>,
    implicit = false,
  ): Session {
    const session: Session = {
      id: this.nextSessionId++,
      startedAt,
      meta,
      implicit,
      traces: new Map(),
    };
    this.sessions.push(session);
    if (this.sessions.length > this.maxSessions) this.sessions.shift();
    this.current = session;
    this.notify();
    return session;
  }

  addEvent(envelope: TraceEventEnvelope): void {
    const session = this.current ?? this.startSession(envelope.at, {}, true);
    const p = envelope.payload;
    const requestId = asString(p.requestId);
    if (!requestId) return;

    let trace = session.traces.get(requestId);
    if (!trace) {
      if (session.traces.size >= this.maxTraces) {
        // Map iteration order is insertion order: first key is the oldest trace.
        const oldest = session.traces.keys().next().value;
        if (oldest !== undefined) session.traces.delete(oldest);
      }
      trace = {
        requestId,
        startedAt: envelope.at,
        middlewares: [],
        mismatches: [],
      };
      session.traces.set(requestId, trace);
    }

    switch (envelope.event) {
      case "request.start":
        trace.startedAt = envelope.at;
        trace.method = asString(p.method);
        trace.url = asString(p.url);
        trace.pathname = asString(p.pathname);
        trace.start = p;
        break;
      case "request.end":
        trace.endedAt = envelope.at;
        trace.status = asNumber(p.status);
        trace.duration = asString(p.duration);
        trace.method ??= asString(p.method);
        trace.pathname ??= asString(p.pathname);
        trace.end = p;
        break;
      case "middleware.start":
        trace.middlewares.push({
          name: asString(p.middlewareName) ?? "?",
          count: asNumber(p.count) ?? 0,
          startedAt: envelope.at,
          logs: [],
        });
        break;
      case "middleware.end": {
        const span = findSpan(trace, p);
        if (span) span.duration = asString(p.duration);
        break;
      }
      case "middleware.log": {
        let span = findSpan(trace, p);
        if (!span) {
          span = {
            name: asString(p.middlewareName) ?? "?",
            count: asNumber(p.count) ?? 0,
            startedAt: envelope.at,
            logs: [],
          };
          trace.middlewares.push(span);
        }
        span.logs.push({
          at: envelope.at,
          messages: Array.isArray(p.messages) ? p.messages : [p.messages],
        });
        break;
      }
      case "response.schema.mismatch":
        trace.mismatches.push(p);
        break;
    }
    this.notify();
  }
}

/** `count` is a string in `middleware.log` but a number elsewhere — compare loosely. */
function findSpan(
  trace: Trace,
  payload: Record<string, unknown>,
): MiddlewareSpan | undefined {
  const name = payload.middlewareName;
  const count = payload.count;
  for (let i = trace.middlewares.length - 1; i >= 0; i--) {
    const span = trace.middlewares[i];
    if (span.name !== name) continue;
    if (count !== undefined && String(span.count) !== String(count)) continue;
    return span;
  }
  return undefined;
}
