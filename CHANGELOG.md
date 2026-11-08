# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, breaking changes bump the minor version.

## [Unreleased]

## [0.1.0] - 2026-11-08

First release.

### Added

- MCP server with `web_search` and `web_fetch`, over stdio (`tiny-browse mcp`) and HTTP (`tiny-browse serve --http`), plus a JSON API.
- Library API: `webSearch`, `webFetch`, `createClient`, `doctor`, `TinyBrowseError` and TypeScript types.
- Google search in the installed Chrome with DuckDuckGo and Bing fallbacks; results parsed three independent ways and merged by vote.
- Page reading over plain HTTP or in Chrome, whichever works, remembered per site.
- Clean Markdown extraction keeping headings, code, tables, lists and quotes.
- Hard `max_tokens` limit, `focus` for relevant sections, `cursor` to continue long pages, and a model-agnostic token counter.
- Strict, shared request budgets for search engines and escalating pauses after CAPTCHAs.
- No-Chrome mode (`--no-chrome`, `mode: "http"`).
- Image bytes for vision models (`return_images`).
- Disk cache for pages and search results.
- `tiny-browse login`, `doctor`, `init` and `config <client>`.

### Security

- Local and private network addresses refused, including requests made by pages inside Chrome.
- Pages read in a cookie-less browser context.

[Unreleased]: https://github.com/shubhamcodess/tiny-browse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shubhamcodess/tiny-browse/releases/tag/v0.1.0
