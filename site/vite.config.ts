import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { FAQ } from './src/faq.ts'

const root = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const PKG = JSON.parse(read('package.json')) as { version: string; description: string; name: string }
const VERSION = PKG.version
// The public site URL (absolute, trailing slash). Override with SITE_URL for a custom domain.
const SITE_URL = (process.env.SITE_URL ?? 'https://shubhamcodess.github.io/tiny-browse/').replace(/\/?$/, '/')
const REPO = 'https://github.com/shubhamcodess/tiny-browse'
const BLOB = `${REPO}/blob/main/`
const NPM = `https://www.npmjs.com/package/${PKG.name}`

/** Release date and test count, read from the repo so the page never goes stale. */
function buildFacts() {
  const iso = read('CHANGELOG.md').match(new RegExp(`^## \\[${VERSION.replace(/\./g, '\\.')}\\] - (\\d{4}-\\d{2}-\\d{2})`, 'm'))?.[1]
  const releaseDate = iso
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : ''
  const tests = readdirSync(resolve(root, 'test'))
    .filter((f) => f.endsWith('.test.ts'))
    .reduce((n, f) => n + (read(`test/${f}`).match(/^\s*(?:it|test)\(/gm)?.length ?? 0), 0)
  return { releaseDate, tests }
}

const DOCS = ['README.md', 'docs/LIBRARY.md', 'docs/ERRORS.md', 'docs/TOOLS.md', 'docs/CONFIGURATION.md']

/** Structured data: the software, its npm package, the FAQ and the docs page. */
function jsonLd() {
  const app = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'tiny-browse',
    description: PKG.description,
    url: SITE_URL,
    image: `${SITE_URL}og.png`,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'MCP server',
    operatingSystem: 'macOS, Linux',
    softwareVersion: VERSION,
    softwareRequirements: 'Node.js 22+, Chrome, Chromium, Edge or Brave (optional)',
    license: 'https://opensource.org/licenses/MIT',
    downloadUrl: NPM,
    installUrl: NPM,
    codeRepository: REPO,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: 'Shubham Prakash', url: 'https://github.com/shubhamcodess' },
    keywords: 'MCP, Model Context Protocol, web search, web fetch, AI agents, Markdown, Chrome, Node.js',
  }
  const code = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: PKG.name,
    codeRepository: REPO,
    programmingLanguage: 'TypeScript',
    runtimePlatform: 'Node.js 22+',
    license: 'https://opensource.org/licenses/MIT',
    targetProduct: { '@type': 'SoftwareApplication', name: 'tiny-browse' },
  }
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }
  const docs = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: 'tiny-browse documentation',
    description: 'Install, connect an agent, the library API, error handling, MCP tools and configuration.',
    url: `${SITE_URL}docs/`,
    proficiencyLevel: 'Beginner',
    dependencies: 'Node.js 22+',
    about: { '@type': 'SoftwareApplication', name: 'tiny-browse' },
    author: { '@type': 'Person', name: 'Shubham Prakash' },
  }
  const tag = (o: object) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
  return { home: [app, code, faq].map(tag).join('\n    '), docs: tag(docs) }
}

/** robots.txt, sitemap.xml, llms.txt and llms-full.txt, plus %SITE_URL% and JSON-LD in the HTML. */
function seo(): Plugin {
  const ld = jsonLd()
  return {
    name: 'tb-seo',
    transformIndexHtml: (html) =>
      html
        .replaceAll('%SITE_URL%', SITE_URL)
        .replaceAll('%VERSION%', VERSION)
        .replace('<!--jsonld-->', ld.home)
        .replace('<!--jsonld-docs-->', ld.docs),
    generateBundle(options) {
      if (options.format !== 'es' || this.environment?.name === 'ssr') return
      const emit = (fileName: string, source: string) => this.emitFile({ type: 'asset', fileName, source })
      const today = new Date().toISOString().slice(0, 10)
      emit('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`)
      emit(
        'sitemap.xml',
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          [SITE_URL, `${SITE_URL}docs/`].map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
          `\n</urlset>\n`,
      )
      emit(
        'llms.txt',
        `# tiny-browse

> Web search and page reading for local AI agents and Node.js, built for agents that run on your own machine. It searches Google in the user's installed Chrome (DuckDuckGo and Bing as fallbacks), reads the best results and returns clean Markdown within a hard token budget. One zero-dependency npm package (${PKG.name}, 126 kB) that is both an MCP server and a library. No API keys, no bundled browser, no LLM inside. MIT licence.

Install: \`npm install -g ${PKG.name}\` (Node.js 22+), then \`tiny-browse doctor\`. Agents run it with \`npx -y ${PKG.name} mcp\`. As a library: \`npm install ${PKG.name}\`.

MCP tools: \`web_search\` (query, max_results, read, max_tokens, site, freshness, return_images) and \`web_fetch\` (urls, max_tokens, focus, cursor, render, return_images).

Library: \`webSearch(input, options?)\`, \`webFetch(input, options?)\`, \`createClient(options?)\`, \`doctor(options?)\`. Errors are \`TinyBrowseError\` with \`code\`: chrome_not_found, timeout, blocked, network, private_address, aborted, invalid_input.

## Docs

- [Full documentation as one file](${SITE_URL}llms-full.txt): README plus every guide, plain Markdown
- [Docs page](${SITE_URL}docs/): install, agents, library API, errors, MCP tools, configuration
- [Library API](${BLOB}docs/LIBRARY.md)
- [Errors and how to handle them](${BLOB}docs/ERRORS.md)
- [MCP tools and HTTP server](${BLOB}docs/TOOLS.md)
- [Configuration](${BLOB}docs/CONFIGURATION.md)

## FAQ

${FAQ.map((f) => `- **${f.q}** ${f.a}`).join('\n')}

## Project

- [Source code](${REPO})
- [npm package](${NPM})
- [Changelog](${BLOB}CHANGELOG.md)
- [Security](${BLOB}SECURITY.md)
- [whatcmd](https://github.com/shubhamcodess/whatcmd): a CLI that uses tiny-browse as a library for web lookups
`,
      )
      emit(
        'llms-full.txt',
        `# tiny-browse: full documentation\n\nSource: ${REPO}\nVersion: ${VERSION}\n\n` +
          DOCS.map((d) => `<!-- ${d} -->\n\n${read(d).trim()}\n`).join('\n---\n\n'),
      )
    },
  }
}

/**
 * Build-only head hardening that GitHub Pages cannot do with response headers: a
 * Content-Security-Policy <meta> (inline scripts allowed by hash), Referrer-Policy, and a preload
 * of the two Latin font files the first screen uses.
 */
function headHardening(): Plugin {
  let base = '/'
  return {
    name: 'tb-head',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
          (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
        )
        const csp = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          'connect-src https://api.npmjs.org https://api.github.com',
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
          'upgrade-insecure-requests',
        ].join('; ')
        const fonts = Object.keys(ctx.bundle ?? {})
          .filter((f) => /(geist|jetbrains-mono)-latin-wght-normal-[\w-]+\.woff2$/.test(f))
          .map((f) => `    <link rel="preload" href="${base}${f}" as="font" type="font/woff2" crossorigin />`)
        const head = [
          `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
          '    <meta name="referrer" content="strict-origin-when-cross-origin" />',
          ...fonts,
        ].join('\n')
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n${head}`)
      },
    },
  }
}

// GitHub Pages serves project sites from /<repo>/. Override with BASE_PATH=/ for a custom domain.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/tiny-browse/',
  plugins: [react(), seo(), headHardening()],
  define: {
    __BUILD_FACTS__: JSON.stringify(buildFacts()),
    __SITE_URL__: JSON.stringify(SITE_URL),
  },
  // the docs page renders the repository's guides, one level up
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        docs: resolve(import.meta.dirname, 'docs/index.html'),
        404: resolve(import.meta.dirname, '404.html'),
      },
    },
  },
})
