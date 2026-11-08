/**
 * Search without Chrome (browser.mode "off"): fetch an engine's plain-HTML
 * results page and parse it with the lite HTML parser. Faster and
 * dependency-free, but it relies on the engine's markup (selectors), so it is
 * less robust than the Chrome path, and only engines that serve results to
 * plain HTTP are supported. Google needs JavaScript, so it is not one of them.
 */
import type { SearchProviderName } from "../config.js";
import { decodeBody, httpGet } from "../fetch/http.js";
import { closest, find, findAll, hasClass, parseHtml, textOf, type El } from "../extract/html.js";
import type { ProviderDef } from "./providers.js";
import type { ReadPage } from "./search.js";
import { judge } from "./serp.js";
import type { PageSignals, RawResult, SerpPage } from "./types.js";
import { isInternal, normalizeUrl, unwrapTarget } from "./urls.js";

type Parser = (root: El, pageUrl: string, internalHost: string) => RawResult[];

const CHALLENGE =
  /unusual traffic from your computer|not a robot|are you a robot|verify you are (a )?human|bots use duckduckgo|verifying you're not a bot|complete the following challenge|solve this puzzle/i;
const NO_RESULTS = /did not match any documents|no results found for|there are no results for|your search returned no results/i;

const PARSERS: Partial<Record<SearchProviderName, Parser>> = {
  duckduckgo(root, pageUrl, internal) {
    return findAll(root, (e) => hasClass(e, "result") && !hasClass(e, "result--ad"))
      .map((item) => {
        const a = find(item, (e) => e.tag === "a" && hasClass(e, "result__a"));
        const snippet = find(item, (e) => hasClass(e, "result__snippet"));
        return a ? raw(a, snippet, pageUrl, internal) : undefined;
      })
      .filter((r): r is RawResult => !!r);
  },
  bing(root, pageUrl, internal) {
    return findAll(root, (e) => e.tag === "li" && hasClass(e, "b_algo"))
      .map((item) => {
        const h2 = find(item, (e) => e.tag === "h2");
        const a = h2 && (find(h2, (e) => e.tag === "a") ?? closest(h2, (e) => e.tag === "a"));
        const snippet = find(item, (e) => (e.tag === "p" && !!closest(e, (x) => hasClass(x, "b_caption"))) || /\bb_lineclamp\d\b/.test(e.attrs.class ?? ""));
        return a ? raw(a, snippet, pageUrl, internal) : undefined;
      })
      .filter((r): r is RawResult => !!r);
  },
};

function raw(a: El, snippet: El | undefined, pageUrl: string, internal: string): RawResult | undefined {
  const url = unwrapTarget(a.attrs.href ?? "", pageUrl, internal);
  if (!url || isInternal(url, internal)) return undefined;
  const title = textOf(a);
  if (title.length < 3) return undefined;
  return { url, title, snippet: snippet ? textOf(snippet).slice(0, 500) : "" };
}

export function supportsHttpSearch(provider: SearchProviderName): boolean {
  return provider in PARSERS;
}

/** Parse a results page that was already fetched (also used by tests). */
export function parseHttpSerp(def: ProviderDef, html: string, pageUrl: string, status: number, query?: string): Omit<SerpPage, "ms"> {
  const root = parseHtml(html);
  const text = textOf(find(root, (e) => e.tag === "body") ?? root).slice(0, 6000);
  const signals: PageSignals = {
    url: pageUrl,
    title: textOf(find(root, (e) => e.tag === "title") ?? root).slice(0, 200),
    challenge: CHALLENGE.test(text) || (def.name === "duckduckgo" && status === 202),
    consent: false,
    noResults: NO_RESULTS.test(text),
  };
  const seen = new Set<string>();
  const results = (PARSERS[def.name]?.(root, pageUrl, def.internalHost) ?? [])
    .filter((r) => {
      const k = normalizeUrl(r.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r, i) => ({ ...r, rank: i + 1, foundBy: ["selectors" as const] }));
  const serpStatus = judge(signals, results, query);
  return {
    provider: def.name,
    status: serpStatus,
    results: serpStatus === "challenge" || serpStatus === "consent" ? [] : results,
    signals,
    strategies: { visual: 0, accessibility: 0, selectors: results.length },
  };
}

export function httpReadPage(opts: { timeoutMs: number; maxBytes: number }): ReadPage {
  return async (def, query, url, o, signal) => {
    const start = performance.now();
    try {
      const res = await httpGet(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, allowPrivate: false, signal });
      const page = parseHttpSerp(def, decodeBody(res.body, res.contentType), res.url, res.status, query);
      return { ...page, results: page.results.slice(0, o.maxResults), ms: performance.now() - start };
    } catch (err) {
      if (signal.aborted) throw err;
      return {
        provider: def.name,
        status: "error",
        results: [],
        strategies: { visual: 0, accessibility: 0, selectors: 0 },
        ms: performance.now() - start,
        error: (err as Error).message,
      };
    }
  };
}
