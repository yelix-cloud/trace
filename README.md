# @yelix/trace

Dev-time request tracing for Yelix apps. Framework logs interleave when requests
run in parallel — `yelix-trace` correlates every event by `requestId` and shows
each request as its own trace in a terminal UI.

## Quickstart

Start the collector (a TUI with sessions, traces and a request preview):

```bash
dx jsr:@yelix/trace/cli --secret=dev-secret --port=7357
```

> `dx` is Deno's package runner (Deno 2.6+). Install the alias once if you
> haven't before: `deno x --install-alias`. Without it, the equivalent is
> `deno x jsr:@yelix/trace/cli --secret=dev-secret --port=7357`.

Attach the reporter to your app — works with `@yelix/hono` and `@yelix/express`,
no framework changes needed:

```ts
import { attachYelixTrace } from "jsr:@yelix/trace";

const app = new YelixHono();
attachYelixTrace(app, { port: 7357, secret: "dev-secret" });
```

Every app launch (including hot-reloads) starts a new **session**; incoming
events always attach to the latest session. Each request becomes a **trace**
with its middleware timeline, middleware logs, request/response bodies and
schema-validation mismatches.

## TUI keys

| Key               | Action                            |
| ----------------- | --------------------------------- |
| `tab`             | cycle sessions / traces / preview |
| `1` `2` `3`       | focus a pane directly             |
| `↑` `↓` / `j` `k` | navigate / scroll preview         |
| `q` / Ctrl-C      | quit                              |

Sessions list marks the live session with `●` and implicit sessions (events
arrived before `session/start`, e.g. the CLI started after the app) with `*`.
The traces list auto-follows the newest request until you navigate away.

## Headless mode

Non-TTY environments (or `--headless`) print plain lines instead of the UI:

```bash
dx jsr:@yelix/trace/cli --secret=dev-secret --headless
# yelix-trace listening, waiting first log — http://127.0.0.1:7357
# [12:01:22.103] session #1 started
# 201 POST /login · 3.10 ms
```

## Reporter options

| Option            | Default     | Description                                |
| ----------------- | ----------- | ------------------------------------------ |
| `port`            | —           | Port of the running CLI (required)         |
| `secret`          | —           | Bearer secret (required)                   |
| `host`            | `127.0.0.1` | CLI host                                   |
| `flushIntervalMs` | `250`       | Batch flush interval                       |
| `maxQueue`        | `10000`     | Queue cap; oldest events dropped when full |
| `meta`            | —           | Extra metadata sent with `session/start`   |

The reporter is fire-and-forget: events are queued synchronously and flushed in
batches; failures are retried and never thrown into your app.

## Protocol

Plain HTTP + JSON, `Authorization: Bearer <secret>` on every request:

- `POST /session/start` — `{ v, startedAt, meta }`
- `POST /events` — `{ v, events: [{ at, event, payload }] }`

`event` is one of the Yelix framework events (`request.start`, `request.end`,
`middleware.start`, `middleware.end`, `middleware.log`,
`response.schema.mismatch`); `at` is the reporter-side timestamp used for
ordering. See [`src/protocol.ts`](./src/protocol.ts).

## Programmatic use

`TraceStore` and `startTraceServer` are exported if you want to embed the
collector somewhere else (a dashboard, tests, …).

## License

MIT
