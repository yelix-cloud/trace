export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2): string => String(n).padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${
    p(d.getMilliseconds(), 3)
  }`;
}

export function prettyJson(value: unknown, maxLines: number): string[] {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    return [
      ...lines.slice(0, maxLines),
      `… (${lines.length - maxLines} more lines)`,
    ];
  }
  return lines;
}

export function inlineJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
