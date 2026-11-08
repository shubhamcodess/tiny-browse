/**
 * Logger that writes only to stderr. stdout is reserved for the MCP stdio
 * transport, so nothing else may ever be printed there while serving.
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function write(level: Exclude<LogLevel, "silent">, msg: string, extra?: unknown): void {
  if (ORDER[level] > ORDER[current]) return;
  const line = `[tiny-browse] ${level}: ${msg}`;
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${safeJson(extra)}\n`);
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
};
