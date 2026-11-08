# Library API

```bash
npm install @shubhamcodess/tiny-browse
```

ESM only, Node.js 22 or later, TypeScript types included. The functions, types and error codes below are the public API; see [Versioning](#versioning).

```ts
import { webSearch, webFetch, createClient, doctor, TinyBrowseError } from "@shubhamcodess/tiny-browse";
```

## Functions

### `webSearch(input, options?)`

Searches and reads the top results. One-shot: everything it started is shut down before it returns.

```ts
const r = await webSearch({ query: "node.js stream backpressure", read: 2, max_tokens: 4000 });
r.results; // [{ rank, title, url, snippet }]
r.pages;   // the pages read: [{ url, finalUrl, title, markdown, tokens, truncated, cursor? }]
r.markdown; // everything as one Markdown document, within max_tokens
```

Returns `SearchResult`:

| Field | Description |
|---|---|
| `query` | The query |
| `provider` | `google`, `duckduckgo` or `bing`: the engine that answered |
| `cached` | True if no engine was contacted |
| `warning` | Set when results may not match the query (a degraded engine) |
| `results` | The result list. Empty when nothing was found; this is not an error |
| `pages` | Pages read from the top results |
| `failed` | Results picked for reading that could not be read: `[{ url, code, message }]` |
| `attempts` | Each engine tried and what happened: `[{ provider, status, note? }]` |
| `markdown` | Everything above as Markdown |
| `images` | With `return_images`: `[{ id, mimeType, data }]` (base64) |

Input is the `web_search` tool's parameters: see [TOOLS.md](TOOLS.md#web_search).

### `webFetch(input, options?)`

Reads pages. Returns `FetchResult`: `{ pages, failed, markdown, images }`. Throws if no page could be read; partial failures are listed in `failed`.

```ts
const { pages } = await webFetch({ urls: ["https://go.dev/doc/effective_go"], focus: "goroutines" });
const next = pages[0].cursor ? await webFetch({ cursor: pages[0].cursor }) : undefined;
```

Input is the `web_fetch` tool's parameters: see [TOOLS.md](TOOLS.md#web_fetch).

### `createClient(options?)`

A client reuses one Chrome across calls. Always close it.

```ts
const client = await createClient({ timeoutMs: 15_000 });
try {
  const a = await client.webSearch({ query: "..." });
  const b = await client.webFetch({ urls: ["https://..."] }, { signal: AbortSignal.timeout(5000) });
} finally {
  await client.close();
}
```

`client.webSearch(input, { signal?, timeoutMs? })`, `client.webFetch(input, { signal?, timeoutMs? })`, `client.close()`. Calls after `close()` throw `invalid_input`.

### `doctor(options?)`

Checks Node, the browser, a test Chrome start and the search budgets. Returns `[{ name, ok, detail }]`. Pass `{ startChrome: false }` to skip starting Chrome.

## Options

All optional, for the functions above and `createClient`.

| Option | Description |
|---|---|
| `signal` | `AbortSignal` that cancels calls |
| `timeoutMs` | Time limit per call (default 20000) |
| `mode` | `"chrome"` (default) or `"http"`: no Chrome at all. Faster start; Google is skipped and pages that need JavaScript come back thin |
| `useServer` | `"auto"`: send calls to a running `tiny-browse serve --http` (found through the cache folder) and use its warm Chrome; otherwise run in-process. Default `"never"` |
| `config` | Settings object, as in [CONFIGURATION.md](CONFIGURATION.md). When given, no config files or `TINY_BROWSE_*` variables are read |
| `cacheDir` | Folder for caches, rate budgets and the Chrome profile |
| `chromePath` | Browser executable |
| `cdpUrl` | Use an already running Chrome (`ws://…` or `http://host:port`) |
| `logger` | Object with any of `error`, `warn`, `info`, `debug(message, extra?)`. Default: silent |
| `logLevel` | Lowest level passed to `logger` (default `info`) |

## Errors

Every error is a `TinyBrowseError` with a `code`:

| Code | Meaning |
|---|---|
| `chrome_not_found` | No usable browser, or it would not start |
| `timeout` | The call exceeded `timeoutMs` |
| `blocked` | A CAPTCHA, bot check or rate budget stopped the request |
| `network` | DNS, connection or HTTP failure |
| `private_address` | The URL points at this computer or a private network |
| `aborted` | The `signal` fired |
| `invalid_input` | Invalid input or options; the message says what to fix |

```ts
try {
  await webSearch({ query: "..." });
} catch (err) {
  if (err instanceof TinyBrowseError && err.code === "blocked") {
    // every engine refused: try again later
  } else throw err;
}
```

## Lifecycle

- Importing has no side effects: no files, no Chrome, no output.
- Nothing starts until the first call. The Chrome profile is created then.
- After a one-shot call or `close()` nothing is left running, so a short-lived CLI exits immediately.
- Chrome is stopped if your process exits, or is interrupted (SIGINT, SIGTERM, SIGHUP) without handling the signal itself.
- The library never writes to stdout or stderr.

## Versioning

The package follows semantic versioning. Before 1.0, breaking changes bump the minor version (0.1 → 0.2); new error codes and optional result fields may be added in any release. Changes are listed in the [changelog](../CHANGELOG.md).
