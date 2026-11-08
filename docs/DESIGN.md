# tiny-browse — Design Doc (v0, pre-implementation)

> A tiny, fast, model-agnostic web search + read engine, exposed as an MCP server.
> `npm i -g tiny-browse && tiny-browse` → any agent (Claude Code, Cursor, a local
> Ollama/llama.cpp agent, a custom script) gets `web_search` and `web_fetch`
> that return clean, heading-aware Markdown.

---

## 1. Goals and non-goals

### Goals
| # | Goal | Measurable target |
|---|------|-------------------|
| G1 | Tiny install | < 3 MB unpacked incl. deps, no bundled browser |
| G2 | Fast | Cold start < 150 ms; `web_fetch` of a static page p50 < 800 ms; `web_search` + read top 3 p50 < 4 s |
| G3 | LLM-agnostic | Zero model calls inside. Ranking, cleanup and chunking are deterministic |
| G4 | Agent-agnostic | MCP (stdio + Streamable HTTP) **and** plain CLI/HTTP JSON for non-MCP agents |
| G5 | Browser-agnostic | Uses whatever Chromium-family browser is installed; driver interface leaves room for Firefox (WebDriver BiDi) |
| G6 | LLM-ready output | Markdown with real heading hierarchy, tables, code fences, lists; boilerplate removed; token-budgeted |
| G7 | Optional images | `return_images` → placeholders in Markdown + image payloads in JSON for vision models |

### Non-goals (v1)
- No built-in LLM, no embeddings model, no summarization.
- No crawling / site mirroring. It answers one query or one set of URLs at a time.
- No CAPTCHA solving, fingerprint spoofing or "stealth" evasion (see §9).
- No login/session automation for private sites.

---

## 2. Key decisions (with reasoning)

### D1 — Language: TypeScript on Node 22, not Rust (for v1)
- The hot path is **network + browser rendering**, not CPU. Rust would save
  milliseconds on HTML parsing while costing per-platform native binaries
  (napi-rs prebuilds for 5–6 targets), which *increases* package size and
  install friction.
- Node 22 ships everything needed natively: `fetch` (undici), `WebSocket`
  client (for CDP), `AbortSignal.timeout`, `zlib`, `crypto`.
- Escape hatch: the extractor is a pure function `(html, url) → Doc`. If
  profiling shows it is the bottleneck, swap in a Rust/WASM build of it
  (e.g. on top of `lol_html` / `html5ever`) without touching the rest.

### D2 — Browser: drive the user's installed Chrome over raw CDP, no Puppeteer
- `puppeteer` downloads ~170 MB of Chromium. `puppeteer-core` doesn't, but is
  still a few MB and far more API than needed.
- We need ~10 CDP commands (`Target.createTarget`, `Page.navigate`,
  `Page.lifecycleEvent`, `Runtime.evaluate`, `Network.setBlockedURLs`,
  `Fetch.enable` for resource blocking, `Page.captureScreenshot`…). A
  hand-written CDP client over Node's built-in `WebSocket` is ~250 lines.
- **Discovery** (in order): `--browser-path` flag / `TINY_BROWSE_CHROME` env →
  known install paths per OS (Chrome, Chrome Canary, Chromium, Edge, Brave,
  Arc) → `which`. `tiny-browse doctor` prints what was found.
- **Modes**:
  - `launch` (default): spawn `--headless=new --remote-debugging-port=0
    --user-data-dir=~/.cache/tiny-browse/profile --no-first-run …`, read the
    WS URL from stderr, keep it **warm** and kill after idle timeout (default 5 min).
  - `attach`: `--cdp-url ws://…` to reuse an already running browser (e.g. the
    user's own Chrome started with remote debugging).
- **Chrome-first**: since Google-in-Chrome is the primary search path, the
  browser is launched **eagerly** at server start (in the background, so the
  MCP handshake is not delayed) and kept warm with one pre-opened blank tab.
  `browser.eager: false` restores lazy launch for fetch-only use.
- Session/profile handling and CAPTCHA behavior: see §4.0.
- Driver interface (`BrowserDriver`) so Firefox via WebDriver BiDi can be
  added later without touching the pipeline.

### D3 — Multi-angle fetching: race HTTP and Chrome, keep the best result
Search always runs in Chrome. For reading the result pages, many are
server-rendered (docs, blogs, Wikipedia, news, GitHub) and a plain HTTP fetch is
5–10× faster than a tab, while others need JavaScript. Instead of picking one, we
**race them and keep the best extraction** — full design in §4.2. The tiers
below are the building blocks of that race:

1. **Markdown-native fast path**: request with
   `Accept: text/markdown, text/html;q=0.9`. Some sites/CDNs now serve Markdown
   directly to agents; also check `/llms.txt` hints for docs sites. If we get
   Markdown, skip extraction.
2. **HTTP tier**: plain `fetch`, real browser-like UA, gzip/br, 8 s timeout,
   5 MB cap, follow redirects, sniff content type.
3. **Escalate to browser** if any "needs JS" heuristic fires:
   extracted main text < ~200 chars, body dominated by `<script>`,
   `<div id="root|app|__next">` empty, `<noscript>` says enable JS, known SPA
   domains list, or HTTP 403/429 with a bot-wall signature.
4. **Browser tier**: new tab, block images/fonts/media/ads via `Fetch`
   interception (unless images requested), wait for `networkIdle` *or* DOM
   stable for 500 ms (cap 10 s), then `Runtime.evaluate` to return
   `document.documentElement.outerHTML` (or run the extractor in-page).

### D4 — Search providers are pluggable; Google-via-browser is one of them
`SearchProvider` interface: `search(query, opts) → SerpResult[]`.

| Provider | How | Pros | Cons |
|---|---|---|---|
| `google` | Real Chrome tab on `google.com/search?q=…&hl=en&num=10`, parse result DOM | Best results, what the user asked for | Selectors change; frequent consent pages / CAPTCHAs in headless; ToS gray area |
| `duckduckgo` | `html.duckduckgo.com/html/?q=` via plain HTTP | No browser needed, fast, stable markup | Bing-backed, rate-limits under load |
| `bing` | HTTP or browser | Decent quality | Similar fragility |
| `searxng` | User's self-hosted SearXNG JSON API | Fully local, aggregates many engines, ideal for privacy-first local agents | User must run it |
| `brave` / `tavily` / `serper` | Official APIs with user's key | Stable, legal, fast | Needs a key |

- **Default chain: `["google", "duckduckgo", "bing"]`** — Google in Chrome
  always first; the others are fallbacks only, used when Google is blocked,
  times out, or its result page fails the health check (§4.1a).
- If Google shows a consent page or CAPTCHA, see §4.0 — we never solve it
  automatically.
- Results are normalized: `{rank, title, url, snippet, provider, date?}`.

### D5 — MCP: stdio by default, Streamable HTTP optional
- `tiny-browse` (no args) = stdio MCP server — this is what Claude Code,
  Cursor, Claude Desktop, Continue, Cline, LM Studio etc. expect.
- `tiny-browse serve --http 7777` = Streamable HTTP MCP + a plain
  `POST /search`, `POST /fetch` JSON API for agents that don't speak MCP.
- **Decided (M0): own MCP implementation, no SDK.** `@modelcontextprotocol/sdk`
  1.32 is 4.5 MB unpacked and depends on express, hono, ajv, zod, cors and
  ~12 more packages. Our `src/mcp/` (JSON-RPC core, schema validator, tools,
  stdio transport) covers initialize, ping, tools/list, tools/call and
  cancellation, and negotiates protocol versions 2024-11-05 through 2025-11-25.

### D6 — Few, well-described tools
Small local models choose tools badly when there are many. Expose **two**:

```jsonc
// web_search
{
  "query": "string",                 // loose natural-language query
  "max_results": 5,                  // SERP results to consider (1–10)
  "read": 3,                         // how many top results to fetch & extract (0 = SERP only)
  "max_tokens": 6000,                // total budget for returned Markdown
  "site": "docs.python.org",         // optional site: filter
  "freshness": "any|day|week|month|year",
  "return_images": false
}

// web_fetch
{
  "urls": ["https://…"],             // one or many absolute URLs
  "max_tokens": 8000,                // per call budget
  "focus": "optional query string",  // if set, rank chunks against it and return the best ones
  "cursor": "opaque",                // continue a long page from where the last call stopped
  "render": "auto|http|browser",
  "return_images": false
}
```

A bare URL passed as `query` to `web_search` is auto-routed to `web_fetch`.

---

## 3. Architecture

```
            ┌──────────────── Transports ────────────────┐
 agent ───► │ MCP stdio │ MCP Streamable HTTP │ CLI │ REST │
            └──────────────────────┬─────────────────────┘
                                   ▼
                          ┌─────────────────┐
                          │  Orchestrator   │  budgets, timeouts, cancellation
                          └──┬───────────┬──┘
                 search path │           │ fetch path
                             ▼           ▼
                 ┌──────────────┐   ┌──────────────┐     ┌───────────┐
                 │ SearchProvider│  │  Fetcher     │◄──► │  Cache    │ (disk, TTL)
                 │ chain         │  │  md→http→cdp │     └───────────┘
                 └──────┬───────┘   └──────┬───────┘
                        ▼                  ▼
                 ┌──────────────┐   ┌──────────────┐
                 │ SERP Ranker  │   │ Extractor    │  html → clean DOM → Markdown AST
                 └──────┬───────┘   └──────┬───────┘
                        └──────┬───────────┘
                               ▼
                        ┌──────────────┐
                        │ Chunker +    │  heading-aware chunks, BM25 rerank,
                        │ Budgeter     │  token packing, citations
                        └──────┬───────┘
                               ▼
                        Markdown + JSON (structuredContent)
                               ▲
                  ┌────────────┴───────────┐
                  │ BrowserDriver (CDP)    │  lazy launch / attach, tab pool
                  └────────────────────────┘
```

### Module layout (proposed)
```
src/
  cli.ts                 # arg parsing, commands: (default) | serve | search | fetch | doctor | config
  config.ts              # defaults ← config file ← env ← flags
  mcp/server.ts          # tool schemas, handlers, stdio + http transports
  http/api.ts            # plain JSON API
  core/orchestrator.ts
  search/provider.ts     # interface
  search/google.ts  search/duckduckgo.ts  search/searxng.ts  search/brave.ts
  search/rank.ts         # SERP re-ranking + dedup
  fetch/fetcher.ts       # tier logic, escalation heuristics
  fetch/http.ts  fetch/guard.ts (SSRF, size caps)
  browser/cdp.ts         # minimal CDP client over WebSocket
  browser/discover.ts    # find Chrome/Edge/Brave/Chromium per OS
  browser/pool.ts        # warm browser, tab pool, idle shutdown
  extract/parse.ts       # htmlparser2 → light DOM
  extract/clean.ts       # boilerplate removal
  extract/main.ts        # main-content scoring (readability-style)
  extract/markdown.ts    # DOM → Markdown serializer
  extract/sites/*.ts     # site adapters (wikipedia, github, stackoverflow, reddit, docs)
  chunk/chunker.ts  chunk/bm25.ts  chunk/budget.ts  chunk/tokens.ts
  images/images.ts
  cache/disk.ts
```

### Dependency budget
| Dep | Why | Size |
|---|---|---|
| `htmlparser2` (+`domhandler`, `entities`) | Fast, forgiving HTML parser | ~250 KB |
| `@modelcontextprotocol/sdk` | MCP protocol (replaceable, D5) | check |
| *nothing else* | CDP, fetch, WebSocket, BM25, Markdown, cache — all in-house | — |

Explicitly avoided: `puppeteer`, `playwright`, `jsdom` (~10 MB+),
`turndown` (needs a DOM), `sharp` (native), tokenizers (`tiktoken` is ~4 MB WASM).

---

## 4. The pipeline in detail

### 4.0 Chrome session, profile and CAPTCHAs
**Will a local session stop CAPTCHAs?** It reduces them a lot, but not to zero.
Google's checks look at cookies and history (a warm session helps), request rate
from the IP, and automation signals. Plan:

- **Dedicated persistent profile** at `~/.cache/tiny-browse/chrome-profile`.
  It survives restarts, so consent cookies and (optionally) a Google sign-in
  persist.
- **Why not your everyday Chrome profile directly?** Chrome locks a profile
  while it is open, and since Chrome 136 it ignores
  `--remote-debugging-port` on the default profile directory (a security
  change against cookie theft). So we use our own profile.
- **`tiny-browse login`**: opens a *visible* Chrome window on that profile. You
  accept the consent screen and, if you want, sign in to Google once. Every later
  headless run reuses those cookies. This is the single biggest CAPTCHA reducer.
- **Attach mode** for people who want their real browsing context: start Chrome
  yourself with `--remote-debugging-port=9222 --user-data-dir=<some dir>` and
  run `tiny-browse --cdp-url http://localhost:9222`.
- **Rate discipline**: at most 1 Google query in flight, minimum gap between
  queries (default 1.5 s), SERP cache (10 min) so repeated agent queries don't
  hit Google at all.
- **When a CAPTCHA or "unusual traffic" page appears** (detected by URL
  `/sorry/`, a reCAPTCHA iframe, or the health check):
  1. If running interactively (`browser.onChallenge: "show"`), bring up a
     visible window so **you** solve it; the request waits up to 60 s, then
     continues with the cleared session.
  2. Otherwise (`"fallback"`, the default for stdio MCP), answer this query
     from the next provider and mark Google "cooling down" for 10 minutes.
  We do not ship CAPTCHA solvers, stealth plugins or fingerprint spoofing.

### 4.1 Search → ranking-aware selection
1. **Query normalization**: trim, collapse whitespace; detect a URL → fetch path;
   detect `site:` and quoted phrases and pass them through.
2. **SERP fetch** from provider chain; take top `max_results` (default 5, up to 10).
   Drop ads, "People also ask", video carousels, shopping. Parsing is
   structure-proof, see §4.1a. Keep the featured snippet / answer box, if any,
   as a separate `answer` field (often the single most useful thing on the page).
3. **Re-rank** SERP items with a cheap deterministic score:
   ```
   score = w1·positionPrior(rank)          // 1/log2(rank+1)
         + w2·bm25(query, title + snippet)
         + w3·domainPrior(host)            // docs/official/wiki/SO/GitHub up; content farms down
         + w4·freshnessBoost(date)         // only if query looks time-sensitive ("latest", year, "today")
         − w5·duplicatePenalty             // same registrable domain already chosen, near-dup titles
   ```
   `domainPrior` is a small built-in table + user overrides
   (`ranking.prefer: ["docs.rs"]`, `ranking.block: ["pinterest.com"]`).
4. **Select** the top `read` (default 3) for fetching, with **diversity**: at
   most 1 page per registrable domain unless fewer candidates exist.
5. **Fetch in parallel** (concurrency 4), each with its own timeout. As soon as
   the combined extracted content comfortably exceeds `max_tokens` × 2 and the
   top-ranked ones are done, **cancel the stragglers** (don't wait for a slow
   5th site). A failed fetch is replaced by the next candidate.
6. **Streaming start**: we don't wait for the Google page to finish loading.
   The SERP extractor runs as soon as the first results exist in the DOM
   (polling every 100 ms after `DOMContentLoaded`), and fetching the top
   results starts immediately, while the rest of the SERP is still settling.

### 4.1a Structure-proof parsing (SERP and pages)
Class names and DOM nesting on Google and on websites change constantly. So we
**never depend on them**. We depend on things that cannot change without the
page breaking for humans too: what is visible, where it sits on screen, what
links where, what looks like a heading. Concretely:

**Principle 1 — Parse by invariants, not selectors.** A Google organic result,
in every redesign so far, is: a visible link to a non-Google domain, with a
heading-sized title, in the main column, with a text block near it. That
description is the parser.

**Principle 2 — Run in the page, use the rendered layout.** Because search
runs in Chrome, the extractor is a script injected with `Runtime.evaluate`.
It can call `getBoundingClientRect()` and `getComputedStyle()`, so it sees what
a human sees: visibility, position, font size and weight. No HTML-only parser
can do that.

**Principle 3 — Several independent extractors, then vote.** If one strategy
breaks after a redesign, the others still agree.

**SERP extractor (Google)**, all in-page:
1. *Candidate links*: every `<a href>` that is visible (non-zero box, not
   `display:none`/`visibility:hidden`/`opacity:0`), points outside Google
   (after unwrapping `/url?q=` redirects), and is not inside a
   `role=navigation`, header or footer.
2. *Main column*: cluster candidates by their x-position; the column with the
   most candidates in the upper page is the results column. Drops sidebars
   and knowledge-panel links automatically.
3. *Title*: the link's own `h3`/`role=heading`, else its largest-font text
   (computed `font-size` ≥ 1.15× body text).
4. *Result container*: walk up from the link until the ancestor also contains
   another candidate's title; the last ancestor before that is this result's box.
5. *Snippet*: the longest visible text block in the container that is not the
   title, URL breadcrumb or date.
6. *Exclusions by meaning, not class*: containers with a visible label
   "Sponsored"/"Ad" (`hl=en` is forced so labels are predictable), boxes
   whose items are questions with expand toggles (People also ask), video and
   image carousels (horizontal clusters of same-size boxes).
7. *Order*: by vertical position on screen; dedupe by normalized URL.

Second, independent strategy: the **accessibility tree** from CDP
(`Accessibility.getFullAXTree`): `link` nodes with a `heading` child and an
external URL. Accessibility semantics change far less than markup (Google
must stay screen-reader usable).

Third, fast path: a small versioned selector table (`#search a:has(h3)` etc.).
Fastest when it works; never trusted alone.

**Voting and health check**: merge results present in ≥ 2 strategies (or
in 1 if others found nothing but it passes all checks). A SERP is "healthy" if
it has ≥ 3 results, each with an external URL, a non-empty title, and titles
mostly unique. Unhealthy and not a "no results" page → retry once, then
fall back to the next provider and log `serp_drift` (shown in `doctor`).
A `tests/fixtures/serp/` folder of saved Google pages (several layouts, years
and languages) runs in CI against all three strategies, so drift shows up as
a test failure, not as silent garbage.

**Page extractor**: the same ideas applied to articles.
- In Chrome, **visual heading detection**: a `div` styled big and bold
  (computed font-size/weight clearly above body text, on its own line) is
  treated as a heading even if it isn't an `h1–h6`. Its level comes from
  ranking all distinct heading font sizes on the page. This is what makes the
  Markdown heading structure correct on badly-built sites.
- **Visible-only text**: hidden, off-screen, zero-size and
  same-color-as-background text is dropped (also kills prompt-injection
  tricks hidden in pages).
- **Main region by layout**: score blocks by text density (characters per
  pixel area), link density, and horizontal centrality; headers, sidebars and
  footers lose on position and link density regardless of their markup.
- **Structured data as extra evidence**: JSON-LD (`Article.articleBody`,
  `headline`, `datePublished`, `author`), OpenGraph, `<meta>`, framework
  payloads (`__NEXT_DATA__`, `__NUXT__`) — used for title/date/author, and as a
  candidate body when the DOM is thin.
- **Multiple candidates, one winner**: generic DOM scoring, layout scoring,
  site adapter (if any), JSON-LD body, `Accept: text/markdown` response. Each
  candidate gets a **quality score** (below) and the best one is converted to
  Markdown.

**Extraction quality score** (0–1, also returned in JSON): weighs main-text
length, ratio of prose to links, number of headings/paragraphs, presence of
the SERP title words in the text, absence of boilerplate phrases
("accept cookies", "sign in to continue", "enable JavaScript"), and
duplicate-line ratio. Used to choose between candidates and to decide
whether to escalate to Chrome.

### 4.2 Multi-angle fetching (race) — plus guards
For each URL selected to read:

```
t=0      ├─ HTTP fetch (Accept: text/markdown, text/html)  ──► extract ─► score
         ├─ if domain is known-SPA / previously needed JS ─► Chrome tab immediately
t≈300ms  └─ if HTTP not done or its score < 0.5 ─────────────► open Chrome tab too
first result with score ≥ 0.7 wins → cancel the other(s)
otherwise wait for both (bounded by deadline) and keep the higher score
```

- **Learned per-domain hints**: remember (in the cache dir) which domains
  needed Chrome and which were fine over HTTP, so next time we go straight to
  the right tier.
- **Connection warmth (native Node)**: one shared undici `Agent` with
  keep-alive and HTTP/2 (`allowH2`) so repeated hosts reuse connections;
  `dns.lookup` of SERP hosts as soon as they are parsed (pre-resolve, before
  fetching); `AbortSignal.any([deadline, raceLost])` to cancel losers;
  `Promise.any` for racing; parsing in a `worker_thread` when pages are big so
  the event loop stays responsive.
- **Chrome tab speed**: pre-opened tab pool; block images/fonts/media/ads with
  `Fetch.enable` (unless images are requested); stop waiting when the DOM is
  *stable* (a `MutationObserver` in-page sees no meaningful change for 400 ms)
  instead of waiting for network idle, which some sites never reach;
  `Page.stopLoading` afterwards.
- **Revalidation**: cached pages are revalidated with `If-None-Match` /
  `If-Modified-Since`, so unchanged pages cost one tiny request.

Guards:
- SSRF guard: resolve DNS and block private/loopback/link-local ranges and
  `file:`/`chrome:` schemes by default (an agent can be prompt-injected into
  fetching `http://localhost:…`). Opt-in `allow_private_network`.
- Per-domain politeness: max 2 concurrent requests, small jitter.
- Content types: HTML → extractor; `text/plain`, `text/markdown`, JSON →
  passthrough (pretty, fenced); PDF → v2 (optional `pdfjs` add-on,
  not in core size budget); images → only as image results.

### 4.3 Extraction: HTML → clean Markdown
**Step A — site adapters first.** If the host matches an adapter, use it:
Wikipedia (use the REST `page/html` endpoint, drop infobox noise/refs
optional), GitHub (README/issue/PR via raw/API), StackOverflow (question +
accepted + top answers with scores), Reddit (`.json`), MDN/Read-the-Docs/
Docusaurus/MkDocs (known main-content selectors). Adapters are where quality
comes from on the sites agents hit most.

**Step B — generic cleaning.** Remove: `script, style, noscript, template,
iframe, svg (non-content), form, button, input, nav, aside, footer, header
(outside article)`, `[role=navigation|banner|contentinfo|complementary]`,
`[aria-hidden=true]`, `[hidden]`, elements whose class/id match
`cookie|consent|banner|share|social|newsletter|subscribe|promo|related|
comment|sidebar|breadcrumb|advert|ad-|sponsor|popup|modal`. Unwrap layout
`div/span` chains.

**Step C — main-content detection** (readability-style, simplified):
prefer `<main>`, `<article>`, `[role=main]`, `[itemprop=articleBody]`;
otherwise score block nodes by text length, comma count, paragraph count,
and **link density** (penalize > 0.5), propagate score to parent/grandparent,
pick best candidate and include qualifying siblings.

**Step D — Markdown serialization** (custom, on the cleaned tree):
- **Headings**: keep levels, but *normalize* so the shallowest heading in the
  page becomes `##` (the page title is emitted as `#` once). Skipped levels
  are closed up (h2→h4 becomes ##→###). Empty/duplicate headings dropped.
- Paragraphs, `**bold**`, `*em*`, `` `code` ``, blockquotes.
- Lists: nested with 2-space indents; ordered lists keep `start`.
- **Code blocks**: fenced, language from `class="language-x|lang-x|hljs x"`;
  never reflowed; strip line-number gutters.
- **Tables**: GFM pipe tables for simple tables; tables with
  rowspan/colspan or block content → flattened to a list of rows
  (`- **Col**: value`) because LLMs read that better than broken pipes.
- Links: configurable `links: inline | reference | text` (default `reference`:
  keeps prose clean, URLs listed at the bottom as `[1]: url` — fewer tokens
  when the same link repeats). Relative URLs resolved. `javascript:` dropped.
- Images: see §6.
- Math: keep `$…$`/`$$…$$` from MathJax/KaTeX `annotation` source.
- Whitespace: collapse, max one blank line, trim trailing spaces; normalize
  smart quotes optionally.
**Step E — Markdown polish pass** (on the Markdown AST, before chunking):
- Drop sections that are only links (leftover "Related posts", tag clouds).
- Remove lines repeated 3+ times in the doc (repeated CTAs, "Copy" buttons).
- Merge paragraphs broken by inline ads; drop orphan "Advertisement" lines.
- Turn "Step 1 / Step 2…" paragraph sequences into ordered lists.
- Ensure every code block has a fence and every table has a header row.
- Final lint: no heading without content below it, no empty list items, no
  more than one blank line.

- Front matter per document:
  ```
  # <title>
  > Source: <url> · <site name> · <published date if found> · rank 2
  ```

### 4.4 Chunking (heading-aware)
- Walk the Markdown AST; each chunk = a section under a heading, carrying its
  **heading path** (`Installation › macOS › Homebrew`) so a chunk is
  understandable on its own.
- Target 300–800 tokens per chunk. Merge tiny adjacent sibling sections;
  split oversized ones at paragraph boundaries, then sentence boundaries.
- **Atomic blocks** never split: code fences, tables, list items, blockquotes.
  If a single atomic block exceeds the limit, it is truncated with a marker
  `… [truncated N lines]`.
- Each chunk: `{id, doc_id, heading_path, text, tokens, position}`.
- Token counting: `ceil(chars / 3.8)` heuristic (adjusted for code and CJK);
  precise enough for budgeting, zero deps.

### 4.5 Relevance + budget packing
- Score chunks with **BM25** against the query (or `focus`), plus small priors:
  doc rank, position (intro chunks get a boost), heading-match bonus
  (query terms in the heading path).
- Pack greedily into `max_tokens`, guaranteeing each fetched doc at least its
  intro chunk (so the agent sees every source), then best chunks by score.
- **Re-emit in original document order** (not score order) under each doc, with
  `…` separators where sections were skipped — keeps the document coherent.
- Anything left out is reachable: response includes a `cursor` per doc
  so the agent can call `web_fetch` again for the rest.

---

## 5. Output format

Every tool returns MCP `content` (text) **and** `structuredContent` (JSON).

**Markdown (what the model reads):**
```md
# Search: "rust async runtime comparison"
3 sources read · 5,840 tokens · 2026-11-08

## [1] Tokio vs async-std vs smol — Corrode Blog
> https://corrode.dev/blog/async/ · published 2025-03-12

### Overview
…
### Performance
…

## [2] …

---
Other results (not read):
4. Title — https://… — snippet
5. Title — https://… — snippet
```

**JSON (what code/agents can parse):**
```jsonc
{
  "query": "…",
  "provider": "google",
  "results": [
    {
      "rank": 1, "url": "…", "title": "…", "snippet": "…", "read": true,
      "doc": {
        "title": "…", "site": "…", "published": "…", "lang": "en",
        "markdown": "…", "tokens": 2100, "truncated": true, "cursor": "…",
        "chunks": [{ "id": "c3", "heading_path": ["Overview"], "tokens": 410 }],
        "images": [{ "id": "img1", "alt": "…", "src": "…", "mime": "image/png", "data": "base64…" }]
      },
      "timing_ms": { "fetch": 420, "extract": 18 }, "tier": "http"
    }
  ]
}
```
Fetched content is wrapped in clear `<<<untrusted web content>>>` markers in the
text output to help agents resist prompt injection from pages.

---

## 6. Images (`return_images`)
- `return_images: false` (default) → images become `[image: alt text]` (or dropped
  if no alt) — cheap, keeps meaning.
- `true` / `"urls"` → `![alt](img:1)` placeholder in Markdown; `images[]` in JSON
  with absolute `src`, `alt`, caption (`figcaption`), dimensions.
- `"inline"` → additionally fetch bytes and return them as MCP `image` content
  blocks (base64) so vision models actually see them.
- Filters: drop tracking pixels, icons, avatars, logos, sprites (< 64 px, svg
  icons, `data:` gifs, known ad hosts); keep only images inside main content;
  cap count (default 4) and size (default 1 MB each). No server-side resizing in
  core (would need `sharp`); optional: use CDP `Page.captureScreenshot` with a
  clip to get a down-scaled PNG when the browser tier is already active.

---

## 7. Caching and performance
- Disk cache at `~/.cache/tiny-browse/` (XDG/macOS/Windows aware):
  pages keyed by normalized URL, TTL 1 h default, honor `Cache-Control: no-store`;
  SERPs TTL 10 min; extracted Markdown cached alongside raw HTML hash.
- In-memory LRU for the current session.
- Warm browser + tab pool (2 tabs); per-tab resource blocking.
- Everything cancellable via `AbortController`; a whole tool call has a hard
  deadline (default 20 s) and returns partial results rather than failing.
- Benchmarks (`bench/`): a fixed set of 50 URLs + 20 queries; track latency,
  tokens out, and an extraction-quality score against hand-made gold Markdown.

---

## 8. CLI and configuration
```bash
npx tiny-browse                       # stdio MCP server (what agents launch)
tiny-browse serve --http 7777         # Streamable HTTP MCP + REST
tiny-browse search "query" --read 3   # prints Markdown (debug / non-MCP use)
tiny-browse fetch https://… --json
tiny-browse login                     # visible Chrome on the tiny-browse profile: accept consent / sign in once
tiny-browse doctor                    # finds browsers, tests providers + SERP health, checks cache dir
tiny-browse config claude-code        # prints ready-to-paste MCP config for a client
```
Claude Code example: `claude mcp add tiny-browse -- npx -y tiny-browse`.

Config precedence: defaults ← `~/.config/tiny-browse/config.json` ←
`./tiny-browse.config.json` ← env (`TINY_BROWSE_*`) ← CLI flags ← per-call args.

Key options: `browser.path`, `browser.mode (launch|attach)`, `browser.cdpUrl`,
`browser.headless`, `browser.idleTimeoutMs`, `search.providers`,
`search.searxngUrl`, `search.braveKey`, `fetch.timeoutMs`, `fetch.maxBytes`,
`fetch.allowPrivateNetwork`, `output.links`, `output.maxTokens`,
`images.mode`, `images.max`, `ranking.prefer/block`, `cache.ttl`.

---

## 9. Risks and responsible use
- **Google scraping** is against Google's ToS and is the most fragile part
  (markup churn, consent walls, CAPTCHAs, IP rate limits). Mitigations: it is
  one provider among several, not the only path; low request rates; persistent
  profile; graceful fallback. We will **not** ship CAPTCHA solving, stealth
  plugins or fingerprint spoofing. README should state this clearly and
  recommend SearXNG or an API key for heavy use.
- **Prompt injection** from fetched pages → untrusted-content markers, hidden
  text removed (`display:none`, `aria-hidden`, zero-size, same-color text in
  browser tier), no auto-following of links found in content.
- **SSRF** → private-network guard on by default (§4.2).
- **Politeness** → honest-ish UA string identifying tiny-browse optionally,
  per-domain concurrency limits; optional `respect_robots`.
- **Selector rot** → provider parsers covered by fixture tests + a `doctor`
  live check; easy to patch release.

---

## 10. Milestones
| M | Scope | Done when |
|---|---|---|
**v0.1 — Chrome-first core**
| M | Scope | Done when |
|---|---|---|
| M0 | Repo, TS build (tsup → single ESM file), CLI skeleton, config, stdio MCP with stub tools | Claude Code lists the two tools |
| M1 | CDP client, browser discovery, eager launch / attach, persistent profile, `tiny-browse login`, tab pool | A headless tab on the tiny-browse profile loads any URL |
| M2 | Google SERP: 3 extractors + voting + health check + fixtures; CAPTCHA detection → show/fallback | 20-query bench gives healthy SERPs; fixtures pass |
| M3 | Page extraction: in-page layout/visual-heading extractor, HTTP-tier DOM extractor, JSON-LD, quality score, Markdown serializer + polish | Clean MD on the 50-URL bench |
| M4 | Multi-angle race (HTTP vs Chrome), learned domain hints, guards, keep-alive/H2, streaming SERP start | `web_search` + read 3 within latency target |
| M5 | Chunker, BM25, budget packing, cursors, `focus`; DuckDuckGo + Bing fallbacks; SERP ranker | Output fits any `max_tokens`, stays coherent |
| M6 | Images, site adapters, disk cache, Streamable HTTP + REST, `doctor`, `config <client>`, npm publish | `npx tiny-browse` works on macOS/Linux/Windows |

**v0.2**
- **PDF**: PDFs found in results or passed as URLs → Markdown with headings
  (from font sizes, same idea as visual headings), page markers and tables
  where detectable. Ships as an optional dependency so the core stays tiny.
- **Web UI**: `tiny-browse serve --http` also serves a single static page at
  `/`: a search box, Enter runs `web_search`, results render as Markdown with
  a source list, timings, tier used (HTTP/Chrome) and quality score per source;
  a toggle to see the raw Markdown the LLM would receive. One HTML file, no
  framework; a small vendored Markdown renderer (~40 KB) loaded only by the UI.

**Later**: Firefox via BiDi, optional Rust/WASM extractor, optional
embedding reranker plugin, SearXNG/Brave providers.

---

## 10a. Findings from building M2 (2026-11-08)

Measured from one home network (Airtel, India) with Chrome 156:

| Engine | Automated Chrome (headless or visible), fresh profile |
|---|---|
| Google | CAPTCHA ("unusual traffic") on the **first** query, headless and visible alike |
| DuckDuckGo (html) | Bot check ("select the ducks"), also over plain HTTP |
| Brave Search | Bot check (slider) |
| Bing | First query fine, then **silently degraded**: unrelated results (YouTube, Facebook login) for normal queries |

Consequences built into M2:
- **Relevance check** (`off_topic` status): results that barely contain the query's
  terms are treated as a failed engine. If every engine fails and one was only
  off-topic, its results are returned with a visible warning instead of nothing.
- **Client-side redirects**: Google answers 200 and then its script navigates to
  `/sorry/`. `Page.goto` follows a main-frame document that replaces itself
  before it finishes loading.
- **`content-visibility: auto`**: Bing skips rendering off-screen results, so their
  text is empty to `innerText` and the accessibility tree. The SERP script forces
  rendering before reading.
- **Inline titles**: column detection uses the left edge of the title's
  enclosing block, not of the link.
- **The user's session fixes Google.** After one `tiny-browse login` on the real
  profile, Google served normal results (no CAPTCHA) to the same automated
  Chrome. A fresh profile got the CAPTCHA on its first query.
- **Opaque result links.** Google now links results as `/goto?url=<token>`; the
  destination is not in the link. Resolution, in order: (1) the breadcrumb shown
  under the title (host + path parts) and the title's words, matched against
  URLs that appear anywhere in the page; (2) for the rest, following the link in
  a background tab and capturing the first request that leaves the engine
  (~150–400 ms, destination never loaded), only for results that will be
  returned. The reader keeps polling up to 2.5 s because Google streams the
  data that resolves links after first paint.

We do not hide automation (no `--disable-blink-features=AutomationControlled`,
no user-agent rewriting, no stealth scripts): that is detection evasion. The
honest levers are the user's own session (`login --sign-in`, solving a CAPTCHA
via `onChallenge: "show"`), polite rates, and API-based providers (SearXNG,
Brave Search API) as fallbacks — see open questions.

## 11. Open questions
Decided:
- Google in Chrome is always first; DuckDuckGo and Bing are fallbacks.
- On CAPTCHA the default is **fallback** (`browser.onChallenge: "fallback"`);
  `"show"` is opt-in.
- `tiny-browse login` by default only opens Google so you can accept consent.
  Signing in is an **option** (`tiny-browse login --sign-in`), never the default
  and never required.
- PDF and the web UI are v0.2.

Open:
1. **License** (npm name `tiny-browse` is free as of 2026-11-08).
2. **API-based fallbacks** given §10a: add SearXNG (self-hosted, free) and/or the
   Brave Search API (key, free tier) to the provider chain?
