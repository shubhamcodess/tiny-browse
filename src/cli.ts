import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIENT_NAMES, clientSnippets, formatSnippet, setupGuide } from "./clients.js";
import { runChecks } from "./core/doctor.js";
import { removeServerFile, writeServerFile } from "./server-file.js";
import { ConfigError, loadConfig, parseProviders, type Config, type ConfigInput } from "./config.js";
import { configDir } from "./util/paths.js";
import { Browser } from "./browser/browser.js";
import { login } from "./browser/login.js";
import { ChromeEngine } from "./core/chrome-engine.js";
import { NotImplementedError, type Engine } from "./core/engine.js";
import { SearchUnavailableError } from "./search/search.js";
import { serveHttp, ServeError } from "./http/server.js";
import { serveStdio } from "./mcp/stdio.js";
import { isHttpUrl } from "./mcp/schema.js";
import { LOG_LEVELS, log, setLogger, setLogLevel, stderrLogger, type LogLevel } from "./util/log.js";
import { VERSION } from "./version.js";

const HELP = `tiny-browse ${VERSION} - web search and page reading for AI agents, over MCP

Usage:
  tiny-browse mcp                 Start the MCP server on stdio (this is what agents run)
  tiny-browse serve --http PORT   MCP over HTTP at /mcp plus a JSON API (/search, /fetch);
                                  keeps Chrome warm for agents and library callers
                                  [--host 127.0.0.1] [--token SECRET]
  tiny-browse init                First-time setup and the snippet to paste into your agent
  tiny-browse search <query...>   Search and print Markdown (or --json)
  tiny-browse fetch <url...>      Read pages and print Markdown (or --json)
  tiny-browse login [--sign-in]   Open Chrome on the tiny-browse profile to accept
                                  Google's consent screen (and optionally sign in)
  tiny-browse doctor              Show version and config; find and test Chrome
  tiny-browse open <url>          Debug: load a URL in headless Chrome, show status/timing
  tiny-browse config <client>     Print MCP setup for a client:
                                  ${CLIENT_NAMES.join(", ")}
  tiny-browse                     In a terminal: this help. Launched by an agent
                                  (stdin not a terminal): same as \`mcp\`

Options:
  --config <file>        Extra config file (JSON)
  --browser-path <path>  Chrome/Chromium/Edge/Brave executable to use
  --cdp-url <url>        Attach to an already running Chrome (remote debugging)
  --headful              Show the Chrome window instead of running headless
  --no-eager             Start Chrome only when first needed
  --no-chrome            Plain HTTP only: no Chrome (faster start, lower coverage)
  --providers <list>     Search order, e.g. google,duckduckgo,bing
  --log-level <level>    ${LOG_LEVELS.join(" | ")} (logs go to stderr)
  --max-tokens <n>       search/fetch: hard limit on the size of the answer
  --focus <question>     fetch: return the sections most relevant to this
  --cursor <cursor>      fetch: continue a page from a previous result
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
  "no-chrome": { type: "boolean" },
  providers: { type: "string" },
  "log-level": { type: "string" },
  json: { type: "boolean" },
  "max-tokens": { type: "string" },
  focus: { type: "string" },
  cursor: { type: "string" },
  http: { type: "string" },
  "sign-in": { type: "boolean" },
  host: { type: "string" },
  token: { type: "string" },
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
  if (v["max-tokens"] !== undefined) {
    const n = Number(v["max-tokens"]);
    if (!Number.isInteger(n) || n < 200) throw new UsageError("--max-tokens must be a whole number of at least 200");
    out.output = { maxTokens: n };
  }
  if (v["no-eager"]) browser.eager = false;
  if (v["no-chrome"]) browser.mode = "off";
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
  // The CLI logs to stderr (stdout belongs to MCP and to printed results).
  setLogger(stderrLogger);
  const { values, positionals } = parse(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Bare `tiny-browse`: agents launch it with piped stdio and get the MCP
  // server (so configs that omit `mcp` still work); a person at a
  // terminal gets help instead of a process silently waiting on stdin.
  if (!positionals.length && values.http === undefined && process.stdin.isTTY) {
    process.stdout.write(`${HELP}\n${setupGuide()}`);
    return 0;
  }
  const [command = "mcp", ...rest] = positionals;

  // `config` needs no configuration loaded.
  if (command === "config") return printClientConfig(rest[0]);

  const { config, files } = loadConfig({ file: values.config, flags: flagsToConfig(values) });
  setLogLevel(config.logLevel);

  switch (command) {
    case "start":
    case "serve":
    case "mcp": {
      if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);
      if (values.http !== undefined) return runHttp(config, values);
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
      return runFetch(rest, config, values.json ?? false, { focus: values.focus, cursor: values.cursor });
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

async function runFetch(urls: string[], config: Config, json: boolean, extra: { focus?: string; cursor?: string } = {}): Promise<number> {
  if (!urls.length && !extra.cursor) throw new UsageError("fetch needs at least one URL (or --cursor)");
  const bad = urls.find((u) => !isHttpUrl(u));
  if (bad) throw new UsageError(`not an absolute http(s) URL: ${bad}`);
  const engine = createEngine(config);
  try {
    const result = await engine.fetch(
      { urls, maxTokens: config.output.maxTokens, render: "auto", returnImages: false, focus: extra.focus, cursor: extra.cursor },
      { signal: AbortSignal.timeout(config.callTimeoutMs) },
    );
    process.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.markdown}\n`);
    return 0;
  } finally {
    await engine.close();
  }
}

async function runDoctor(config: Config, files: string[], json: boolean): Promise<number> {
  const checks = await runChecks(config);
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
    ...report.checks.map((c) => `[${mark(c.ok)}] ${c.name}${c.detail ? ` - ${c.detail}` : ""}`),
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

async function runInit(config: Config): Promise<number> {
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
  const browser = (await runChecks(config, { startChrome: false })).find((c) => c.name === "browser")!;
  out.push(`browser: ${browser.ok === false ? `NOT FOUND - ${browser.detail}` : browser.detail}`);
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
    } else if (err instanceof ConfigError || err instanceof NotImplementedError || err instanceof SearchUnavailableError) {
      process.stderr.write(`tiny-browse: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      log.error("unexpected error", err);
      process.exitCode = 1;
    }
  },
);

async function runHttp(config: Config, values: Values): Promise<number> {
  const port = Number(values.http);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--http needs a port number, e.g. --http 7777");
  const host = values.host ?? "127.0.0.1";
  const token = values.token ?? process.env.TINY_BROWSE_TOKEN;
  const engine = createEngine(config);
  let server;
  try {
    server = await serveHttp(engine, config, { port, host, token });
  } catch (err) {
    await engine.close();
    if (err instanceof ServeError) throw new UsageError(err.message);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new UsageError(`port ${port} is already in use on ${host} (another tiny-browse serve?). Stop it or pick another port.`);
    }
    throw err;
  }
  engine.start();
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${actual}`;
  // Announce the server to library clients (useServer: "auto"), loopback only.
  const announce = config.cache.enabled && /^(127\.0\.0\.1|::1|localhost)$/.test(host);
  if (announce) writeServerFile(config.cache.dir, { url: base, pid: process.pid, version: VERSION, token });
  process.stderr.write(
    `tiny-browse ${VERSION} listening on ${base}\n` +
      `  MCP (Streamable HTTP): ${base}/mcp\n` +
      `  JSON API:              POST ${base}/search, POST ${base}/fetch, GET ${base}/health\n\n` +
      `Claude Code: claude mcp add --transport http tiny-browse ${base}/mcp${token ? ` --header "Authorization: Bearer <token>"` : ""}\n` +
      "Press Ctrl+C to stop.\n",
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  if (announce) removeServerFile(config.cache.dir);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await engine.close();
  return 0;
}
