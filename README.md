# tiny-browse

Tiny, fast, model-agnostic web search and page reading for AI agents, served
over [MCP](https://modelcontextprotocol.io) and usable as a library. It searches Google in the Chrome
already installed on your computer (falling back to DuckDuckGo or Bing), reads
the best results, and returns clean, heading-structured Markdown. No bundled
browser, no LLM inside.

> **Status: early development (0.1).** `web_search` finds results on
> Google (falling back to DuckDuckGo and Bing) and reads the top pages;
> `web_fetch` reads any URL. Pages come back as clean, heading-structured
> Markdown, usually via a fast plain-HTTP path with a full Chrome load when a
> page needs JavaScript. Local and private-network addresses are refused unless
> `fetch.allowPrivateNetwork` is set. `max_tokens` is a hard limit on every
> answer (counted with a built-in model-agnostic tokenizer); long pages can be
> narrowed with `focus` or continued with `cursor`. Google is queried within a
> strict request budget; results and pages are cached on disk. `return_images`
> returns image bytes for vision models. `serve --http PORT` adds MCP over HTTP
> and a JSON API. Not yet: PDFs, web UI (v0.2).
> Search engines often block automated browsers; see
> [docs/DESIGN.md §10a](docs/DESIGN.md). Plan: [docs/DESIGN.md](docs/DESIGN.md).

## Use with an agent

```bash
npx tiny-browse init
```

`init` creates the config file and Chrome profile, then prints the snippet to
paste into your agent. For Claude Code that is:

```bash
claude mcp add tiny-browse -- npx -y tiny-browse mcp
```

For other clients, print the snippet: `tiny-browse config <client>` where
client is `claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex` or `generic`.
When run from a source checkout, the snippets point at that checkout's
`dist/cli.js` instead of `npx`.

Agents start the server themselves (`tiny-browse mcp`). Running plain
`tiny-browse` in a terminal shows help and the snippet; launched by an agent it
serves MCP, so older `npx -y tiny-browse` configs keep working. For a warm
Chrome shared by several agents and library callers, keep
`tiny-browse serve --http 7777` running.

## Tools

- **web_search** `{ query, max_results?, read?, max_tokens?, site?, freshness?, return_images? }`
- **web_fetch** `{ urls, max_tokens?, focus?, cursor?, render?, return_images? }`

## CLI

```
tiny-browse mcp                 MCP server on stdio (what agents run)
tiny-browse serve --http PORT   MCP over HTTP + JSON API, warm Chrome
tiny-browse init                first-time setup + agent snippet
tiny-browse search <query>      print Markdown results
tiny-browse fetch <url...>      print a page as Markdown
tiny-browse login [--sign-in]   accept Google consent in the tiny-browse Chrome profile
tiny-browse doctor              environment checks, finds and test-starts Chrome
tiny-browse open <url>          debug: load a URL in headless Chrome
tiny-browse config <client>     MCP setup snippet
```

Run `tiny-browse --help` for all options. `--no-chrome` runs without Chrome.

## Use as a library

```bash
npm install tiny-browse
```

```ts
import { webSearch, webFetch, createClient, TinyBrowseError } from "tiny-browse";

// One-shot: starts what it needs, shuts everything down before returning.
const r = await webSearch({ query: "node.js stream backpressure", read: 2, max_tokens: 4000 });
for (const hit of r.results) console.log(hit.rank, hit.title, hit.url);
console.log(r.pages[0]?.markdown); // clean Markdown of the best page
console.log(r.markdown);           // everything, ready to hand to an LLM

const page = await webFetch({ urls: ["https://go.dev/doc/effective_go"], focus: "goroutines" });

// Several calls: one client reuses one Chrome. Always close it.
const client = await createClient({ timeoutMs: 15_000 });
try {
  await client.webSearch({ query: "..." });
  await client.webFetch({ urls: ["https://..."] });
} finally {
  await client.close();
}
```

Inputs are exactly the MCP tools' parameters (`WebSearchInput`, `WebFetchInput`).
Results are structured:

- `webSearch` → `{ query, provider, cached, warning?, results: [{ rank, title, url, snippet }], pages: [{ url, finalUrl, title, markdown, tokens, truncated, cursor? }], failed: [{ url, code, message }], attempts, markdown, images }`
- `webFetch` → `{ pages, failed, markdown, images }`. Throws if no page could be read; partial failures are listed in `failed`.
- `doctor()` → `[{ name, ok, detail }]`

No results is an empty `results` list, not an error.

**Options** (`ClientOptions`, all optional):

| Option | Meaning |
|---|---|
| `signal` | `AbortSignal` that cancels the call |
| `timeoutMs` | Deadline per call (default 20000) |
| `mode` | `"chrome"` (default) or `"http"`: no Chrome at all, faster start, Google skipped, pages that need JavaScript come back thin |
| `useServer` | `"auto"`: use a running `tiny-browse serve --http` (found via the cache folder) and its warm Chrome; else run in-process. Default `"never"` |
| `config` | Settings object (same shape as the config file). When given, no config files or `TINY_BROWSE_*` variables are read |
| `cacheDir` | Folder for caches, rate budgets and the Chrome profile |
| `chromePath` / `cdpUrl` | Use a specific browser executable, or an already running Chrome |
| `logger`, `logLevel` | Receive log messages. Default: silent. tiny-browse never writes to stdout or stderr as a library |

**Errors** are `TinyBrowseError` with a `code`: `chrome_not_found`, `timeout`,
`blocked` (CAPTCHA, bot check or rate budget), `network`, `private_address`,
`aborted`, `invalid_input`.

**Lifecycle.** Importing has no side effects: no files, no Chrome, no output.
Nothing starts until the first call; the Chrome profile is created then. After
a one-shot call, or `close()`, nothing is left running, so a CLI's process
exits immediately. Chrome is also killed if your process exits or is stopped
with Ctrl+C or `kill` mid-call. `close()` can be called more than once.

**Versioning.** The exported functions, types and error codes follow semver:
breaking changes only in a new major version; new error codes and optional
fields may be added in minor versions.

## Configuration

Precedence: defaults ← `~/.config/tiny-browse/config.json` ←
`./tiny-browse.config.json` ← `--config <file>` ← `TINY_BROWSE_*` env ← flags.

```json
{
  "browser": { "headless": true, "onChallenge": "fallback" },
  "search": { "providers": ["google", "duckduckgo", "bing"], "read": 3 },
  "output": { "maxTokens": 6000 }
}
```

Environment: `TINY_BROWSE_CHROME`, `TINY_BROWSE_CDP_URL`, `TINY_BROWSE_HEADLESS`,
`TINY_BROWSE_PROVIDERS`, `TINY_BROWSE_LOG_LEVEL`, `TINY_BROWSE_CONFIG`.

## Development

```bash
npm install
npm run check   # typecheck + build + tests
```

Requires Node 22+.
