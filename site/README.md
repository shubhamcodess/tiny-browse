# tiny-browse website

The landing page and docs for [tiny-browse](../README.md), built with Vite + React and deployed to GitHub Pages by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).

- `index.html` → the landing page (`src/App.tsx`), with the hero replay in `src/HeroMotion.tsx`
- `docs/index.html` → the docs page (`src/Docs.tsx`), rendered at build time from `README.md` and `docs/*.md`

```bash
cd site
npm install
npm run dev        # http://localhost:5173/tiny-browse/
npm run build      # static output in site/dist, prerendered for crawlers
```

The build assumes the project-site path `/tiny-browse/`. For a custom domain, build with `BASE_PATH=/` and `SITE_URL=https://your.domain/`.

Content lives in code: install commands, links and measured numbers in `src/data.ts`, the FAQ in `src/faq.ts` (also emitted as FAQPage structured data and into `llms.txt`), terminal output in `src/Sections.tsx`. The build also writes `robots.txt`, `sitemap.xml`, `llms.txt` and `llms-full.txt`. The design system is shared with the mcp-token-optimizer site; see `DESIGN.md`.
