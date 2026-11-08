/**
 * Per-engine facts. Deliberately small: how to build the search URL, which
 * hosts belong to the engine, and an optional selector table (the fast path,
 * never trusted alone). Everything else is engine-independent.
 */
import type { SearchProviderName } from "../config.js";
import type { SearchOptions } from "./types.js";

export interface SelectorTable {
  /** One element per organic result. */
  item: string;
  /** Title element inside an item (its link is the closest <a>). */
  title: string;
  snippet: string;
}

export interface ProviderDef {
  name: SearchProviderName;
  label: string;
  buildUrl(query: string, opts: SearchOptions): string;
  /** Regex source matched against a hostname: links there are the engine's own. */
  internalHost: string;
  selectors: SelectorTable[];
}

function withSite(query: string, site?: string): string {
  return site ? `${query} site:${site}` : query;
}

export const PROVIDERS: Record<SearchProviderName, ProviderDef> = {
  google: {
    name: "google",
    label: "Google",
    buildUrl(query, opts) {
      const u = new URL("https://www.google.com/search");
      u.searchParams.set("q", withSite(query, opts.site));
      u.searchParams.set("hl", "en"); // predictable labels ("Sponsored", "People also ask")
      u.searchParams.set("num", String(Math.max(10, opts.maxResults)));
      const qdr = { day: "d", week: "w", month: "m", year: "y" }[opts.freshness as string];
      if (qdr) u.searchParams.set("tbs", `qdr:${qdr}`);
      return u.href;
    },
    internalHost:
      "^((www|accounts|policies|consent|support|maps|translate|webcache)\\.)?google\\.[a-z.]+$|gstatic\\.com$|^webcache\\.googleusercontent\\.com$",
    selectors: [
      { item: "#search .g, #rso > div", title: "h3", snippet: "[data-sncf], .VwiC3b, [style*='-webkit-line-clamp']" },
    ],
  },
  bing: {
    name: "bing",
    label: "Bing",
    buildUrl(query, opts) {
      const u = new URL("https://www.bing.com/search");
      u.searchParams.set("q", withSite(query, opts.site));
      u.searchParams.set("setlang", "en");
      const ez = { day: "ez1", week: "ez2", month: "ez3" }[opts.freshness as string];
      if (ez) u.searchParams.set("filters", `ex1:"${ez}"`);
      return u.href;
    },
    internalHost: "^(www\\.|cn\\.)?bing\\.com$|^go\\.microsoft\\.com$",
    selectors: [{ item: "#b_results > li.b_algo", title: "h2", snippet: ".b_caption p, .b_lineclamp2, .b_lineclamp3" }],
  },
  duckduckgo: {
    name: "duckduckgo",
    label: "DuckDuckGo",
    buildUrl(query, opts) {
      const u = new URL("https://html.duckduckgo.com/html/");
      u.searchParams.set("q", withSite(query, opts.site));
      u.searchParams.set("kl", "wt-wt");
      const df = { day: "d", week: "w", month: "m", year: "y" }[opts.freshness as string];
      if (df) u.searchParams.set("df", df);
      return u.href;
    },
    internalHost: "(^|\\.)duckduckgo\\.com$",
    selectors: [
      { item: ".result.results_links, .result", title: ".result__title, h2", snippet: ".result__snippet" },
      { item: "article[data-testid=result]", title: "h2", snippet: "[data-result=snippet]" },
    ],
  },
};
