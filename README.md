# tiny-browse

Web search and page reading for AI agents. An MCP server and a Node.js library
that searches Google in the Chrome already on your computer, reads the best
results and returns clean, heading-structured Markdown within a token budget.

[![npm](https://img.shields.io/npm/v/tiny-browse)](https://www.npmjs.com/package/tiny-browse)
[![CI](https://github.com/shubhamcodess/tiny-browse/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamcodess/tiny-browse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/shubhamcodess/tiny-browse/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/tiny-browse)](https://nodejs.org)

- **Works with any agent or model.** No LLM inside. Speaks MCP over stdio and HTTP, plus a plain JSON API.
- **No bundled browser.** Drives your installed Chrome, Edge, Brave or Chromium. Zero runtime dependencies; the package is about 130 kB.
- **Clean Markdown.** Main content only, with headings, code blocks, tables and lists kept; menus, ads and cookie banners removed.
- **Token-aware.** `max_tokens` is a hard limit. Long pages can be narrowed to the sections relevant to a question, or continued with a cursor.
- **Fast.** Pages are read over plain HTTP when that works (typically 0.2–1 s) and in Chrome when they need JavaScript.
- **Careful by default.** Strict request budgets for search engines, no CAPTCHA solving, no access to local or private networks, pages read without your cookies.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Connect an agent](#connect-an-agent)
- [Tools](#tools)
- [Use as a library](#use-as-a-library)
- [Command line](#command-line)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js 22 or later
- Google Chrome, Chromium, Microsoft Edge or Brave, installed normally. Not needed for the no-Chrome mode (`--no-chrome` / `mode: "http"`).
- macOS or Linux. Windows is expected to work but is not tested yet.

## Install

Agents can run tiny-browse with `npx` without installing it (see below). To install it:

```bash
npm install -g tiny-browse   # the tiny-browse command
npm install tiny-browse      # as a library in your project
```

Check your setup:

```bash
tiny-browse doctor
```

## Connect an agent

Agents start tiny-browse themselves with `npx -y tiny-browse mcp`. `tiny-browse config <client>` prints the exact snippet for a client.

**Claude Code**

```bash
claude mcp add tiny-browse -- npx -y tiny-browse mcp
```

**VS Code (GitHub Copilot)**: `.vscode/mcp.json`

```json
{
  "servers": {
    "tiny-browse": { "type": "stdio", "command": "npx", "args": ["-y", "tiny-browse", "mcp"] }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`), **Claude Desktop** (`claude_desktop_config.json`) and most other clients:

```json
{
  "mcpServers": {
    "tiny-browse": { "command": "npx", "args": ["-y", "tiny-browse", "mcp"] }
  }
}
```

**Codex CLI**: `~/.codex/config.toml`

```toml
[mcp_servers.tiny-browse]
command = "npx"
args = ["-y", "tiny-browse", "mcp"]
```

### Shared HTTP server

To keep one warm Chrome for several agents and library callers, run a server and point clients at it:

```bash
tiny-browse serve --http 7777
```

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP, e.g. `{ "type": "http", "url": "http://127.0.0.1:7777/mcp" }` |
| `POST /search`, `POST /fetch` | JSON API: tool arguments in, `{ markdown, data, images }` out |
| `GET /health` | Health check |

The server listens on `127.0.0.1` and rejects requests from web pages (Origin check). To listen on another address you must set a token (`--token` or `TINY_BROWSE_TOKEN`), which clients send as `Authorization: Bearer <token>`.

## Tools

### `web_search`

Searches the web and reads the best results. Google comes first; DuckDuckGo and Bing are fallbacks.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Plain words. Google operators such as `site:` and `"quotes"` work. |
| `max_results` | 1–10 | 5 | Results to consider |
| `read` | 0–10 | 3 | Top results to open and read; 0 returns only the result list |
| `max_tokens` | 200–200000 | 6000 | Hard limit on the whole answer |
| `site` | string | | Only results from this domain |
| `freshness` | `any` `day` `week` `month` `year` | `any` | Only recent results |
| `return_images` | boolean | false | Also return the main images of the pages read |

### `web_fetch`

Reads pages by URL.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `urls` | string[] (1–10) | | Absolute http(s) URLs |
| `max_tokens` | 200–200000 | 8000 | Hard limit on the whole answer |
| `focus` | string | | Return only the sections most relevant to this question |
| `cursor` | string | | Continue a page that was cut short (from a previous result) |
| `render` | `auto` `http` `browser` | `auto` | `auto` uses the fastest way that works |
| `return_images` | boolean | false | Also return the pages' main images |

Give `urls` or `cursor`. Page content in the output is marked as untrusted, so agents can tell it apart from instructions.

## Use as a library

```ts
import { webSearch, webFetch, createClient, TinyBrowseError } from "tiny-browse";

// One-shot calls start what they need and shut everything down before returning.
const result = await webSearch({ query: "node.js stream backpressure", read: 2, max_tokens: 4000 });
for (const hit of result.results) console.log(hit.rank, hit.title, hit.url);
console.log(result.pages[0]?.markdown); // one page as Markdown
console.log(result.markdown);           // everything, ready for an LLM

const docs = await webFetch({ urls: ["https://go.dev/doc/effective_go"], focus: "goroutines" });

// For several calls, a client reuses one Chrome. Always close it.
const client = await createClient({ timeoutMs: 15_000 });
try {
  await client.webSearch({ query: "..." });
} finally {
  await client.close();
}
```

Inputs are the tools' parameters above (`WebSearchInput`, `WebFetchInput`). TypeScript types are included.

| Function | Returns |
|---|---|
| `webSearch(input, options?)` | `{ query, provider, cached, warning?, results, pages, failed, attempts, markdown, images }` |
| `webFetch(input, options?)` | `{ pages, failed, markdown, images }` |
| `createClient(options?)` | `{ webSearch, webFetch, close }`; methods also accept `{ signal, timeoutMs }` |
| `doctor(options?)` | `[{ name, ok, detail }]` |

A result is `{ rank, title, url, snippet }`; a page is `{ url, finalUrl, title, markdown, tokens, truncated, cursor? }`; a failure is `{ url, code, message }`. No search results is an empty list, not an error. `webFetch` throws only if no page could be read.

### Options

| Option | Description |
|---|---|
| `signal` | `AbortSignal` that cancels calls |
| `timeoutMs` | Deadline per call (default 20000) |
| `mode` | `"chrome"` (default), or `"http"` for no Chrome: faster start, Google skipped, pages that need JavaScript come back thin |
| `useServer` | `"auto"` uses a running `tiny-browse serve --http` and its warm Chrome; `"never"` (default) runs in-process |
| `config` | Settings object (see [Configuration](#configuration)). When given, no config files or `TINY_BROWSE_*` variables are read |
| `cacheDir` | Folder for caches, rate budgets and the Chrome profile |
| `chromePath`, `cdpUrl` | A specific browser executable, or an already running Chrome |
| `logger`, `logLevel` | Receive log messages. The library is silent by default and never writes to stdout or stderr |

### Errors

Errors are `TinyBrowseError` with a `code`:

| Code | Meaning |
|---|---|
| `chrome_not_found` | No usable browser, or it would not start |
| `timeout` | The call exceeded `timeoutMs` |
| `blocked` | A CAPTCHA, bot check or rate budget stopped the request |
| `network` | DNS, connection or HTTP failure |
| `private_address` | The URL points at this computer or a private network |
| `aborted` | The `signal` fired |
| `invalid_input` | Invalid input or options; the message says what to fix |

### Lifecycle

Importing has no side effects. Nothing starts until the first call. After a one-shot call or `close()`, nothing is left running, so a CLI exits immediately. Chrome is also stopped if your process exits or is interrupted. `close()` can be called more than once.

## Command line

| Command | Description |
|---|---|
| `tiny-browse mcp` | MCP server on stdio (what agents run) |
| `tiny-browse serve --http PORT` | MCP over HTTP plus the JSON API |
| `tiny-browse search <query>` | Search and print Markdown |
| `tiny-browse fetch <url...>` | Read pages and print Markdown |
| `tiny-browse doctor` | Check Node, the browser and search budgets |
| `tiny-browse login [--sign-in]` | Open Chrome on the tiny-browse profile to accept Google's consent screen (optionally sign in) |
| `tiny-browse init` | Create a config file and print the agent snippet |
| `tiny-browse config <client>` | Print setup for `claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex` or `generic` |

Common options: `--json`, `--max-tokens <n>`, `--focus <question>`, `--cursor <cursor>`, `--no-chrome`, `--browser-path <path>`, `--cdp-url <url>`, `--headful`, `--providers <list>`, `--log-level <level>`, `--config <file>`. See `tiny-browse --help`.

Run without a command in a terminal, `tiny-browse` prints help. Started by an agent, it runs the MCP server.

## Configuration

Settings are read in this order, later ones winning: defaults, `~/.config/tiny-browse/config.json`, `./tiny-browse.config.json`, `--config <file>`, environment variables, command-line flags.

```json
{
  "search": { "providers": ["google", "duckduckgo", "bing"], "read": 3 },
  "output": { "maxTokens": 6000 },
  "fetch": { "allowHosts": ["intranet.example"] }
}
```

| Setting | Default | Description |
|---|---|---|
| `browser.path` | auto-detect | Browser executable |
| `browser.mode` | `launch` | `launch`, `attach` (to `browser.cdpUrl`) or `off` (no Chrome) |
| `browser.headless` | `true` | Run Chrome without a window |
| `browser.onChallenge` | `fallback` | On a CAPTCHA: use the next engine, or `show` a window so you can solve it |
| `browser.idleTimeoutMs` | 300000 | Stop Chrome after this long unused |
| `search.providers` | `google, duckduckgo, bing` | Engines, in order |
| `search.limits` | see below | Per-engine request budgets, e.g. `{ "google": { "perHour": 10 } }` |
| `fetch.timeoutMs` | 8000 | Per page |
| `fetch.maxBytes` | 5 MB | Largest page read |
| `fetch.allowPrivateNetwork` | `false` | Allow local and private addresses |
| `fetch.allowHosts` | `[]` | Specific private hosts to allow (`host` or `host:port`) |
| `output.maxTokens` | 6000 | Default `max_tokens` for search |
| `output.links` | `reference` | `reference`, `inline` or `text` |
| `ranking.prefer`, `ranking.block` | `[]` | Domains to favour or never read |
| `cache.enabled` | `true` | Cache pages (1 hour) and search results (10 minutes) on disk |

Default search budgets per engine, shared by every tiny-browse process on the computer:

| Engine | Gap between requests | Per minute | Per hour | Per day |
|---|---|---|---|---|
| Google | 8 s + jitter | 3 | 20 | 100 |
| DuckDuckGo, Bing | 3 s + jitter | 6 | 60 | 300 |

When a budget is used up the engine is skipped and the next one is tried. After a CAPTCHA an engine is paused for 15 minutes, then 1 hour, 4 hours and 24 hours if it repeats.

Environment variables: `TINY_BROWSE_CHROME`, `TINY_BROWSE_CDP_URL`, `TINY_BROWSE_HEADLESS`, `TINY_BROWSE_PROVIDERS`, `TINY_BROWSE_LOG_LEVEL`, `TINY_BROWSE_CONFIG`, `TINY_BROWSE_TOKEN`.

## How it works

1. **Search.** The results page is read three independent ways (visual layout, the accessibility tree, a selector table) and the results are merged by vote, so a redesign of the results page rarely breaks parsing. Health checks catch CAPTCHAs, consent walls and off-topic results.
2. **Read.** Each page is fetched over plain HTTP and rendered in a Chrome tab with scripts off; if that looks thin, a full Chrome load takes over. Which way works is remembered per site.
3. **Extract.** The main content is chosen by prose density and layout, not class names. Headings, code, tables, lists and quotes are kept; hidden text and boilerplate are dropped.
4. **Fit.** Pages are split into heading-aware sections and packed into the token budget, ranked by relevance (BM25) when a focus or query is given. Tokens are counted with a built-in, model-agnostic estimator.

Design notes: [docs/DESIGN.md](https://github.com/shubhamcodess/tiny-browse/blob/main/docs/DESIGN.md).

## Security and privacy

- Local and private network addresses are refused, including redirects to them and requests made by pages inside Chrome.
- Pages are read in a separate browser context without cookies. Only the search engines use the tiny-browse Chrome profile.
- tiny-browse uses its own Chrome profile, never your everyday one.
- Hidden page text is removed and page content is marked as untrusted, to limit prompt injection.
- CAPTCHAs are never solved automatically and bot detection is not evaded.
- Queries and pages are cached under your user's cache folder; set `cache.enabled: false` to turn this off.

Report vulnerabilities as described in [SECURITY.md](https://github.com/shubhamcodess/tiny-browse/blob/main/SECURITY.md).

## Limitations

- Search engines may block automated browsers, depending on your network. Running `tiny-browse login` once usually helps with Google. Reading pages is not affected.
- Some sites refuse automated access with a bot check; this is reported, not bypassed.
- No PDF support yet.
- tiny-browse is pre-1.0: breaking changes bump the minor version (0.1 → 0.2). See the [changelog](https://github.com/shubhamcodess/tiny-browse/blob/main/CHANGELOG.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| `chrome_not_found` or "No Chrome … found" | Install Chrome, or set `--browser-path` / `TINY_BROWSE_CHROME` |
| Google keeps showing CAPTCHAs | Run `tiny-browse login`; searches fall back to other engines meanwhile. `tiny-browse doctor` shows budgets and pauses |
| Chrome fails to start on Ubuntu 24.04 | Allow the user namespaces its sandbox needs: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` |
| "port … is already in use" | Another `tiny-browse serve` is running; stop it or pick another port |
| A page comes back thin | Try `render: "browser"`; the site may need JavaScript or block automation |

## Contributing

See [CONTRIBUTING.md](https://github.com/shubhamcodess/tiny-browse/blob/main/CONTRIBUTING.md). This project follows a [Code of Conduct](https://github.com/shubhamcodess/tiny-browse/blob/main/CODE_OF_CONDUCT.md).

## License

[MIT](https://github.com/shubhamcodess/tiny-browse/blob/main/LICENSE)
