# Design notes: tiny-browse site

The site uses the **Night Console** design system from the mcp-token-optimizer site, so both projects read as one family. Tokens, type, layout and components are the same; this file records only what tiny-browse adds or changes.

## Shared with mcp-token-optimizer

- **Grounds.** Near-black `#0c0c0b` dark theme and warm off-white `#fafaf8` light theme, both first-class. Code surfaces use their own `--m-*` ramp and flip with the theme.
- **Type.** Geist at weight 560 for headings (never above 600), JetBrains Mono for anything a program printed or a person types.
- **Layout.** 1180px framed column with hairline side rules, `clamp(64px, 9vw, 120px)` section padding, `minmax(0, 1fr)` on every grid track, one column below ~900px, no horizontal scroll at 390px.
- **Depth.** Only real windows (terminals, code windows, the hero replay) get the long soft shadow. Cards and tiles stay flat on hairlines.
- **Backdrop.** The fixed dot field (`Field.tsx`), dimming under a slow sweep and lifting near the pointer.
- **Motion explains the mechanism**, runs only on screen, and has a finished static state under `prefers-reduced-motion`.
- **No invented claims.** No user counts, testimonials or star counts below 25. Download and star numbers load live from npm and GitHub.

## What tiny-browse changes

**Audience: local agents.** Copy says "your local agent", never "any agent": tiny-browse is built for agents that run on your own machine.

**Two meaning colours instead of one.** mto's product removes noise, so its single accent is orange. tiny-browse finds and keeps content, so:

- **Found green** (`--ok`: dark `#7fd4a0`, light `#15803d`) marks what reaches the agent: picked results, kept content, the Markdown, the token meter, citations. It is also the hover, focus and selection accent, and matches the green in the tiny-browse logo.
- **Cut orange** (`--cut`: dark `#f7703f`, light `#c2410c`) marks only what tiny-browse drops: navigation, cookie banners, sidebars, refused private addresses, untrusted-content markers. If something is orange and nothing was dropped or refused, it is wrong.

**The hero is a replay, not an agent app.** `HeroMotion.tsx` plays one `web_search` call on a 16.5 s loop: ask → search (three parsers vote) → read (noise flagged orange, struck, collapsed) → fit (tokens fall from 68,928 to 1,343 under a 1,500 budget) → cited answer. Every number is measured on the real nodejs.org page (`MEASURED` in `data.ts`). It has two panes, capped at 980px wide: your local agent, and tiny-browse at work (results, then the page being cleaned, then the Markdown, with the token meter pinned below). Below 860px only the working pane shows, with the step strip as the progress indicator. The clock adds up elapsed time on a 40 ms interval and starts as soon as the replay is on screen. `?hm=<ms>` freezes a frame for review.

**Logo.** A near-black tile (`#0c0c0b`) in both themes: a Markdown page with a green heading hash, a heading bar and three text lines, and a magnifier finding two green lines. A 10% white inner rim keeps the edge visible on dark grounds. On the site the shadow is CSS (`.brand__mark`): a soft dark drop shadow in light mode, a faint light rim plus a deep shadow in dark mode. One drawing everywhere: `assets/icon.svg`, `assets/logo.svg`, the PNG sizes, `site/public/favicon.svg` and the social card.

## Sections

Hero (replay) · Works with · How it works (four steps) · Features bento · Use cases · Featured use case (whatcmd) · Install and connect · npm library · FAQ · Built in the open · Call to action. The docs page renders `README.md` and `docs/*.md` at build time, grouped as Get started, npm library (API, errors), MCP server and Reference.

## SEO and AI discovery

Prerendered HTML for both pages; canonical, Open Graph and Twitter tags; JSON-LD for `SoftwareApplication`, `SoftwareSourceCode`, `FAQPage` (from `src/faq.ts`) and `TechArticle` (docs); `robots.txt`, `sitemap.xml`, `llms.txt` (summary, API and FAQ) and `llms-full.txt` (every guide); a CSP meta tag with the inline theme script allowed by hash.
