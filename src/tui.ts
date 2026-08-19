import { fmtTime, inlineJson, prettyJson } from "./fmt.ts";
import type { Session, Trace, TraceStore } from "./store.ts";

export interface TuiOptions {
  store: TraceStore;
  /** Public URL of the trace server, shown in the header. */
  url: string;
  /** CLI version, shown in the footer. */
  version: string;
}

const E = "\x1b[";
const RESET = `${E}0m`;
const BOLD = `${E}1m`;
const INVERSE = `${E}7m`;
const FG = {
  red: `${E}31m`,
  green: `${E}32m`,
  yellow: `${E}33m`,
  cyan: `${E}36m`,
  gray: `${E}90m`,
};

type Pane = "sessions" | "traces" | "preview";
const PANES: Pane[] = ["sessions", "traces", "preview"];

interface Cell {
  text: string;
  fg?: string;
}

const BLANK: Cell = { text: "" };

interface TuiState {
  focus: Pane;
  sessionIdx: number;
  traceIdx: number;
  sessionScroll: number;
  traceScroll: number;
  previewScroll: number;
  followSession: boolean;
  followTrace: boolean;
  lastTraceId: string | null;
  dirty: boolean;
  closed: boolean;
}

function statusColor(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status < 300) return FG.green;
  if (status < 400) return FG.cyan;
  if (status < 500) return FG.yellow;
  return FG.red;
}

/** Pads/truncates plain text to `width`, then applies whole-cell styling. */
function padCell(cell: Cell, width: number, selected: boolean): string {
  let t = cell.text;
  if (t.length > width) t = t.slice(0, Math.max(0, width - 1)) + "…";
  t = t.padEnd(width);
  if (selected) return INVERSE + t + RESET;
  return cell.fg ? cell.fg + t + RESET : t;
}

function scrollWindow(idx: number, prev: number, height: number): number {
  if (idx < prev) return idx;
  if (idx >= prev + height) return idx - height + 1;
  return prev;
}

/** Takes over the terminal (alternate screen) until the user quits with `q` / Ctrl-C. */
export function startTui(options: TuiOptions): void {
  const { store, url, version } = options;
  const state: TuiState = {
    focus: "traces",
    sessionIdx: 0,
    traceIdx: 0,
    sessionScroll: 0,
    traceScroll: 0,
    previewScroll: 0,
    followSession: true,
    followTrace: true,
    lastTraceId: null,
    dirty: true,
    closed: false,
  };

  const write = (s: string): void => {
    try {
      const bytes = new TextEncoder().encode(s);
      // writeSync may short-write large frames; loop or the frame's tail
      // (bottom rule + footer) silently goes missing.
      let offset = 0;
      while (offset < bytes.length) {
        offset += Deno.stdout.writeSync(bytes.subarray(offset));
      }
    } catch {
      // Terminal went away; nothing useful to do.
    }
  };

  // Set YELIX_TRACE_DEBUG_FRAME=<path> to dump each rendered frame (plain
  // text) for diagnosing terminal-specific rendering issues.
  const debugFramePath = ((): string | undefined => {
    try {
      return Deno.env.get("YELIX_TRACE_DEBUG_FRAME") || undefined;
    } catch {
      return undefined;
    }
  })();

  const cleanup = (): void => {
    if (state.closed) return;
    state.closed = true;
    // Raw mode must be released before exit or the parent shell stays broken
    // (no line editing, Enter stops working).
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // stdin may already be closed.
    }
    write(RESET + `${E}?25h` + `${E}?1049l`);
    Deno.exit(0);
  };

  // Both panes display newest first: index 0 is the latest entry.
  const orderedSessions = (): Session[] => [...store.sessions].reverse();

  const selectedSession = (sessions: Session[]): Session | undefined => {
    if (state.followSession) state.sessionIdx = 0;
    state.sessionIdx = Math.min(
      Math.max(state.sessionIdx, 0),
      sessions.length - 1,
    );
    return sessions[state.sessionIdx];
  };

  const selectedTraces = (session: Session | undefined): Trace[] => {
    if (!session) return [];
    return [...session.traces.values()].sort((a, b) =>
      b.startedAt - a.startedAt
    );
  };

  const sessionsPane = (sessions: Session[], height: number): Cell[] => {
    const cells: Cell[] = [{ text: " Sessions", fg: BOLD }];
    const itemsHeight = height - 1;
    state.sessionScroll = scrollWindow(
      state.sessionIdx,
      state.sessionScroll,
      itemsHeight,
    );
    for (let i = 0; i < itemsHeight; i++) {
      const idx = state.sessionScroll + i;
      const s = sessions[idx];
      if (!s) {
        cells.push(BLANK);
        continue;
      }
      const live = store.current === s ? "●" : " ";
      const implicit = s.implicit ? " *" : "";
      cells.push({
        text: ` ${live} #${s.id} ${
          fmtTime(s.startedAt)
        } · ${s.traces.size} tr${implicit}`,
      });
    }
    return cells;
  };

  const tracesPane = (
    session: Session | undefined,
    traces: Trace[],
    height: number,
  ): Cell[] => {
    const cells: Cell[] = [{
      text: session ? ` Traces — session #${session.id}` : " Traces",
      fg: BOLD,
    }];
    const itemsHeight = height - 1;
    state.traceScroll = scrollWindow(
      state.traceIdx,
      state.traceScroll,
      itemsHeight,
    );
    for (let i = 0; i < itemsHeight; i++) {
      const idx = state.traceScroll + i;
      const t = traces[idx];
      if (!t) {
        cells.push(BLANK);
        continue;
      }
      const status = t.status === undefined ? "…" : String(t.status);
      const right = t.duration ? `${status} ${t.duration}` : status;
      const left = ` ${t.method ?? "?"} ${t.pathname ?? t.url ?? "?"}`;
      cells.push({
        text: `${left}  ${right}`,
        fg: t.endedAt ? statusColor(t.status) : FG.gray,
      });
    }
    return cells;
  };

  const previewPane = (trace: Trace | undefined, height: number): Cell[] => {
    let cells: Cell[];
    if (store.sessions.length === 0) {
      cells = [
        BLANK,
        { text: " yelix-trace", fg: BOLD },
        { text: " Listening, waiting first log", fg: FG.cyan },
        { text: ` ${url}`, fg: FG.cyan },
        BLANK,
        { text: " Attach the reporter to your app to begin:", fg: FG.gray },
        { text: "   attachYelixTrace(app, { port, secret })", fg: FG.gray },
      ];
    } else if (!trace) {
      cells = [BLANK, {
        text: " No requests yet in this session.",
        fg: FG.gray,
      }];
    } else {
      cells = tracePreview(trace);
    }
    const maxScroll = Math.max(0, cells.length - height);
    state.previewScroll = Math.min(state.previewScroll, maxScroll);
    const visible = cells.slice(
      state.previewScroll,
      state.previewScroll + height,
    );
    while (visible.length < height) visible.push(BLANK);
    return visible;
  };

  const render = (): void => {
    const { rows, columns } = Deno.consoleSize();
    if (rows < 8 || columns < 40) {
      write(`${E}H${E}2Jterminal too small`);
      return;
    }
    const sessionsW = Math.max(20, Math.min(28, Math.floor(columns * 0.2)));
    const tracesW = Math.max(28, Math.min(46, Math.floor(columns * 0.3)));
    const previewW = columns - sessionsW - tracesW - 2;
    const contentRows = rows - 4;

    const sessions = orderedSessions();
    const session = selectedSession(sessions);
    const traces = selectedTraces(session);
    if (state.followTrace) state.traceIdx = 0;
    state.traceIdx = Math.min(Math.max(state.traceIdx, 0), traces.length - 1);
    const trace = traces[state.traceIdx];
    if (trace && trace.requestId !== state.lastTraceId) {
      state.previewScroll = 0;
      state.lastTraceId = trace.requestId;
    }

    const sCol = sessionsPane(sessions, contentRows);
    const tCol = tracesPane(session, traces, contentRows);
    const pCol = previewPane(trace, contentRows);

    const headerText =
      ` yelix-trace v${version} │ ${url} │ sessions: ${store.sessions.length}`;
    const headerTrimmed = headerText.length > columns
      ? headerText.slice(0, columns - 1) + "…"
      : headerText.padEnd(columns);
    const header = FG.gray + headerTrimmed + RESET;
    const rule = FG.gray + "─".repeat(columns) + RESET;
    const sep = FG.gray + "│" + RESET;

    const lines: string[] = [header, rule];
    for (let r = 0; r < contentRows; r++) {
      const s = padCell(
        sCol[r] ?? BLANK,
        sessionsW,
        state.focus === "sessions" &&
          r === state.sessionIdx - state.sessionScroll + 1,
      );
      const t = padCell(
        tCol[r] ?? BLANK,
        tracesW,
        state.focus === "traces" &&
          r === state.traceIdx - state.traceScroll + 1,
      );
      const p = padCell(pCol[r] ?? BLANK, previewW, false);
      lines.push(s + sep + t + sep + p);
    }
    lines.push(rule);
    const focusTag = `[${state.focus}]`;
    // columns - 1: some Windows terminals scroll the screen when the
    // bottom-right cell is written, which would push the footer off-screen.
    const footerPlain =
      ` ${focusTag}  tab/1/2/3: pane · ↑↓/j/k: move · q: quit · v${version}`
        .padEnd(columns - 1);
    lines.push(
      ` ${BOLD}${focusTag}${RESET}${FG.gray}${
        footerPlain.slice(1 + focusTag.length)
      }${RESET}`,
    );
    // Absolute cursor addressing per line — immune to newline/wrap quirks
    // that can swallow the last line on ConPTY-based terminals.
    let frame = "";
    for (let i = 0; i < lines.length; i++) {
      frame += `${E}${i + 1};1H${lines[i]}`;
    }
    write(frame);
    if (debugFramePath) {
      try {
        const esc = String.fromCharCode(27);
        const ansiPattern = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, "g");
        const plain = lines
          .map((l) => l.replace(ansiPattern, ""))
          .join("\n");
        Deno.writeTextFileSync(
          debugFramePath,
          `rows=${rows} cols=${columns} lines=${lines.length}\n${plain}\n`,
        );
      } catch {
        // Debug dump is best-effort.
      }
    }
  };

  const move = (delta: number): void => {
    if (state.focus === "sessions") {
      const len = store.sessions.length;
      if (len === 0) return;
      state.followSession = false;
      state.sessionIdx = Math.min(
        Math.max(state.sessionIdx + delta, 0),
        len - 1,
      );
      state.followSession = state.sessionIdx === 0;
      state.followTrace = true;
      state.traceScroll = 0;
    } else if (state.focus === "traces") {
      const traces = selectedTraces(orderedSessions()[state.sessionIdx]);
      if (traces.length === 0) return;
      state.followTrace = false;
      state.traceIdx = Math.min(
        Math.max(state.traceIdx + delta, 0),
        traces.length - 1,
      );
      state.followTrace = state.traceIdx === 0;
    } else {
      state.previewScroll = Math.max(0, state.previewScroll + delta);
    }
  };

  const onKey = (key: string): void => {
    if (key === "q" || key === "\x03") return cleanup();
    if (key === "\t") {
      state.focus = PANES[(PANES.indexOf(state.focus) + 1) % PANES.length];
    } else if (key === "1") state.focus = "sessions";
    else if (key === "2") state.focus = "traces";
    else if (key === "3") state.focus = "preview";
    else if (key === "UP" || key === "k") move(-1);
    else if (key === "DOWN" || key === "j") move(1);
    else return;
    state.dirty = true;
  };

  const readInput = async (): Promise<void> => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of Deno.stdin.readable) {
      buf += dec.decode(chunk, { stream: true });
      while (buf.length > 0) {
        if (buf === "\x1b" || buf === "\x1b[") break; // incomplete escape, wait for more
        let key: string;
        if (buf.startsWith("\x1b[A")) {
          key = "UP";
          buf = buf.slice(3);
        } else if (buf.startsWith("\x1b[B")) {
          key = "DOWN";
          buf = buf.slice(3);
        } else if (buf.startsWith("\x1b[C")) {
          key = "RIGHT";
          buf = buf.slice(3);
        } else if (buf.startsWith("\x1b[D")) {
          key = "LEFT";
          buf = buf.slice(3);
        } else if (buf.startsWith("\x1b")) {
          buf = buf.slice(1);
          continue;
        } else {
          key = buf[0];
          buf = buf.slice(1);
        }
        onKey(key);
        if (state.closed) return;
      }
    }
  };

  let lastSize = "";
  const tick = (): void => {
    if (state.closed) return;
    let sizeKey = lastSize;
    try {
      const { rows, columns } = Deno.consoleSize();
      sizeKey = `${rows}x${columns}`;
    } catch {
      return;
    }
    if (state.dirty || sizeKey !== lastSize) {
      lastSize = sizeKey;
      state.dirty = false;
      render();
    }
  };

  store.subscribe(() => {
    state.dirty = true;
  });
  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);
  Deno.stdin.setRaw(true);
  write(`${E}?1049h${E}?25l`);
  setInterval(tick, 100);
  void readInput();
}

function tracePreview(trace: Trace): Cell[] {
  const cells: Cell[] = [];
  const status = trace.status === undefined ? "…" : String(trace.status);
  cells.push({
    text: ` ${trace.method ?? "?"} ${
      trace.pathname ?? trace.url ?? "?"
    } → ${status} · ${trace.duration ?? "…"}`,
    fg: statusColor(trace.status) ?? BOLD,
  });
  cells.push({
    text: ` ${fmtTime(trace.startedAt)}${
      trace.endedAt ? ` → ${fmtTime(trace.endedAt)}` : " (pending)"
    }  ${trace.requestId}`,
    fg: FG.gray,
  });
  cells.push(BLANK);

  cells.push({ text: " Middleware", fg: BOLD });
  if (trace.middlewares.length === 0) {
    cells.push({ text: "   (none)", fg: FG.gray });
  }
  for (const span of trace.middlewares) {
    cells.push({
      text: `   ${String(span.count).padStart(2)}  ${span.name.padEnd(24)} ${
        span.duration ?? "…"
      }`,
    });
    for (const log of span.logs) {
      const msg = log.messages
        .map((m) => (typeof m === "string" ? m : inlineJson(m)))
        .join(" ");
      cells.push({ text: `      │ ${fmtTime(log.at)}  ${msg}`, fg: FG.gray });
    }
  }
  cells.push(BLANK);

  const start = trace.start;
  if (start) {
    cells.push({ text: " Request", fg: BOLD });
    if (start.url) cells.push({ text: `   url     ${String(start.url)}` });
    if (start.query && Object.keys(start.query as object).length > 0) {
      cells.push({ text: `   query   ${inlineJson(start.query)}` });
    }
    if (start.params && Object.keys(start.params as object).length > 0) {
      cells.push({ text: `   params  ${inlineJson(start.params)}` });
    }
    if (start.hasContent) {
      cells.push({ text: "   body", fg: FG.gray });
      for (
        const line of prettyJson(
          (start.body as Record<string, unknown>)?.parsed ?? start.body,
          40,
        )
      ) {
        cells.push({ text: `     ${line}` });
      }
    }
    cells.push(BLANK);
  }

  const end = trace.end;
  if (end) {
    cells.push({ text: " Response", fg: BOLD });
    cells.push({ text: `   status  ${status}`, fg: statusColor(trace.status) });
    if (end.responseBody !== undefined) {
      cells.push({ text: "   body", fg: FG.gray });
      for (const line of prettyJson(end.responseBody, 60)) {
        cells.push({ text: `     ${line}` });
      }
    }
    cells.push(BLANK);
  }

  if (trace.mismatches.length > 0) {
    cells.push({ text: " Schema mismatches", fg: FG.red });
    for (const m of trace.mismatches) {
      cells.push({ text: `   ${inlineJson(m)}`, fg: FG.red });
    }
  }
  return cells;
}
