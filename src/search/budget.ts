/**
 * Request budgets per search engine, shared by every tiny-browse process on
 * this computer (a small JSON file in the cache dir, updated under a lock).
 *
 * Google publishes no limit for ordinary searches; its only official numbers
 * are for the paid Custom Search JSON API (100 free queries/day, 10,000/day
 * cap). Automated Chrome gets a CAPTCHA far sooner, so the Google defaults are
 * much stricter than either. When a budget is exhausted the engine is skipped
 * (the search falls back) instead of waiting or exceeding it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SearchProviderName } from "../config.js";

export interface Limits {
  /** Minimum gap between two requests. */
  minGapMs: number;
  /** Random extra gap, 0..jitterMs, so requests don't arrive on a fixed beat. */
  jitterMs: number;
  perMinute: number;
  perHour: number;
  perDay: number;
}

/** Budget keys: one per engine, plus Google's result-link redirects (they are Google requests too). */
export type BudgetKey = SearchProviderName | "google-redirect";

export const DEFAULT_LIMITS: Record<BudgetKey, Limits> = {
  google: { minGapMs: 8_000, jitterMs: 3_000, perMinute: 3, perHour: 20, perDay: 100 },
  // Following /goto links is what a person clicking results does: short gaps, own caps.
  "google-redirect": { minGapMs: 250, jitterMs: 400, perMinute: 10, perHour: 60, perDay: 200 },
  duckduckgo: { minGapMs: 3_000, jitterMs: 1_500, perMinute: 6, perHour: 60, perDay: 300 },
  bing: { minGapMs: 3_000, jitterMs: 1_500, perMinute: 6, perHour: 60, perDay: 300 },
};

/** Defaults with any per-key overrides from config applied. */
export function limitsFrom(overrides: Partial<Record<string, Partial<Limits>>> = {}): Record<BudgetKey, Limits> {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(out) as BudgetKey[]) out[key] = { ...out[key], ...overrides[key] };
  return out;
}

/** Escalating pause after each CAPTCHA in a row: 15 min, 1 h, 4 h, 24 h. */
export const CHALLENGE_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];

interface ProviderRecord {
  /** Request times (ms) within the last 24 h. */
  times: number[];
  /** Consecutive CAPTCHAs, for the escalating backoff. */
  strikes: number;
}
type State = Partial<Record<BudgetKey, ProviderRecord>>;

export type Reservation =
  | { ok: true; waitMs: number }
  | { ok: false; reason: string; retryAt: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export class RateBudget {
  private readonly file: string;
  private memory: State = {};

  constructor(
    cacheDir: string | undefined,
    private readonly limits: Record<BudgetKey, Limits> = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.file = cacheDir ? join(cacheDir, "rate-budget.json") : "";
  }

  /**
   * Book `weight` requests. If allowed within `maxWaitMs`, records them at the
   * time they may happen and returns how long to wait first; otherwise records
   * nothing and says why.
   */
  reserve(provider: BudgetKey, weight = 1, maxWaitMs = 12_000): Reservation {
    return this.update<Reservation>((state) => {
      const lim = this.limits[provider];
      const rec = (state[provider] ??= { times: [], strikes: 0 });
      const now = this.now();
      rec.times = rec.times.filter((t) => t > now - DAY).sort((a, b) => a - b);

      // Earliest time that satisfies the gap and every window.
      let at = now;
      const last = rec.times.at(-1);
      if (last !== undefined) at = Math.max(at, last + lim.minGapMs + Math.floor(this.random() * lim.jitterMs));
      for (const [window, max] of [[MINUTE, lim.perMinute], [HOUR, lim.perHour], [DAY, lim.perDay]] as const) {
        const inWindow = rec.times.filter((t) => t > at - window);
        if (inWindow.length + weight > max) {
          // Wait until enough old requests leave the window.
          const freeAt = inWindow[inWindow.length + weight - max - 1]! + window;
          at = Math.max(at, freeAt);
        }
      }
      const waitMs = at - now;
      if (waitMs > maxWaitMs) {
        return { result: { ok: false, reason: describeWait(waitMs), retryAt: at }, changed: false };
      }
      for (let i = 0; i < weight; i++) rec.times.push(at);
      return { result: { ok: true, waitMs }, changed: true };
    });
  }

  /** Record a CAPTCHA; returns how long to leave the engine alone. */
  strike(provider: BudgetKey): number {
    return this.update((state) => {
      const rec = (state[provider] ??= { times: [], strikes: 0 });
      const pause = CHALLENGE_BACKOFF_MS[Math.min(rec.strikes, CHALLENGE_BACKOFF_MS.length - 1)]!;
      rec.strikes++;
      return { result: pause, changed: true };
    });
  }

  /** A clean answer resets the CAPTCHA streak. */
  succeeded(provider: BudgetKey): void {
    this.update((state) => {
      const rec = state[provider];
      if (!rec || rec.strikes === 0) return { result: undefined, changed: false };
      rec.strikes = 0;
      return { result: undefined, changed: true };
    });
  }

  /** Requests made in the last minute/hour/day, for `doctor`. */
  usage(provider: BudgetKey): { minute: number; hour: number; day: number; strikes: number } {
    const rec = this.read()[provider] ?? { times: [], strikes: 0 };
    const now = this.now();
    const count = (w: number) => rec.times.filter((t) => t > now - w && t <= now).length;
    return { minute: count(MINUTE), hour: count(HOUR), day: count(DAY), strikes: rec.strikes };
  }

  // ---- persistence under a simple lock file

  private read(): State {
    if (!this.file) return this.memory;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch {
      return {};
    }
  }

  private update<T>(fn: (state: State) => { result: T; changed: boolean }): T {
    if (!this.file) {
      const { result } = fn(this.memory);
      return result;
    }
    const release = this.lock();
    try {
      const state = this.read();
      const { result, changed } = fn(state);
      if (changed) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state));
        renameSync(tmp, this.file);
      }
      return result;
    } finally {
      release();
    }
  }

  private lock(): () => void {
    const lockFile = `${this.file}.lock`;
    mkdirSync(dirname(lockFile), { recursive: true });
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        const fd = openSync(lockFile, "wx");
        closeSync(fd);
        return () => {
          try {
            unlinkSync(lockFile);
          } catch {
            // already gone
          }
        };
      } catch {
        // Stale lock from a crashed process: take it over after 5 s.
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > 5000) unlinkSync(lockFile);
        } catch {
          // raced with its owner; retry
        }
        if (Date.now() > deadline) return () => {}; // never block a search on the lock
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
}

function describeWait(ms: number): string {
  if (ms < MINUTE) return `rate budget: next request allowed in ${Math.ceil(ms / 1000)} s`;
  if (ms < HOUR) return `rate budget: next request allowed in ${Math.ceil(ms / MINUTE)} min`;
  return `rate budget: next request allowed in ${Math.ceil(ms / HOUR)} h`;
}
