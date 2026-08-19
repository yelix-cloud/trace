import {
  bearerToken,
  EVENTS_PATH,
  SESSION_START_PATH,
  TRACE_EVENT_NAMES,
  TRACE_PROTOCOL_VERSION,
  type TraceEventEnvelope,
} from "./protocol.ts";

export interface YelixTraceReporterOptions {
  /** Port of the running `yelix-trace` CLI. */
  port: number;
  /** Shared secret, sent as a bearer token with every request. */
  secret: string;
  /** Host of the trace CLI. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Batch flush interval in milliseconds. Defaults to `250`. */
  flushIntervalMs?: number;
  /** Queued events cap; oldest events are dropped when full. Defaults to `10_000`. */
  maxQueue?: number;
  /** Extra metadata sent with `session/start`. */
  meta?: Record<string, unknown>;
}

export interface YelixTraceReporter {
  /** Whether the CLI acknowledged `session/start`. */
  readonly sessionStarted: boolean;
  /** Stops the flush timer and performs a best-effort final flush. */
  close(): void;
}

/**
 * Structural match for `YelixHono.onYelixEvent` / `YelixExpress.onYelixEvent`,
 * so the reporter works without importing either package.
 */
export interface YelixEventSource {
  onYelixEvent(event: string, callback: (payload: unknown) => void): unknown;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Subscribes to all Yelix framework events of `app` and streams them to a
 * running `yelix-trace` CLI. Fire-and-forget: tracing never throws into the
 * host application, and event callbacks stay synchronous (the framework does
 * not await them).
 *
 * @example
 * ```ts
 * import { attachYelixTrace } from "jsr:@yelix/trace";
 *
 * const app = new YelixHono();
 * attachYelixTrace(app, { port: 7357, secret: "dev-secret" });
 * ```
 */
export function attachYelixTrace(
  app: YelixEventSource,
  options: YelixTraceReporterOptions,
): YelixTraceReporter {
  const base = `http://${options.host ?? "127.0.0.1"}:${options.port}`;
  const flushIntervalMs = options.flushIntervalMs ?? 250;
  const maxQueue = options.maxQueue ?? 10_000;
  const auth = bearerToken(options.secret);

  let queue: TraceEventEnvelope[] = [];
  let inFlight = false;
  let closed = false;
  let started = false;

  for (const event of TRACE_EVENT_NAMES) {
    app.onYelixEvent(event, (payload) => {
      if (closed) return;
      queue.push({
        at: Date.now(),
        event,
        payload: (payload ?? {}) as Record<string, unknown>,
      });
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
    });
  }

  const post = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify(body),
        keepalive: true,
      });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  };

  const startSession = async (): Promise<void> => {
    const meta: Record<string, unknown> = {
      pid: Deno.pid,
      deno: Deno.version.deno,
      ...options.meta,
    };
    try {
      meta.cwd = Deno.cwd();
    } catch {
      // --allow-read not granted; cwd is nice-to-have only.
    }
    for (let attempt = 0; attempt < 10 && !closed; attempt++) {
      const ok = await post(SESSION_START_PATH, {
        v: TRACE_PROTOCOL_VERSION,
        startedAt: Date.now(),
        meta,
      });
      if (ok) {
        started = true;
        return;
      }
      await sleep(Math.min(250 * 2 ** attempt, 5_000));
    }
    // CLI never came up: events keep flowing and land in an implicit session.
  };

  const flush = async (): Promise<void> => {
    if (inFlight || closed || queue.length === 0) return;
    inFlight = true;
    const batch = queue.splice(0, 500);
    const ok = await post(EVENTS_PATH, {
      v: TRACE_PROTOCOL_VERSION,
      events: batch,
    });
    if (!ok) {
      queue = batch.concat(queue);
      if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
    }
    inFlight = false;
  };

  const timer = setInterval(() => void flush(), flushIntervalMs);
  void startSession();

  return {
    get sessionStarted() {
      return started;
    },
    close() {
      clearInterval(timer);
      void flush();
      closed = true;
    },
  };
}
