# Errors and how to handle them

Every error the library throws is a `TinyBrowseError` with a stable `code`. Switch on `code`, not on the message: codes are only ever added, never renamed, while messages may change in any release.

```ts
import { webSearch, TinyBrowseError, type TinyBrowseErrorCode } from "@shubhamcodess/tiny-browse";
```

## Not errors

Three outcomes look like failures but are normal results. Check for them before reaching for `catch`:

- **No results.** `webSearch` returns `results: []` when nothing was found. That is an answer, not an exception.
- **Some pages failed.** `webSearch` and `webFetch` list pages that could not be read in `failed`: `[{ url, code, message }]`, using the same codes as below. The pages that worked are in `pages`. `webFetch` throws only when no page at all could be read, with the first failure's code.
- **Degraded results.** `warning` is set when an engine may be serving results that don't match the query. `attempts` shows each engine tried and what happened.

```ts
const r = await webSearch({ query: "node.js stream backpressure", read: 3 });
if (!r.results.length) return "nothing found";
if (r.warning) log.warn(r.warning);
for (const f of r.failed) log.info(`skipped ${f.url}: ${f.code}`);
```

## The codes

| Code | When it happens | What to do |
|---|---|---|
| `chrome_not_found` | No Chrome, Chromium, Edge or Brave was found, or it would not start | Install one, pass `chromePath`, or retry with `mode: "http"` |
| `timeout` | The call took longer than `timeoutMs` (default 20 s) | Retry once, with a larger `timeoutMs` or a smaller `read` |
| `blocked` | A CAPTCHA, bot check, consent page or rate budget stopped the request | Do not retry in a loop. Try again later; `tiny-browse login` helps with Google |
| `network` | DNS, connection or HTTP failure | Retry once after a short wait |
| `private_address` | The URL points at this computer or a private network | Don't retry. Allow the host with `fetch.allowHosts` if it is intended |
| `aborted` | Your `signal` fired | Nothing: you cancelled it |
| `invalid_input` | Bad input or options, or a call on a closed client. The message says what to fix | Fix the call. Retrying will fail the same way |

## A handler for every code

```ts
async function search(query: string) {
  try {
    return await webSearch({ query, read: 2, max_tokens: 4000 });
  } catch (err) {
    if (!(err instanceof TinyBrowseError)) throw err;
    switch (err.code) {
      case "chrome_not_found":
        // no browser: plain HTTP still works (Google is skipped)
        return webSearch({ query, read: 2 }, { mode: "http" });
      case "timeout":
      case "network":
        // transient: one retry after a pause
        await new Promise((r) => setTimeout(r, 2000));
        return webSearch({ query, read: 2 }, { timeoutMs: 40_000 });
      case "blocked":
        // every engine refused or is over budget: tell the user, don't hammer
        return null;
      case "aborted":
        return null;
      case "private_address":
      case "invalid_input":
      default:
        throw err;
    }
  }
}
```

## Never retry `blocked` in a loop

`blocked` means an engine asked for a CAPTCHA or its request budget is used up. tiny-browse already moved on to the next engine before throwing, so a `blocked` error means every engine refused. Retrying straight away only extends the pause: after each CAPTCHA an engine is paused for 15 minutes, then 1 hour, 4 hours and 24 hours.

A pattern that works, used by [whatcmd](https://github.com/shubhamcodess/whatcmd): after a `blocked` error, stop searching in your own code for 15 minutes, and keep reading known URLs with `webFetch`, which is not rate-limited the same way.

```ts
let pausedUntil = 0;

async function lookUp(query: string) {
  if (Date.now() < pausedUntil) return null;
  try {
    return await webSearch({ query, read: 2 });
  } catch (err) {
    if (err instanceof TinyBrowseError && err.code === "blocked") {
      pausedUntil = Date.now() + 15 * 60_000;
      return null;
    }
    throw err;
  }
}
```

`tiny-browse doctor` (or `doctor()` in code) shows each engine's budget and any pause.

## Timeouts and cancelling

`timeoutMs` limits one call as a whole (default 20000 ms). Pass a `signal` to cancel from outside; the call rejects with `aborted`. Both can be set per call, and on `createClient()` for every call:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

try {
  await webFetch({ urls: ["https://example.com/slow"] }, { signal: controller.signal });
} catch (err) {
  if (err instanceof TinyBrowseError && err.code === "aborted") console.log("cancelled");
}
```

## Clients

A client created with `createClient()` must be closed. Calls after `close()` throw `invalid_input`. Use `try` / `finally`:

```ts
const client = await createClient();
try {
  await client.webSearch({ query: "..." });
} finally {
  await client.close();
}
```

If your process exits or is interrupted (SIGINT, SIGTERM, SIGHUP) without handling the signal itself, Chrome is stopped for you.

## Thin pages

A page that comes back short is not an error. The site may need JavaScript, or block automated browsers. Read it again with `render: "browser"` to force a full Chrome load:

```ts
const r = await webFetch({ urls: [url] });
if (r.pages[0].tokens < 100) await webFetch({ urls: [url], render: "browser" });
```

Sites that refuse automated access with a bot check are reported as `blocked`, never bypassed.

## Errors over MCP and HTTP

- **MCP.** A failed tool call returns a normal tool result with `isError: true` and the message as text, so the agent sees what went wrong and can choose another query or URL.
- **JSON API** (`tiny-browse serve --http`). `POST /search` and `POST /fetch` answer errors as `{ error, code }` with the codes above: status `400` for a body that fails validation, `422` for expected failures (bad input, every engine refused), `500` otherwise. `401` means a missing or wrong bearer token, `403` a cross-origin request.
- **Library with `useServer: "auto"`.** Calls sent to a running server rethrow the server's error as the same `TinyBrowseError`, so your handler works either way.

## Logging

The library never writes to stdout or stderr. To see what happened, pass a `logger` (any object with `error`, `warn`, `info` or `debug`) and a `logLevel`:

```ts
await webSearch({ query: "..." }, { logger: console, logLevel: "debug" });
```
