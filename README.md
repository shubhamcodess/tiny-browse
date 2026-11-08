# tiny-browse

Tiny, fast, model-agnostic web search and page reading for AI agents, served
over [MCP](https://modelcontextprotocol.io). It searches Google in the Chrome
already installed on your computer (falling back to DuckDuckGo or Bing), reads
the best results, and returns clean, heading-structured Markdown. No bundled
browser, no LLM inside.

> **Status: early development (milestone M5).** `web_search` finds results on
> Google (falling back to DuckDuckGo and Bing) and reads the top pages;
> `web_fetch` reads any URL. Pages come back as clean, heading-structured
> Markdown, usually via a fast plain-HTTP path with a full Chrome load when a
> page needs JavaScript. Local and private-network addresses are refused unless
> `fetch.allowPrivateNetwork` is set. `max_tokens` is a hard limit on every
> answer (counted with a built-in model-agnostic tokenizer); long pages can be
> narrowed with `focus` or continued with `cursor`. Google is queried within a
> strict request budget. Not yet: image bytes, PDFs.
> Search engines often block automated browsers; see
> [docs/DESIGN.md §10a](docs/DESIGN.md). Plan: [docs/DESIGN.md](docs/DESIGN.md).

## Use with an agent

```bash
npx tiny-browse init
```

`init` creates the config file and Chrome profile, then prints the snippet to
paste into your agent. For Claude Code that is:

```bash
claude mcp add tiny-browse -- npx -y tiny-browse
```

For other clients, print the snippet: `tiny-browse config <client>` where
client is `claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex` or `generic`.
When run from a source checkout, the snippets point at that checkout's
`dist/cli.js` instead of `npx`.

Agents start the server themselves. Running `tiny-browse start` in a terminal
also starts it and prints the snippet.

## Tools

- **web_search** `{ query, max_results?, read?, max_tokens?, site?, freshness?, return_images? }`
- **web_fetch** `{ urls, max_tokens?, focus?, cursor?, render?, return_images? }`

## CLI

```
tiny-browse init                first-time setup + agent snippet
tiny-browse start               MCP server on stdio (also: no command)
tiny-browse search <query>      print Markdown results
tiny-browse fetch <url...>      print a page as Markdown
tiny-browse login [--sign-in]   accept Google consent in the tiny-browse Chrome profile
tiny-browse doctor              environment checks, finds and test-starts Chrome
tiny-browse open <url>          debug: load a URL in headless Chrome
tiny-browse config <client>     MCP setup snippet
```

Run `tiny-browse --help` for all options.

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
