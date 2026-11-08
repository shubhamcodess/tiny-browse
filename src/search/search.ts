/**
 * Run a query through the provider chain (Google first, then fallbacks):
 * skip providers cooling down after a CAPTCHA, keep a polite gap between
 * queries to the same engine, cache recent results, and report every attempt.
 */
import { join } from "node:path";
import type { Browser } from "../browser/browser.js";
import { DiskCache } from "../util/disk-cache.js";
import type { Config, SearchProviderName } from "../config.js";
import { log } from "../util/log.js";
import { showChallenge } from "./challenge.js";
import { PROVIDERS, type ProviderDef } from "./providers.js";
import { limitsFrom, RateBudget } from "./budget.js";
import { redirectResolver } from "./redirects.js";
import { readSerp } from "./serp.js";
import type { ProviderState } from "./state.js";
import type { SearchOptions, SerpPage } from "./types.js";

/** One provider attempt, as reported to the caller. */
export interface Attempt {
  provider: SearchProviderName;
  status: SerpPage["status"] | "skipped";
  ms: number;
  note?: string;
}

export interface SearchOutcome {
  page: SerpPage;
  attempts: Attempt[];
  cached: boolean;
  /** Set when these are the best results available but they look off-topic. */
  warning?: string;
}

export class SearchUnavailableError extends Error {
  override name = "SearchUnavailableError";
  constructor(readonly attempts: Attempt[]) {
    super(`No search engine returned results. ${describeAttempts(attempts)}`);
  }
}

const CONSENT_COOLDOWN_MS = 10 * 60_000;
const UNHEALTHY_COOLDOWN_MS = 2 * 60_000;

export type ReadPage = (
  provider: ProviderDef,
  query: string,
  url: string,
  opts: SearchOptions,
  signal: AbortSignal,
) => Promise<SerpPage>;

export class SearchService {
  private readonly cache = new Map<string, { at: number; outcome: SearchOutcome }>();
  // Shared with other tiny-browse processes: a repeated query never costs an engine request.
  private readonly disk: DiskCache<SearchOutcome>;
  private readonly queues = new Map<SearchProviderName, Promise<void>>();
  private readonly readPage: ReadPage;
  readonly budget: RateBudget;

  constructor(
    private readonly browser: Browser,
    private readonly config: Config,
    private readonly state: ProviderState,
    readPage?: ReadPage,
    budget?: RateBudget,
  ) {
    this.readPage = readPage ?? ((p, q, url, o, s) => this.readWithBrowser(p, q, url, o, s));
    this.budget = budget ?? new RateBudget(config.cache.enabled ? config.cache.dir : undefined, limitsFrom(config.search.limits));
    this.disk = new DiskCache<SearchOutcome>(config.cache.enabled ? join(config.cache.dir, "serp") : undefined, config.cache.serpTtlMs, 300);
  }

  async search(query: string, opts: SearchOptions, signal: AbortSignal): Promise<SearchOutcome> {
    const key = JSON.stringify([query.toLowerCase(), opts.site ?? "", opts.freshness, opts.maxResults]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.config.cache.serpTtlMs) return { ...hit.outcome, cached: true };
    const shared = this.disk.get(key);
    if (shared) return { ...shared, cached: true };

    const attempts: Attempt[] = [];
    let offTopic: SerpPage | undefined;
    for (const name of this.config.search.providers) {
      if (signal.aborted) break;
      const cooling = this.state.coolingDown(name);
      if (cooling) {
        const mins = Math.ceil((cooling.until - Date.now()) / 60_000);
        attempts.push({ provider: name, status: "skipped", ms: 0, note: `${cooling.reason}, retrying in ${mins} min` });
        continue;
      }

      const def = PROVIDERS[name];
      let page = await this.attempt(def, query, opts, signal);
      if ("skipped" in page) {
        attempts.push({ provider: name, status: "skipped", ms: 0, note: page.skipped });
        continue;
      }

      if (page.status === "challenge" && this.config.browser.onChallenge === "show" && page.signals?.url) {
        const solved = await showChallenge(this.browser, this.config, page.signals.url).catch((err: Error) => {
          log.warn(`could not show the CAPTCHA: ${err.message}`);
          return false;
        });
        if (solved) {
          const retry = await this.attempt(def, query, opts, signal);
          if (!("skipped" in retry)) page = retry;
        }
      }

      attempts.push({ provider: name, status: page.status, ms: Math.round(page.ms), note: noteFor(page) });

      if (page.status === "ok" || page.status === "no_results") {
        this.state.clear(name);
        this.budget.succeeded(name);
        const outcome = { page, attempts, cached: false };
        this.cache.set(key, { at: Date.now(), outcome });
        this.disk.set(key, outcome);
        return outcome;
      }
      if (page.status === "challenge") {
        // Each CAPTCHA in a row pauses the engine longer: 15 min, 1 h, 4 h, 24 h.
        const pause = this.budget.strike(name);
        this.state.coolDown(name, pause, "CAPTCHA");
      } else if (page.status === "consent") this.state.coolDown(name, CONSENT_COOLDOWN_MS, "consent page");
      else if (page.status === "unhealthy") {
        log.warn(`serp_drift: ${def.label} results page not recognised`, page.strategies);
        this.state.coolDown(name, UNHEALTHY_COOLDOWN_MS, "results page not recognised");
      } else if (page.status === "off_topic") {
        log.warn(`${def.label} returned results unrelated to the query`);
        offTopic ??= page;
      }
    }
    // Better something clearly labeled than nothing. Not cached.
    if (offTopic) {
      return {
        page: offTopic,
        attempts,
        cached: false,
        warning: `These ${PROVIDERS[offTopic.provider].label} results may not match the query: the search engine may be serving degraded results to automated browsers.`,
      };
    }
    throw new SearchUnavailableError(attempts);
  }

  /** One request at a time per engine, and only within its rate budget. */
  private async attempt(
    def: ProviderDef,
    query: string,
    opts: SearchOptions,
    signal: AbortSignal,
  ): Promise<SerpPage | { skipped: string }> {
    const release = await this.slot(def.name);
    try {
      const booking = this.budget.reserve(def.name);
      if (!booking.ok) return { skipped: booking.reason };
      if (booking.waitMs > 0) await sleep(booking.waitMs, signal);
      return await this.readPage(def, query, def.buildUrl(query, opts), opts, signal);
    } finally {
      release();
    }
  }

  /** Serialize requests to one engine within this process. */
  private async slot(name: SearchProviderName): Promise<() => void> {
    const prev = this.queues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queues.set(name, prev.then(() => mine));
    await prev;
    return release;
  }

  private async readWithBrowser(
    def: ProviderDef,
    query: string,
    url: string,
    opts: SearchOptions,
    signal: AbortSignal,
  ): Promise<SerpPage> {
    const start = performance.now();
    try {
      return await this.browser.withPage(async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: this.config.fetch.timeoutMs * 2, signal });
        const r = await readSerp(page, def, {
          signal,
          query,
          resolve: redirectResolver(this.browser, def.internalHost, {
            // Following result links is a request to the engine: it counts against its budget.
            allow: (n) => def.name !== "google" || this.budget.reserve("google-redirect", n, 0).ok,
          }),
          limit: opts.maxResults,
        });
        return {
          provider: def.name,
          status: r.status,
          results: r.results.slice(0, opts.maxResults).map((x, i) => ({ ...x, rank: i + 1 })),
          signals: r.signals,
          strategies: r.strategies,
          ms: performance.now() - start,
        };
      }, { kind: "profile" });
    } catch (err) {
      if (signal.aborted) throw err;
      return {
        provider: def.name,
        status: "error",
        results: [],
        strategies: { visual: 0, accessibility: 0, selectors: 0 },
        ms: performance.now() - start,
        error: (err as Error).message.split("\n")[0],
      };
    }
  }
}

function noteFor(page: SerpPage): string | undefined {
  switch (page.status) {
    case "challenge":
      return "CAPTCHA";
    case "consent":
      return "consent page (run `tiny-browse login` once)";
    case "unhealthy":
      return "results page not recognised";
    case "off_topic":
      return "results unrelated to the query";
    case "error":
      return page.error;
    default:
      return undefined;
  }
}

export function describeAttempts(attempts: Attempt[]): string {
  return attempts
    .map((a) => `${PROVIDERS[a.provider].label}: ${a.status === "skipped" ? `skipped (${a.note})` : (a.note ?? a.status)}`)
    .join("; ");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
