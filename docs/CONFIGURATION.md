# Configuration

tiny-browse works without configuration. Settings are read in this order, later ones winning:

1. Built-in defaults
2. `~/.config/tiny-browse/config.json` (or `$XDG_CONFIG_HOME/tiny-browse/config.json`)
3. `./tiny-browse.config.json` in the current folder
4. A file given with `--config <file>` or `TINY_BROWSE_CONFIG`
5. Environment variables
6. Command-line flags

As a library, pass settings as the `config` option instead. Then no files or `TINY_BROWSE_*` variables are read. See [LIBRARY.md](LIBRARY.md).

## Example

```json
{
  "search": { "providers": ["google", "duckduckgo", "bing"], "read": 3 },
  "output": { "maxTokens": 6000 },
  "fetch": { "allowHosts": ["intranet.example"] },
  "ranking": { "prefer": ["docs.python.org"], "block": ["pinterest.com"] }
}
```

Unknown keys are rejected with an error that names them.

## Settings

### Browser

| Setting | Default | Description |
|---|---|---|
| `browser.path` | auto-detect | Browser executable (Chrome, Chromium, Edge or Brave) |
| `browser.mode` | `launch` | `launch` a browser, `attach` to one at `browser.cdpUrl`, or `off` for no browser at all |
| `browser.cdpUrl` | | Remote debugging address of a running Chrome (`ws://…` or `http://host:port`) |
| `browser.headless` | `true` | Run without a window |
| `browser.eager` | `true` | Start Chrome as soon as the MCP server starts (the library always starts it on first use) |
| `browser.idleTimeoutMs` | `300000` | Stop Chrome after this long unused |
| `browser.onChallenge` | `fallback` | On a CAPTCHA: `fallback` to the next engine, or `show` a window so you can solve it |
| `browser.profileDir` | cache folder | The tiny-browse Chrome profile (never your everyday profile) |

### Search

| Setting | Default | Description |
|---|---|---|
| `search.providers` | `["google", "duckduckgo", "bing"]` | Engines, in order. Later ones are fallbacks |
| `search.maxResults` | `5` | Default `max_results` |
| `search.read` | `3` | Default number of results to read |
| `search.limits` | see below | Per-engine request budgets, e.g. `{ "google": { "perHour": 10 } }` |

Default request budgets, shared by every tiny-browse process on the computer:

| Engine | Gap between requests | Per minute | Per hour | Per day |
|---|---|---|---|---|
| `google` | 8 s + up to 3 s jitter | 3 | 20 | 100 |
| `google-redirect` (following result links) | 0.25 s + jitter | 10 | 60 | 200 |
| `duckduckgo`, `bing` | 3 s + up to 1.5 s jitter | 6 | 60 | 300 |

Each limit can be overridden: `minGapMs`, `jitterMs`, `perMinute`, `perHour`, `perDay`. When a budget is used up, that engine is skipped and the next one is tried. After a CAPTCHA, an engine is paused for 15 minutes, then 1 hour, 4 hours and 24 hours if it happens again.

### Reading pages

| Setting | Default | Description |
|---|---|---|
| `fetch.timeoutMs` | `8000` | Time limit per page |
| `fetch.maxBytes` | `5242880` (5 MB) | Largest page read |
| `fetch.concurrency` | `4` | Pages read at the same time |
| `fetch.allowPrivateNetwork` | `false` | Allow local and private network addresses |
| `fetch.allowHosts` | `[]` | Specific private hosts to allow anyway, as `host` or `host:port` |

### Output

| Setting | Default | Description |
|---|---|---|
| `output.maxTokens` | `6000` | Default `max_tokens` for `web_search` (`web_fetch` defaults to 8000) |
| `output.links` | `reference` | Links as `reference` (`[text][1]` with URLs listed at the end), `inline` or `text` |
| `images.max` | `4` | Most images returned with `return_images` |
| `images.maxBytes` | `1048576` (1 MB) | Largest image returned |

### Ranking

| Setting | Default | Description |
|---|---|---|
| `ranking.prefer` | `[]` | Domains to favour when choosing which results to read |
| `ranking.block` | `[]` | Domains never returned or read |

### Cache and logs

| Setting | Default | Description |
|---|---|---|
| `cache.enabled` | `true` | Cache on disk: pages for `cache.pageTtlMs`, search results for `cache.serpTtlMs` |
| `cache.dir` | OS cache folder | Caches, rate budgets, the Chrome profile and the server port file |
| `cache.pageTtlMs` | `3600000` (1 hour) | |
| `cache.serpTtlMs` | `600000` (10 minutes) | |
| `callTimeoutMs` | `20000` | Time limit for one tool call |
| `logLevel` | `info` | `silent`, `error`, `warn`, `info` or `debug`. The CLI logs to stderr |

The cache folder is `~/Library/Caches/tiny-browse` on macOS, `$XDG_CACHE_HOME/tiny-browse` or `~/.cache/tiny-browse` on Linux, and `%LOCALAPPDATA%\tiny-browse\Cache` on Windows.

## Environment variables

| Variable | Sets |
|---|---|
| `TINY_BROWSE_CHROME` | `browser.path` |
| `TINY_BROWSE_CDP_URL` | `browser.cdpUrl` and `browser.mode: "attach"` |
| `TINY_BROWSE_HEADLESS` | `browser.headless` (`true` / `false`) |
| `TINY_BROWSE_PROVIDERS` | `search.providers`, comma-separated |
| `TINY_BROWSE_LOG_LEVEL` | `logLevel` |
| `TINY_BROWSE_CONFIG` | An extra config file |
| `TINY_BROWSE_TOKEN` | Bearer token for `tiny-browse serve --http` |

## Command-line flags

| Flag | Sets |
|---|---|
| `--config <file>` | An extra config file |
| `--browser-path <path>` | `browser.path` |
| `--cdp-url <url>` | `browser.cdpUrl` and attach mode |
| `--headful` | `browser.headless: false` |
| `--no-eager` | `browser.eager: false` |
| `--no-chrome` | `browser.mode: "off"` |
| `--providers <list>` | `search.providers` |
| `--max-tokens <n>` | `output.maxTokens` |
| `--log-level <level>` | `logLevel` |
