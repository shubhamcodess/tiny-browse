import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cacheDir, configDir } from "./util/paths.js";
import { LOG_LEVELS, type LogLevel } from "./util/log.js";

export type SearchProviderName = "google" | "duckduckgo" | "bing";
export const SEARCH_PROVIDERS: readonly SearchProviderName[] = ["google", "duckduckgo", "bing"];

export interface Config {
  browser: {
    /** Explicit browser executable. Empty = auto-discover. */
    path: string;
    /**
     * `launch` our own Chrome, `attach` to one at `cdpUrl`, or `off`: no Chrome
     * at all (plain HTTP search and reading; faster, lower coverage).
     */
    mode: "launch" | "attach" | "off";
    cdpUrl: string;
    headless: boolean;
    /** Launch at server start (Chrome-first). */
    eager: boolean;
    idleTimeoutMs: number;
    /** On CAPTCHA: answer from the next provider, or show a window for the user. */
    onChallenge: "fallback" | "show";
    profileDir: string;
  };
  search: {
    /** Ordered chain: first is primary, rest are fallbacks. */
    providers: SearchProviderName[];
    /**
     * Per-engine request budgets, overriding the strict defaults in
     * search/budget.ts, e.g. { "google": { "perHour": 10 } }.
     */
    limits: Record<string, Partial<{ minGapMs: number; jitterMs: number; perMinute: number; perHour: number; perDay: number }>>;
    maxResults: number;
    read: number;
  };
  fetch: {
    timeoutMs: number;
    maxBytes: number;
    concurrency: number;
    allowPrivateNetwork: boolean;
    /** Private hosts to allow anyway, as "host" or "host:port". */
    allowHosts: string[];
  };
  output: {
    maxTokens: number;
    links: "inline" | "reference" | "text";
  };
  images: {
    mode: "off" | "urls" | "inline";
    max: number;
    maxBytes: number;
  };
  ranking: {
    prefer: string[];
    block: string[];
  };
  cache: {
    enabled: boolean;
    dir: string;
    pageTtlMs: number;
    serpTtlMs: number;
  };
  /** Hard deadline for one tool call; partial results are returned after it. */
  callTimeoutMs: number;
  logLevel: LogLevel;
}

/** A recursively partial config, as found in files, env and flags. */
export type ConfigInput = { [K in keyof Config]?: Config[K] extends object ? Partial<Config[K]> : Config[K] };

export function defaultConfig(env: Record<string, string | undefined> = process.env): Config {
  const cache = cacheDir(env);
  return {
    browser: {
      path: "",
      mode: "launch",
      cdpUrl: "",
      headless: true,
      eager: true,
      idleTimeoutMs: 5 * 60_000,
      onChallenge: "fallback",
      profileDir: join(cache, "chrome-profile"),
    },
    search: {
      providers: ["google", "duckduckgo", "bing"],
      limits: {},
      maxResults: 5,
      read: 3,
    },
    fetch: {
      timeoutMs: 8000,
      maxBytes: 5 * 1024 * 1024,
      concurrency: 4,
      allowPrivateNetwork: false,
      allowHosts: [],
    },
    output: { maxTokens: 6000, links: "reference" },
    images: { mode: "off", max: 4, maxBytes: 1024 * 1024 },
    ranking: { prefer: [], block: [] },
    cache: { enabled: true, dir: cache, pageTtlMs: 60 * 60_000, serpTtlMs: 10 * 60_000 },
    callTimeoutMs: 20_000,
    logLevel: "info",
  };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Merge `over` into `base` one level deep (sections are merged, arrays replaced). */
export function mergeConfig(base: Config, over: ConfigInput | undefined): Config {
  if (!over) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    if (!(key in base)) throw new ConfigError(`unknown config key "${key}"`);
    const cur = (base as unknown as Record<string, unknown>)[key];
    if (isPlainObject(cur)) {
      if (!isPlainObject(value)) throw new ConfigError(`config key "${key}" must be an object`);
      for (const sub of Object.keys(value)) {
        if (!(sub in cur)) throw new ConfigError(`unknown config key "${key}.${sub}"`);
      }
      out[key] = { ...cur, ...stripUndefined(value) };
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Config;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Read a JSON config file; returns undefined if it does not exist. */
export function readConfigFile(path: string): ConfigInput | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`cannot parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw new ConfigError(`${path} must contain a JSON object`);
  return parsed as ConfigInput;
}

function parseBool(name: string, v: string): boolean {
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new ConfigError(`${name} must be true or false, got "${v}"`);
}

export function parseProviders(v: string): SearchProviderName[] {
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!SEARCH_PROVIDERS.includes(p as SearchProviderName)) {
      throw new ConfigError(`unknown search provider "${p}" (known: ${SEARCH_PROVIDERS.join(", ")})`);
    }
  }
  if (list.length === 0) throw new ConfigError("at least one search provider is required");
  return list as SearchProviderName[];
}

/** Config overrides from `TINY_BROWSE_*` environment variables. */
export function configFromEnv(env: Record<string, string | undefined>): ConfigInput {
  const out: ConfigInput = {};
  const browser: Partial<Config["browser"]> = {};
  if (env.TINY_BROWSE_CHROME) browser.path = env.TINY_BROWSE_CHROME;
  if (env.TINY_BROWSE_CDP_URL) {
    browser.cdpUrl = env.TINY_BROWSE_CDP_URL;
    browser.mode = "attach";
  }
  if (env.TINY_BROWSE_HEADLESS) browser.headless = parseBool("TINY_BROWSE_HEADLESS", env.TINY_BROWSE_HEADLESS);
  if (Object.keys(browser).length) out.browser = browser;
  if (env.TINY_BROWSE_PROVIDERS) out.search = { providers: parseProviders(env.TINY_BROWSE_PROVIDERS) };
  if (env.TINY_BROWSE_LOG_LEVEL) out.logLevel = env.TINY_BROWSE_LOG_LEVEL as LogLevel;
  return out;
}

export interface LoadOptions {
  /** Explicit config file (`--config` / `TINY_BROWSE_CONFIG`). Must exist. */
  file?: string;
  /** Overrides from CLI flags; applied last. */
  flags?: ConfigInput;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Precedence: defaults ← user config ← project config ← explicit file ← env ← flags.
 * Per-call tool arguments are applied later, by the tool handlers.
 */
export function loadConfig(opts: LoadOptions = {}): { config: Config; files: string[] } {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const files: string[] = [];
  let cfg = defaultConfig(env);

  const candidates = [join(configDir(env), "config.json"), join(cwd, "tiny-browse.config.json")];
  for (const path of candidates) {
    const input = readConfigFile(path);
    if (input) {
      cfg = mergeWithSource(cfg, input, path);
      files.push(path);
    }
  }

  const explicit = opts.file ?? env.TINY_BROWSE_CONFIG;
  if (explicit) {
    const path = resolve(cwd, explicit);
    const input = readConfigFile(path);
    if (!input) throw new ConfigError(`config file not found: ${path}`);
    cfg = mergeWithSource(cfg, input, path);
    files.push(path);
  }

  cfg = mergeWithSource(cfg, configFromEnv(env), "environment");
  cfg = mergeWithSource(cfg, opts.flags, "command-line flags");
  validateConfig(cfg);
  return { config: cfg, files };
}

function mergeWithSource(base: Config, input: ConfigInput | undefined, source: string): Config {
  try {
    return mergeConfig(base, input);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`${source}: ${err.message}`);
    throw err;
  }
}

export function validateConfig(c: Config): void {
  const fail = (msg: string) => {
    throw new ConfigError(msg);
  };
  if (!["launch", "attach", "off"].includes(c.browser.mode)) fail(`browser.mode must be "launch", "attach" or "off"`);
  if (c.browser.mode === "attach" && !c.browser.cdpUrl) fail("browser.mode is \"attach\" but browser.cdpUrl is empty");
  if (!["fallback", "show"].includes(c.browser.onChallenge)) fail(`browser.onChallenge must be "fallback" or "show"`);
  parseProviders(c.search.providers.join(","));
  positiveInt("search.maxResults", c.search.maxResults, 1, 10);
  positiveInt("search.read", c.search.read, 0, 10);
  positiveInt("fetch.concurrency", c.fetch.concurrency, 1, 16);
  positiveInt("output.maxTokens", c.output.maxTokens, 200, 200_000);
  if (!["inline", "reference", "text"].includes(c.output.links)) fail(`output.links must be inline, reference or text`);
  if (!["off", "urls", "inline"].includes(c.images.mode)) fail(`images.mode must be off, urls or inline`);
  if (!LOG_LEVELS.includes(c.logLevel)) fail(`logLevel must be one of ${LOG_LEVELS.join(", ")}`);
}

function positiveInt(name: string, v: unknown, min: number, max: number): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(v)}`);
  }
}
