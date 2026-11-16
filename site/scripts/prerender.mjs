// Fills <div id="root"><!--app--></div> in the built pages with server-rendered HTML.
// Runs after `vite build` and `vite build --ssr src/entry-server.tsx --outDir dist-ssr`.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { render } = await import(pathToFileURL(join(site, 'dist-ssr/entry-server.js')).href)

for (const [page, file] of [
  ['home', 'dist/index.html'],
  ['docs', 'dist/docs/index.html'],
]) {
  const path = join(site, file)
  const html = readFileSync(path, 'utf8')
  if (!html.includes('<!--app-->')) throw new Error(`${file}: no <!--app--> placeholder`)
  // external links open in a new tab without handing over window.opener; the browser bundle does the
  // same at runtime (externalLinks.ts), this puts it in the static HTML crawlers read
  const body = render(page).replace(/<a ((?:(?!target=)[^>])*?)href="(https?:\/\/[^"]+)"/g, '<a $1href="$2" target="_blank" rel="noopener noreferrer"')
  writeFileSync(path, html.replace('<!--app-->', () => body))
  console.log(`prerendered ${file} (${Math.round(body.length / 1024)} KB)`)
}
rmSync(join(site, 'dist-ssr'), { recursive: true, force: true })
