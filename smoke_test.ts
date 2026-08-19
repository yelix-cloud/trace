import { attachYelixTrace } from "./mod.ts";
import { startTraceServer } from "./src/server.ts";
import { TraceStore } from "./src/store.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `assert failed: ${msg} (expected ${expected}, got ${actual})`,
    );
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean,
  msg: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${msg}`);
    await sleep(25);
  }
}

class FakeApp {
  private handlers = new Map<string, ((p: unknown) => void)[]>();
  onYelixEvent(event: string, cb: (p: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, payload: Record<string, unknown>): void {
    for (const cb of this.handlers.get(event) ?? []) cb(payload);
  }
}

Deno.test("reporter → server → store, end to end", async () => {
  const store = new TraceStore();
  const server = await startTraceServer({ port: 0, secret: "s3cret", store });

  try {
    // Wrong secret must be rejected and touch nothing.
    const bad = await fetch(`http://127.0.0.1:${server.port}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ v: 1, events: [] }),
    });
    assertEq(bad.status, 401, "wrong secret rejected");
    await bad.body?.cancel();
    assertEq(
      store.sessions.length,
      0,
      "no session created by rejected request",
    );

    const app = new FakeApp();
    const reporter = attachYelixTrace(app, {
      port: server.port,
      secret: "s3cret",
      flushIntervalMs: 50,
    });

    await waitFor(() => reporter.sessionStarted, "session started");
    assertEq(store.sessions.length, 1, "one session after session/start");
    assertEq(store.sessions[0].implicit, false, "explicit session");

    app.emit("request.start", {
      requestId: "r1",
      method: "POST",
      url: "http://localhost:8000/login?x=1",
      pathname: "/login",
      body: { parsed: { user: "groop" } },
      hasContent: true,
      query: { x: "1" },
      params: {},
      headers: {},
    });
    app.emit("middleware.start", {
      requestId: "r1",
      middlewareName: "cors",
      count: 0,
      url: "u",
    });
    app.emit("middleware.log", {
      requestId: "r1",
      middlewareName: "cors",
      count: "0",
      messages: ["preflight ok"],
    });
    app.emit("middleware.end", {
      requestId: "r1",
      middlewareName: "cors",
      count: 0,
      duration: "0.42 ms",
    });
    app.emit("response.schema.mismatch", {
      requestId: "r1",
      kind: "zod_mismatch",
      message: "bad",
    });
    app.emit("request.end", {
      requestId: "r1",
      method: "POST",
      pathname: "/login",
      status: 201,
      duration: "3.10 ms",
      responseBody: { ok: true },
    });

    await waitFor(() => {
      const t = store.sessions[0]?.traces.get("r1");
      return !!t?.endedAt;
    }, "trace r1 completed");

    const trace = store.sessions[0].traces.get("r1")!;
    assertEq(trace.method, "POST", "method");
    assertEq(trace.status, 201, "status");
    assertEq(trace.duration, "3.10 ms", "duration");
    assertEq(trace.middlewares.length, 1, "one middleware span");
    assertEq(trace.middlewares[0].duration, "0.42 ms", "span duration");
    assertEq(
      trace.middlewares[0].logs.length,
      1,
      "log attached to span despite string count",
    );
    assertEq(trace.mismatches.length, 1, "mismatch recorded");

    reporter.close();
  } finally {
    await server.close();
  }
});

Deno.test("events before session/start land in an implicit session", async () => {
  const store = new TraceStore();
  const server = await startTraceServer({ port: 0, secret: "s3cret", store });

  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer s3cret",
      },
      body: JSON.stringify({
        v: 1,
        events: [{
          at: Date.now(),
          event: "request.start",
          payload: { requestId: "rx", method: "GET", pathname: "/" },
        }],
      }),
    });
    assertEq(res.status, 204, "events accepted");
    await res.body?.cancel();
    assertEq(store.sessions.length, 1, "implicit session created");
    assertEq(store.sessions[0].implicit, true, "flagged implicit");
    assert(store.sessions[0].traces.has("rx"), "trace stored");
  } finally {
    await server.close();
  }
});
