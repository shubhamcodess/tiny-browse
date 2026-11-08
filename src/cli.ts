import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIENT_NAMES, clientSnippets, formatSnippet, setupGuide } from "./clients.js";
import { ConfigError, loadConfig, parseProviders, type Config, type ConfigInput } from "./config.js";
import { configDir } from "./util/paths.js";
import { Browser } from "./browser/browser.js";
import { discoverBrowsers, resolveBrowser } from "./browser/discover.js";
import { login } from "./browser/login.js";
import { ChromeEngine } from "./core/chrome-engine.js";
import { NotImplementedError, type Engine } from "./core/engine.js";
import { serveStdio } from "./mcp/stdio.js";
import { isHttpUrl } from "./mcp/schema.js";
import { LOG_LEVELS, log, setLogLevel, type LogLevel } from "./util/log.js";
import { VERSION } from "./version.js";

const HELP = `tiny-browse ${VERSION} - web search and page reading for AI agents, over MCP

Usage:
  tiny-browse init                First-time setup: config file, Chrome profile,
                                  checks, and the snippet to paste into your agent
  tiny-browse start               Start the MCP server on stdio (what agents launch).
                                  Run in a terminal, it also prints the agent snippet
  tiny-browse                     Same as start
  tiny-browse serve [--http PORT] Same; --http (Streamable HTTP + REST) comes later
  tiny-browse search <query...>   Search and print Markdown (or --json)
  tiny-browse fetch <url...>      Read pages and print Markdown (or --json)
  tiny-browse login [--sign-in]   Open Chrome on the tiny-browse profile to accept
                                  Google's consent screen (and optionally sign in)
  tiny-browse doctor              Show version and config; find and test Chrome
  tiny-browse open <url>          Debug: load a URL in headless Chrome, show status/timing
  tiny-browse config <client>     Print MCP setup for a client:
                                  ${CLIENT_NAMES.join(", ")}

Options:
  --config <file>        Extra config file (JSON)
  --browser-path <path>  Chrome/Chromium/Edge/Brave executable to use
  --cdp-url <url>        Attach to an already running Chrome (remote debugging)
  --headful              Show the Chrome window instead of running headless
  --no-eager             Start Chrome only when first needed
  --providers <list>     Search order, e.g. google,duckduckgo,bing
  --log-level <level>    ${LOG_LEVELS.join(" | ")} (logs go to stderr)
  --json                 search/fetch/doctor: print JSON instead of Markdown
  -h, --help             Show this help
  -v, --version          Show the version
`;

class UsageError extends Error {
  override name = "UsageError";
}

const OPTIONS = {
  config: { type: "string" },
  "browser-path": { type: "string" },
  "cdp-url": { type: "string" },
  headful: { type: "boolean" },
  "no-eager": { type: "boolean" },
  providers: { type: "string" },
  "log-level": { type: "string" },
  json: { type: "boolean" },
  http: { type: "string" },
  "sign-in": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function flagsToConfig(v: Values): ConfigInput {
  const out: ConfigInput = {};
  const browser: Partial<Config["browser"]> = {};
  if (v["browser-path"]) browser.path = v["browser-path"];
  if (v["cdp-url"]) {
    browser.cdpUrl = v["cdp-url"];
    browser.mode = "attach";
  }
  if (v.headful) browser.headless = false;
  if (v["no-eager"]) browser.eager = false;
  if (Object.keys(browser).length) out.browser = browser;
  if (v.providers) out.search = { providers: parseProviders(v.providers) };
  if (v["log-level"]) {
    if (!LOG_LEVELS.includes(v["log-level"] as LogLevel)) {
      throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);
    }
    out.logLevel = v["log-level"] as LogLevel;
  }
  return out;
}

function createEngine(config: Config): Engine {
  return new ChromeEngine(config);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command = "serve", ...rest] = positionals;

  // `config` needs no configuration loaded.
  if (command === "config") return printClientConfig(rest[0]);

  const { config, files } = loadConfig({ file: values.config, flags: flagsToConfig(values) });
  setLogLevel(config.logLevel);

  switch (command) {
    case "start":
    case "serve":
    case "mcp": {
      if (values.http !== undefined) {
        throw new NotImplementedError("--http (Streamable HTTP + REST) is not implemented yet; use stdio for now.");
      }
      if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);
      if (process.stdin.isTTY) {
        // A person ran this in a terminal; agents launch it with piped stdio.
        // stderr only: stdout belongs to the MCP protocol.
        process.stderr.write(
          `tiny-browse ${VERSION} MCP server is running on stdio.\n` +
            "Agents normally start tiny-browse themselves, so you don't need to keep this running.\n\n" +
            `${setupGuide()}\nPress Ctrl+C to stop.\n\n`,
        );
      }
      await serveStdio(createEngine(config), config);
      return 0;
    }
    case "init":
      return runInit(config);
    case "search":
      return runSearch(rest.join(" ").trim(), config, values.json ?? false);
    case "fetch":
      return runFetch(rest, config, values.json ?? false);
    case "login":
      await login(config, { signIn: values["sign-in"] ?? false });
      return 0;
    case "doctor":
      return runDoctor(config, files, values.json ?? false);
    case "open":
      return runOpen(rest, config, values.json ?? false);
    default:
      throw new UsageError(`unknown command "${command}". Run tiny-browse --help.`);
  }
}

async function runSearch(query: string, config: Config, json: boolean): Promise<number> {
  if (!query) throw new UsageError("search needs a query, e.g. tiny-browse search \"rust async runtimes\"");
  const engine = createEngine(config);
  try {
    const signal = AbortSignal.timeout(config.callTimeoutMs);
    const result = isHttpUrl(query)
      ? await engine.fetch(
          { urls: [query], maxTokens: config.output.maxTokens, render: "auto", returnImages: false },
          { signal },
        )
      : await engine.search(
          {
            query,
            maxResults: config.search.maxResults,
            read: config.search.read,
            maxTokens: config.output.maxTokens,
            freshness: "any",
            returnImages: false,
          },
          { signal },
        );
    process.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.markdown}\n`);
    return 0;
  } finally {
    await engine.close();
  }
}

async function runFetch(urls: string[], config: Config, json: boolean): Promise<number> {
  if (!urls.length) throw new UsageError("fetch needs at least one URL");
  const bad = urls.find((u) => !isHttpUrl(u));
  if (bad) throw new UsageError(`not an absolute http(s) URL: ${bad}`);
  const engine = createEngine(config);
  try {
    const result = await engine.fetch(
      { urls, maxTokens: 8000, render: "auto", returnImages: false },
      { signal: AbortSignal.timeout(config.callTimeoutMs) },
    );
    process.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.markdown}\n`);
    return 0;
  } finally {
    await engine.close();
  }
}

interface Check {
  name: string;
  ok: boolean | null;
  note?: string;
}

/** Start (or reuse) Chrome and load a tiny page, timing each step. */
async function browserCheck(config: Config): Promise<Check> {
  const browser = new Browser(config.browser);
  try {
    const s = await browser.ensure();
    const nav = await browser.withPage(async (page) => {
      const res = await page.goto("data:text/html,<title>tiny-browse ok</title>", { timeoutMs: 10_000 });
      return { ...res, title: await page.title() };
    });
    const ok = nav.title === "tiny-browse ok";
    const how = s.kind === "launched" ? "started" : s.kind === "shared" ? "reused running" : "attached to";
    return {
      name: "chrome session",
      ok,
      note: `${how} ${s.product} in ${s.startMs} ms, page load ${Math.round(nav.ms)} ms`,
    };
  } catch (err) {
    return { name: "chrome session", ok: false, note: (err as Error).message.split("\n")[0] };
  } finally {
    await browser.close();
  }
}

function discoveryCheck(config: Config): Check {
  if (config.browser.mode === "attach") return { name: "browser", ok: null, note: `attach mode: ${config.browser.cdpUrl}` };
  try {
    const chosen = resolveBrowser(config.browser.path);
    const others = discoverBrowsers().filter((b) => b.path !== chosen.path).map((b) => b.name);
    return {
      name: "browser",
      ok: true,
      note: `${chosen.name} (${chosen.path})${others.length ? `; also found: ${others.join(", ")}` : ""}`,
    };
  } catch (err) {
    return { name: "browser", ok: false, note: (err as Error).message };
  }
}

async function runDoctor(config: Config, files: string[], json: boolean): Promise<number> {
  const discovery = discoveryCheck(config);
  const checks: Check[] = [
    { name: "node >= 22", ok: Number(process.versions.node.split(".")[0]) >= 22 },
    discovery,
    discovery.ok === false ? { name: "chrome session", ok: null, note: "skipped" } : await browserCheck(config),
    { name: "search providers", ok: null, note: "not implemented yet (M2)" },
  ];
  const report = {
    version: VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    configFiles: files,
    profileDir: config.browser.profileDir,
    cacheDir: config.cache.dir,
    checks,
    config,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const mark = (ok: boolean | null) => (ok === null ? "-" : ok ? "ok" : "FAIL");
  const lines = [
    `tiny-browse ${report.version}`,
    `node ${report.node} on ${report.platform}`,
    `config files: ${files.length ? files.join(", ") : "(none, using defaults)"}`,
    `chrome profile: ${report.profileDir}`,
    `cache: ${report.cacheDir}`,
    `search order: ${config.search.providers.join(" -> ")}`,
    `browser: ${config.browser.mode === "attach" ? `attach to ${config.browser.cdpUrl}` : `launch ${config.browser.path || "(auto-detect)"}`}, ${config.browser.headless ? "headless" : "headful"}`,
    "",
    ...report.checks.map((c) => `[${mark(c.ok)}] ${c.name}${c.note ? ` - ${c.note}` : ""}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return report.checks.some((c) => c.ok === false) ? 1 : 0;
}

/** Debug aid: load a URL in headless Chrome and report what happened. */
async function runOpen(args: string[], config: Config, json: boolean): Promise<number> {
  const [url] = args;
  if (!url || !isHttpUrl(url)) throw new UsageError("open needs one absolute http(s) URL");
  const browser = new Browser(config.browser);
  try {
    const s = await browser.ensure();
    const info = await browser.withPage(async (page) => {
      const nav = await page.goto(url, { timeoutMs: config.fetch.timeoutMs * 2 });
      const [title, html] = await Promise.all([page.title(), page.html()]);
      return { ...nav, ms: Math.round(nav.ms), title, htmlBytes: Buffer.byteLength(html) };
    });
    const out = { browser: s.product, session: s.kind, ...info };
    process.stdout.write(
      json
        ? `${JSON.stringify(out, null, 2)}\n`
        : `${out.title || "(no title)"}\n${out.url}\nstatus ${out.status ?? "-"} · ${out.mimeType ?? "-"} · ` +
            `${out.htmlBytes} bytes HTML · ${out.ms} ms${out.timedOut ? " (timed out, partial)" : ""}\n`,
    );
    return 0;
  } finally {
    await browser.close();
  }
}

/** Settings people most often change; everything else stays at its default. */
function starterConfig(c: Config) {
  return {
    browser: { headless: c.browser.headless, onChallenge: c.browser.onChallenge },
    search: { providers: c.search.providers, read: c.search.read },
    output: { maxTokens: c.output.maxTokens },
  };
}

function runInit(config: Config): number {
  const out: string[] = [`tiny-browse ${VERSION} setup`, ""];

  const file = join(configDir(), "config.json");
  if (existsSync(file)) {
    out.push(`config: ${file} (already exists, left unchanged)`);
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(starterConfig(config), null, 2)}\n`);
    out.push(`config: created ${file}`);
  }

  mkdirSync(config.browser.profileDir, { recursive: true });
  const browser = discoveryCheck(config);
  out.push(`browser: ${browser.ok === false ? `NOT FOUND - ${browser.note}` : browser.note}`);
  out.push(`chrome profile: ${config.browser.profileDir}`);
  out.push(`search order: ${config.search.providers.join(" -> ")}`);
  out.push("", "Optional: run `tiny-browse login` once to accept Google's consent screen in this profile.");
  out.push("", setupGuide());
  process.stdout.write(`${out.join("\n")}`);
  return 0;
}

function printClientConfig(client: string | undefined): number {
  const snippet = client ? clientSnippets()[client] : undefined;
  if (!snippet) {
    throw new UsageError(`config needs a client: ${CLIENT_NAMES.join(", ")}`);
  }
  process.stdout.write(formatSnippet(snippet));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`tiny-browse: ${err.message}\n`);
      process.exitCode = 2;
    } else if (err instanceof ConfigError || err instanceof NotImplementedError) {
      process.stderr.write(`tiny-browse: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      log.error("unexpected error", err);
      process.exitCode = 1;
    }
  },
);
