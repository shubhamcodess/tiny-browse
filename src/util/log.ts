/**
 * Logging that never writes anywhere unless asked to.
 *
 * - The library is silent by default: its caller owns the terminal.
 * - The CLI installs a stderr sink (stdout belongs to the MCP stdio protocol).
 * - Each library client can pass its own logger; it applies to everything that
 *   client's calls do (tracked with AsyncLocalStorage), so two clients in one
 *   process never see each other's logs.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** Anything console-like: only the methods you provide are used. */
export interface Logger {
  error?(message: string, extra?: unknown): void;
  warn?(message: string, extra?: unknown): void;
  info?(message: string, extra?: unknown): void;
  debug?(message: string, extra?: unknown): void;
}

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

interface Target {
  logger: Logger | undefined;
  level: LogLevel;
}

const global: Target = { logger: undefined, level: "info" };
const scoped = new AsyncLocalStorage<Target>();

export function setLogLevel(level: LogLevel): void {
  global.level = level;
}

/** Process-wide logger (the CLI uses this); undefined = silent. */
export function setLogger(logger: Logger | undefined): void {
  global.logger = logger;
}

/** Run `fn` (and everything it starts) with its own logger. */
export function withLogger<T>(logger: Logger | undefined, level: LogLevel, fn: () => T): T {
  return scoped.run({ logger, level }, fn);
}

/** A logger that writes `[tiny-browse] level: message` lines to stderr. */
export const stderrLogger: Logger = {
  error: (m, e) => line("error", m, e),
  warn: (m, e) => line("warn", m, e),
  info: (m, e) => line("info", m, e),
  debug: (m, e) => line("debug", m, e),
};

function line(level: string, msg: string, extra?: unknown): void {
  const text = `[tiny-browse] ${level}: ${msg}`;
  process.stderr.write(extra === undefined ? `${text}\n` : `${text} ${safeJson(extra)}\n`);
}

function write(level: Exclude<LogLevel, "silent">, msg: string, extra?: unknown): void {
  const t = scoped.getStore() ?? global;
  if (!t.logger || ORDER[level] > ORDER[t.level]) return;
  try {
    t.logger[level]?.(msg, extra);
  } catch {
    // a caller's logger must never break a search
  }
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
