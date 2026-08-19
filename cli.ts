import pkg from "./deno.json" with { type: "json" };
import { fmtTime } from "./src/fmt.ts";
import { startTraceServer } from "./src/server.ts";
import { TraceStore } from "./src/store.ts";
import { startTui } from "./src/tui.ts";

const VERSION = pkg.version;

const USAGE = `yelix-trace — terminal trace viewer for Yelix apps

Usage:
  dx jsr:@yelix/trace/cli --secret=<secret> [options]

Options:
  --secret=<secret>  Shared secret required from reporters (required)
  --port=<port>      Port to listen on (default: 7357)
  --headless         Print plain log lines instead of the interactive UI
  -h, --help         Show this help

Then, in your app:
  import { attachYelixTrace } from "jsr:@yelix/trace";
  attachYelixTrace(app, { port: 7357, secret: "<secret>" });
`;

interface CliArgs {
  secret?: string;
  port: number;
  headless: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 7357, headless: false, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--headless") args.headless = true;
    else if (a.startsWith("--secret=")) {
      args.secret = a.slice("--secret=".length);
    } else if (a.startsWith("--port=")) {
      const p = Number(a.slice("--port=".length));
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error(`invalid --port value: ${a}`);
      }
      args.port = p;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

/** Plain-line output for non-TTY environments (CI logs, piping) or --headless. */
function headless(store: TraceStore, url: string): void {
  console.log(`yelix-trace v${VERSION} listening, waiting first log — ${url}`);
  let seenSessions = 0;
  const printed = new Set<string>();
  store.subscribe(() => {
    while (seenSessions < store.sessions.length) {
      const s = store.sessions[seenSessions++];
      console.log(
        `[${fmtTime(s.startedAt)}] session #${s.id} started${
          s.implicit ? " (implicit)" : ""
        }`,
      );
    }
    for (const s of store.sessions) {
      for (const t of s.traces.values()) {
        if (t.endedAt && !printed.has(t.requestId)) {
          printed.add(t.requestId);
          console.log(
            `${t.status ?? "?"} ${t.method ?? "?"} ${
              t.pathname ?? t.url ?? "?"
            } · ${t.duration ?? "?"}`,
          );
        }
      }
    }
  });
}

export async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(Deno.args);
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\n${USAGE}`);
    Deno.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.secret) {
    console.error(`error: --secret=<secret> is required\n\n${USAGE}`);
    Deno.exit(1);
  }

  const store = new TraceStore();
  const server = await startTraceServer({
    port: args.port,
    secret: args.secret,
    store,
  });

  if (args.headless || !Deno.stdin.isTerminal()) {
    headless(store, server.url);
  } else {
    startTui({ store, url: server.url, version: VERSION });
  }
}

if (import.meta.main) await main();
