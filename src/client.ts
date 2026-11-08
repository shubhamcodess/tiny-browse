/**
 * The library client: the same engine as the MCP server, returned as
 * structured results instead of a Markdown blob, with lifecycle rules suited
 * to short-lived CLIs (nothing starts until the first call, nothing is left
 * running after close()).
 */
import { join } from "node:path";
import { defaultConfig, loadConfig, mergeConfig, validateConfig, type Config, type ConfigInput } from "./config.js";
import { ChromeEngine } from "./core/chrome-engine.js";
import { runChecks } from "./core/doctor.js";
import type { EngineResult, ImageBlob } from "./core/engine.js";
import { fetchInputSchema, searchInputSchema, toFetchRequest, toSearchRequest, type WebFetchInput, type WebSearchInput } from "./core/inputs.js";
import { codeForMessage, TinyBrowseError, toTinyBrowseError, type TinyBrowseErrorCode } from "./errors.js";
import { validate } from "./mcp/schema.js";
import { callServer, findServer } from "./server-file.js";
import { withLogger, type Logger, type LogLevel } from "./util/log.js";

// ---------------------------------------------------------------- public types

export type TinyBrowseConfig = ConfigInput;

export interface ClientOptions {
  /** Aborts every call made through this client (or this one call). */
  signal?: AbortSignal;
  /** Deadline for each call, in milliseconds (default 20000). */
  timeoutMs?: number;
  /**
   * Settings, merged over the defaults. When given, no config files and no
   * TINY_BROWSE_* environment variables are read.
   */
  config?: TinyBrowseConfig;
  /** Folder for caches, rate budgets and the Chrome profile (default: the OS cache folder). */
  cacheDir?: string;
  /** Chrome/Chromium/Edge/Brave executable to use instead of auto-detecting one. */
  chromePath?: string;
  /** Use an already running Chrome with remote debugging (ws:// or http://host:port). */
  cdpUrl?: string;
  /**
   * "chrome" (default): Google in your Chrome, falling back to other engines;
   * pages read over HTTP or in Chrome as needed.
   * "http": no Chrome at all. Faster to start and works without Chrome, but
   * Google is skipped and pages that need JavaScript come back thin.
   */
  mode?: "chrome" | "http";
  /**
   * "auto": if a `tiny-browse serve --http` is running (found through the
   * cache folder), send calls to it and reuse its warm Chrome; otherwise run
   * in this process. "never" (default): always run in this process.
   */
  useServer?: "auto" | "never";
  /** Receives log messages. Default: silent; nothing is ever written to stdout or stderr. */
  logger?: Logger;
  /** Lowest level passed to `logger` (default "info"). */
  logLevel?: LogLevel;
}

/** Per-call options for a client created with createClient(). */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchHit {
  rank: number;
  title: string;
  url: string;
  snippet: string;
}

export interface Page {
  /** The URL that was asked for. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  title: string;
  /** Clean, heading-structured Markdown of the page (within the token budget). */
  markdown: string;
  tokens: number;
  /** True if parts of the page were left out to fit the budget. */
  truncated: boolean;
  /** Pass to webFetch({ cursor }) to read the parts left out. */
  cursor?: string;
  /** 0..1 estimate of how cleanly the content was extracted. */
  quality?: number;
}

export interface PageFailure {
  url: string;
  code: TinyBrowseErrorCode;
  message: string;
}

export interface Image {
  id: string;
  mimeType: string;
  /** base64 */
  data: string;
}

export interface SearchResult {
  query: string;
  /** Which engine answered. */
  provider: "google" | "duckduckgo" | "bing";
  /** True if served from the cache (no engine was contacted). */
  cached: boolean;
  /** Set when the results may not match the query (degraded engine). */
  warning?: string;
  /** The result list. Empty when the engine found nothing (not an error). */
  results: SearchHit[];
  /** Pages read from the top results (see `read`). */
  pages: Page[];
  /** Results that were picked for reading but could not be read. */
  failed: PageFailure[];
  /** Every engine tried, in order, and what happened. */
  attempts: { provider: string; status: string; note?: string }[];
  /** Everything above as Markdown, within max_tokens: what an LLM should read. */
  markdown: string;
  images: Image[];
}

export interface FetchResult {
  pages: Page[];
  failed: PageFailure[];
  markdown: string;
  images: Image[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Client {
  webSearch(input: WebSearchInput, opts?: CallOptions): Promise<SearchResult>;
  webFetch(input: WebFetchInput, opts?: CallOptions): Promise<FetchResult>;
  /** Stop Chrome (if this client started it) and release everything. Safe to call twice. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------- config

export function resolveConfig(opts: ClientOptions = {}): Config {
  let cfg: Config;
  try {
    if (opts.config) {
      // Defaults depend on env only for OS folder locations, never on TINY_BROWSE_*.
      cfg = mergeConfig(defaultConfig(osEnv()), opts.config);
    } else {
      cfg = loadConfig().config;
    }
    if (opts.cacheDir) {
      const oldProfile = cfg.browser.profileDir;
      const defaultProfile = join(cfg.cache.dir, "chrome-profile");
      cfg = { ...cfg, cache: { ...cfg.cache, dir: opts.cacheDir } };
      if (oldProfile === defaultProfile) cfg.browser = { ...cfg.browser, profileDir: join(opts.cacheDir, "chrome-profile") };
    }
    const browser = { ...cfg.browser };
    if (opts.chromePath) browser.path = opts.chromePath;
    if (opts.cdpUrl) {
      browser.cdpUrl = opts.cdpUrl;
      browser.mode = "attach";
    }
    if (opts.mode === "http") browser.mode = "off";
    // The library never starts Chrome before the first call.
    browser.eager = false;
    cfg = { ...cfg, browser };
    if (opts.timeoutMs !== undefined) cfg.callTimeoutMs = opts.timeoutMs;
    validateConfig(cfg);
    return cfg;
  } catch (err) {
    throw toTinyBrowseError(err);
  }
}

function osEnv(): Record<string, string | undefined> {
  const { XDG_CACHE_HOME, XDG_CONFIG_HOME, LOCALAPPDATA, APPDATA, HOME } = process.env;
  return { XDG_CACHE_HOME, XDG_CONFIG_HOME, LOCALAPPDATA, APPDATA, HOME };
}

// ---------------------------------------------------------------- client

class TinyBrowseClient implements Client {
  private engine: ChromeEngine | undefined;
  private closed = false;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly config: Config,
    private readonly opts: ClientOptions,
  ) {}

  webSearch(input: WebSearchInput, call: CallOptions = {}): Promise<SearchResult> {
    return this.run("web_search", input, call, async (engine, signal) => {
      const req = toSearchRequest(input, this.config);
      return engine.search(req, { signal });
    }).then((r) => toSearchResult(r));
  }

  webFetch(input: WebFetchInput, call: CallOptions = {}): Promise<FetchResult> {
    return this.run("web_fetch", input, call, async (engine, signal) => engine.fetch(toFetchRequest(input), { signal })).then((r) => toFetchResult(r));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.inflight]);
    const engine = this.engine;
    this.engine = undefined;
    await withLogger(this.opts.logger, this.opts.logLevel ?? "info", () => engine?.close());
  }

  private async run(
    tool: "web_search" | "web_fetch",
    input: unknown,
    call: CallOptions,
    fn: (engine: ChromeEngine, signal: AbortSignal) => Promise<EngineResult>,
  ): Promise<EngineResult> {
    if (this.closed) throw new TinyBrowseError("invalid_input", "this client is closed; create a new one");
    const schema = tool === "web_search" ? searchInputSchema(this.config) : fetchInputSchema();
    const problems = validate(schema, input);
    if (problems.length) throw new TinyBrowseError("invalid_input", `invalid ${tool} input: ${problems.join("; ")}`);

    const timeoutMs = call.timeoutMs ?? this.config.callTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const callers = [this.opts.signal, call.signal].filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any([timeout, ...callers]);
    if (callers.some((s) => s.aborted)) throw new TinyBrowseError("aborted", "the call was aborted");

    const work = withLogger(this.opts.logger, this.opts.logLevel ?? "info", async () => {
      if (this.opts.useServer === "auto") {
        const server = findServer(this.config.cache.dir);
        if (server) {
          const r = await callServer(server, tool === "web_search" ? "/search" : "/fetch", input, signal);
          if (r) return r;
        }
      }
      this.engine ??= new ChromeEngine(this.config);
      return fn(this.engine, signal);
    });
    this.inflight.add(work);
    try {
      return await work;
    } catch (err) {
      throw toTinyBrowseError(err, {
        aborted: callers.some((s) => s.aborted),
        timedOut: timeout.aborted && !callers.some((s) => s.aborted),
      });
    } finally {
      this.inflight.delete(work);
    }
  }
}

// ---------------------------------------------------------------- results

type Doc = {
  url: string;
  finalUrl: string;
  title: string;
  ok: boolean;
  error?: string;
  markdown: string;
  tokens: number;
  truncated: boolean;
  cursor?: string;
  quality?: number;
};

function toPage(d: Doc): Page {
  return { url: d.url, finalUrl: d.finalUrl, title: d.title, markdown: d.markdown, tokens: d.tokens, truncated: d.truncated, cursor: d.cursor, quality: d.quality };
}

function toFailure(d: Doc): PageFailure {
  const message = d.error ?? "could not read this page";
  return { url: d.url, code: codeForMessage(message), message };
}

function images(r: EngineResult): Image[] {
  return (r.images ?? []).map((i: ImageBlob) => ({ id: i.id, mimeType: i.mimeType, data: i.data }));
}

function toSearchResult(r: EngineResult): SearchResult {
  const d = r.data as {
    query: string;
    provider: SearchResult["provider"];
    status: string;
    cached: boolean;
    warning?: string;
    attempts: { provider: string; status: string; note?: string }[];
    results: (SearchHit & { doc?: Doc })[];
  };
  const docs = d.results.map((x) => x.doc).filter((x): x is Doc => !!x);
  return {
    query: d.query,
    provider: d.provider,
    cached: d.cached,
    warning: d.warning,
    results: d.status === "no_results" ? [] : d.results.map(({ rank, title, url, snippet }) => ({ rank, title, url, snippet })),
    pages: docs.filter((x) => x.ok).map(toPage),
    failed: docs.filter((x) => !x.ok).map(toFailure),
    attempts: d.attempts.map(({ provider, status, note }) => ({ provider, status, note })),
    markdown: r.markdown,
    images: images(r),
  };
}

function toFetchResult(r: EngineResult): FetchResult {
  const docs = (r.data as { documents: Doc[] }).documents;
  const ok = docs.filter((x) => x.ok);
  const failed = docs.filter((x) => !x.ok).map(toFailure);
  // Nothing could be read at all: that's an error the caller should handle.
  if (!ok.length && failed.length) {
    const f = failed[0]!;
    throw new TinyBrowseError(f.code, failed.length === 1 ? `${f.url}: ${f.message}` : failed.map((x) => `${x.url}: ${x.message}`).join("; "));
  }
  return { pages: ok.map(toPage), failed, markdown: r.markdown, images: images(r) };
}

// ---------------------------------------------------------------- entry points

/** A client that reuses one Chrome across calls. Call close() when done. */
export async function createClient(opts: ClientOptions = {}): Promise<Client> {
  return new TinyBrowseClient(resolveConfig(opts), opts);
}

/** Search the web and read the top results. One-shot: everything is shut down afterwards. */
export async function webSearch(input: WebSearchInput, opts: ClientOptions = {}): Promise<SearchResult> {
  const client = await createClient(opts);
  try {
    return await client.webSearch(input);
  } finally {
    await client.close();
  }
}

/** Read pages as clean Markdown. One-shot: everything is shut down afterwards. */
export async function webFetch(input: WebFetchInput, opts: ClientOptions = {}): Promise<FetchResult> {
  const client = await createClient(opts);
  try {
    return await client.webFetch(input);
  } finally {
    await client.close();
  }
}

/** Check the environment: Node version, browser, a test Chrome start, rate budgets. */
export async function doctor(opts: ClientOptions & { startChrome?: boolean } = {}): Promise<DoctorCheck[]> {
  const config = resolveConfig(opts);
  const checks = await withLogger(opts.logger, opts.logLevel ?? "info", () =>
    runChecks(config, { startChrome: opts.startChrome ?? config.browser.mode !== "off" }),
  );
  // Information-only checks count as ok.
  return checks.map((c) => ({ name: c.name, ok: c.ok !== false, detail: c.detail }));
}
