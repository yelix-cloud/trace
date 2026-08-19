import {
  bearerToken,
  EVENTS_PATH,
  type EventsBatchBody,
  SESSION_START_PATH,
  type SessionStartBody,
  type TraceEventEnvelope,
} from "./protocol.ts";
import type { TraceStore } from "./store.ts";

export interface TraceServerOptions {
  port: number;
  secret: string;
  store: TraceStore;
  /** Defaults to `"127.0.0.1"` — the collector is meant for local development. */
  host?: string;
  /** Request body cap in bytes. Defaults to 5 MiB. */
  maxBodyBytes?: number;
}

export interface RunningTraceServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function startTraceServer(
  options: TraceServerOptions,
): Promise<RunningTraceServer> {
  const host = options.host ?? "127.0.0.1";
  const maxBody = options.maxBodyBytes ?? 5 * 1024 * 1024;
  const expected = bearerToken(options.secret);

  const handler = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!timingSafeEqual(req.headers.get("authorization") ?? "", expected)) {
      return new Response("unauthorized", { status: 401 });
    }
    if (Number(req.headers.get("content-length") ?? 0) > maxBody) {
      return new Response("payload too large", { status: 413 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const pathname = new URL(req.url).pathname;
    if (pathname === SESSION_START_PATH) {
      const b = body as Partial<SessionStartBody>;
      options.store.startSession(
        typeof b.startedAt === "number" ? b.startedAt : Date.now(),
        (b.meta ?? {}) as Record<string, unknown>,
      );
      return new Response(null, { status: 204 });
    }
    if (pathname === EVENTS_PATH) {
      const b = body as Partial<EventsBatchBody>;
      if (Array.isArray(b.events)) {
        for (const e of b.events as Partial<TraceEventEnvelope>[]) {
          if (e && typeof e.event === "string" && typeof e.at === "number") {
            options.store.addEvent(e as TraceEventEnvelope);
          }
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };

  return new Promise((resolve) => {
    const server = Deno.serve({
      port: options.port,
      hostname: host,
      onListen: ({ port, hostname }) => {
        resolve({
          url: `http://${hostname}:${port}`,
          port,
          close: () => server.shutdown(),
        });
      },
    }, handler);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const max = Math.max(ea.length, eb.length);
  for (let i = 0; i < max; i++) {
    const x = ea.length > 0 ? ea[i % ea.length] : 0;
    const y = eb.length > 0 ? eb[i % eb.length] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}
