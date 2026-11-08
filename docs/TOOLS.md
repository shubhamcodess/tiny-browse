# MCP tools and server

tiny-browse exposes two MCP tools, over stdio (`tiny-browse mcp`) or HTTP (`tiny-browse serve --http`).

## `web_search`

Searches the web and reads the best results. Google comes first; DuckDuckGo and Bing are fallbacks.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Plain words. Google operators such as `site:` and `"quotes"` work |
| `max_results` | integer 1–10 | 5 | Results to consider |
| `read` | integer 0–10 | 3 | Top results to open and read; 0 returns only the result list |
| `max_tokens` | integer 200–200000 | 6000 | Hard limit on the whole answer |
| `site` | string | | Only results from this domain |
| `freshness` | `any` `day` `week` `month` `year` | `any` | Only recent results |
| `return_images` | boolean | false | Also return the main images of the pages read |

Returns Markdown with each page read under its result heading, followed by the other results (title, URL, snippet). Pages are chosen one per site, preferring results that match the query well. Long pages keep the sections most relevant to the query. A URL given as `query` is read directly.

## `web_fetch`

Reads pages by URL.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `urls` | string[] (1–10) | | Absolute http(s) URLs |
| `max_tokens` | integer 200–200000 | 8000 | Hard limit on the whole answer, shared between the URLs |
| `focus` | string | | Return only the sections most relevant to this question |
| `cursor` | string | | Continue a page that was cut short |
| `render` | `auto` `http` `browser` | `auto` | `auto` uses plain HTTP when that works and Chrome when the page needs JavaScript |
| `return_images` | boolean | false | Also return the pages' main images |

Give `urls` or `cursor`. When a page is cut to fit `max_tokens`, the output ends with a note and a `cursor` to read the rest.

## Output

- Markdown keeps headings, code blocks with their language, tables, lists, quotes and links (as references by default).
- Each page is wrapped in `<!-- begin untrusted content from <host> -->` … `<!-- end untrusted content -->`, so agents can tell web content from instructions.
- With MCP protocol 2025-06-18 or later, results also carry `structuredContent` with the result list, pages, token counts, cursors and timings.
- With `return_images`, images are returned as MCP image blocks (PNG, JPEG, GIF or WebP, at most 4 of up to 1 MB by default).

## Connecting clients

`tiny-browse config <client>` prints the setup for `claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex` or `generic`. The command for any stdio client is:

```bash
npx -y @shubhamcodess/tiny-browse mcp
```

## HTTP server

```bash
tiny-browse serve --http 7777 [--host 127.0.0.1] [--token SECRET]
```

| Endpoint | Description |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (JSON responses). Sessions are optional |
| `POST /search` | JSON API: `web_search` arguments in, `{ markdown, data, images }` out |
| `POST /fetch` | JSON API: `web_fetch` arguments in, `{ markdown, data, images }` out |
| `GET /health` | `{ ok, name, version }` |

Errors from the JSON API are `{ error, code }` with the codes listed in [LIBRARY.md](LIBRARY.md#errors).

The server:

- listens on `127.0.0.1` by default and refuses other addresses unless a token is set (`--token` or `TINY_BROWSE_TOKEN`; clients send `Authorization: Bearer <token>`);
- rejects requests from web pages (Origin check), which also blocks DNS-rebinding attacks;
- keeps one Chrome warm for every client, and writes a port file to the cache folder so library clients with `useServer: "auto"` can use it.

Example client configuration (VS Code):

```json
{ "servers": { "tiny-browse": { "type": "http", "url": "http://127.0.0.1:7777/mcp" } } }
```
