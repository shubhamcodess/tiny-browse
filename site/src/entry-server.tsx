// Build-time only: renders each page to static HTML so crawlers, LLMs and link unfurlers see the
// content without running JavaScript. scripts/prerender.mjs writes it into dist/*.html; in the
// browser createRoot replaces it with the live app.
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import App from './App'
import Docs from './Docs'

export function render(page: 'home' | 'docs'): string {
  return renderToString(<StrictMode>{page === 'home' ? <App /> : <Docs />}</StrictMode>)
}
