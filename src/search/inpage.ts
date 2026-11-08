/// <reference lib="dom" />
/**
 * Runs INSIDE the search results page (via Runtime.evaluate).
 *
 * Strategy "visual" relies only on what a person sees, never on class names:
 * a result is a visible link to a non-engine site, with heading-like title
 * text, in the main results column, with a text block near it.
 * Strategy "selectors" uses the provider's selector table (fast, fragile).
 * Page signals (CAPTCHA, consent wall, "no results") are detected too.
 *
 * Both functions are serialized with toString(): keep them self-contained.
 */
import type { SelectorTable } from "./providers.js";
import type { PageSignals, RawResult } from "./types.js";
import { unwrapTarget } from "./urls.js";

export interface InPageOptions {
  internalHost: string;
  selectors: SelectorTable[];
  /** Ignore anything below this many pixels from the top (endless pages). */
  maxTop: number;
}

export interface InPageOutput {
  visual: RawResult[];
  selectors: RawResult[];
  /** Opaque result links (absolute href) resolved to their destinations. */
  opaque: Record<string, string>;
  /** Opaque result links the page gives no destination for. */
  unresolved: string[];
  signals: PageSignals;
  debug: { anchors: number; candidates: number; column: number | null };
}

type Unwrap = typeof unwrapTarget;

export function serpInPage(opts: InPageOptions, unwrap: Unwrap): InPageOutput {
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
  const base = location.href;

  // Engines skip rendering off-screen results (content-visibility: auto), which
  // leaves their text empty to innerText and the accessibility tree. Force it.
  // The tab is thrown away afterwards, so changing the page is harmless.
  if (!document.getElementById("__tiny_browse_render_all")) {
    const style = document.createElement("style");
    style.id = "__tiny_browse_render_all";
    style.textContent = "*{content-visibility:visible!important;contain-intrinsic-size:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  const visibleRect = (el: Element): DOMRect | null => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
    return r;
  };

  // ---------- page signals ----------
  const bodyText = document.body ? document.body.innerText.slice(0, 6000) : "";
  const challenge =
    /\/sorry\/|captcha|\/challenge/i.test(location.pathname) ||
    !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], #captcha-form, .g-recaptcha, .h-captcha, #challenge-form',
    ) ||
    /unusual traffic from your computer|not a robot|are you a robot|verify you are (a )?human|bots use duckduckgo|verifying you're not a bot|complete the following challenge|solve this puzzle/i.test(
      bodyText,
    );
  const consent =
    /^consent\./.test(location.hostname) ||
    /before you continue to google|we use cookies and data to deliver and maintain/i.test(bodyText);
  const noResults =
    /did not match any documents|no results found for|there are no results for|no results\.|your search returned no results/i.test(
      bodyText,
    );

  // ---------- strategy: visual ----------
  type Cand = {
    url: string;
    title: string;
    titleEl: Element;
    rect: DOMRect;
    score: number;
    font: number;
  };

  // ---------- opaque result links ----------
  // Engines may link results through opaque redirects (Google: /goto?url=<token>).
  // The destination must still be somewhere in the page (the click has to
  // work), and the result shows people a breadcrumb ("site.com › docs › x").
  // Match the two: same host, breadcrumb parts in order in the path.
  const internalRe = new RegExp(opts.internalHost, "i");
  const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  let pageUrls: Map<string, number> | null = null;
  const urlsInPage = (): Map<string, number> => {
    if (pageUrls) return pageUrls;
    pageUrls = new Map();
    const html = document.documentElement.innerHTML
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/");
    for (const m of html.match(/https?:\/\/[^\s"'<>\\)\]]+/g) || []) {
      try {
        if (internalRe.test(new URL(m).hostname)) continue;
      } catch {
        continue;
      }
      pageUrls.set(m, (pageUrls.get(m) || 0) + 1);
    }
    return pageUrls;
  };
  const crumbRe = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\s*›.*)?$/i;
  const breadcrumbFor = (a: Element): string | null => {
    let scope: Element | null = a;
    for (let i = 0; i < 5 && scope; i++, scope = scope.parentElement) {
      if (i > 0 && scope.querySelectorAll(HEADING).length > 1) break; // reached the list of results
      const els = i === 0 ? [scope, ...Array.from(scope.querySelectorAll("*"))] : Array.from(scope.querySelectorAll("cite"));
      for (const el of els) {
        const t = clean((el as HTMLElement).innerText);
        if (t && t.length < 200 && crumbRe.test(t)) return t;
      }
    }
    return null;
  };
  const claimed = new Set<string>();
  const resolveOpaque = (a: Element): string | null => {
    // Evidence 1: the breadcrumb (host + path-ish parts). Some results show none.
    const crumb = breadcrumbFor(a);
    const parts = crumb
      ? crumb
          .split("›")
          .map((s) => s.trim().replace(/(\.\.\.|…)$/, "").toLowerCase())
          .filter(Boolean)
      : [];
    let host = "";
    if (parts.length) {
      try {
        host = new URL(/^https?:/i.test(parts[0]!) ? parts[0]! : `https://${parts[0]}`).hostname.replace(/^www\./, "");
      } catch {
        host = "";
      }
    }
    const segs = parts.slice(1).flatMap((s) => s.split(/\s+/)).filter((s) => s.length >= 2);
    // Evidence 2: the title's words, which URL slugs usually repeat.
    const heading = a.closest(HEADING) || a.querySelector(HEADING) || a;
    const words = Array.from(
      new Set(
        clean((heading as HTMLElement).innerText)
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length >= 3),
      ),
    );

    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [u, count] of urlsInPage()) {
      if (claimed.has(u)) continue;
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        continue;
      }
      const h = p.hostname.replace(/^www\./, "");
      if (host && h !== host) continue;
      let path = (p.pathname + p.search).toLowerCase();
      try {
        path = decodeURIComponent(path);
      } catch {
        // keep encoded
      }
      const segHits = segs.filter((s) => path.includes(s)).length;
      // Title words count only in the path: the host often repeats them (typescriptlang.org).
      const wordHits = words.filter((w) => path.includes(w)).length;
      if (host) {
        // Known host: breadcrumb or title must match, unless the breadcrumb is just the host.
        if (segs.length && !segHits && !wordHits) continue;
      } else if (wordHits < 3) {
        continue; // no breadcrumb: demand a strong title match
      }
      const score =
        segHits * 20 + wordHits * 8 + Math.min(count, 5) * 3 - u.length / 200 + (!segs.length && p.pathname === "/" ? 10 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    if (best) claimed.add(best);
    return best;
  };
  /** Absolute href of an engine-internal result link -> resolved destination. */
  const opaque: Record<string, string> = {};
  /** Result links whose destination is not in the page; resolved later by following them. */
  const unresolved = new Set<string>();
  const destination = (a: HTMLAnchorElement): string | null => {
    const target = unwrap(a.getAttribute("href") || "", base, opts.internalHost);
    if (!target) return null;
    let host = "";
    try {
      host = new URL(target).hostname;
    } catch {
      return null;
    }
    if (!internalRe.test(host)) return target;
    // Internal link: only worth resolving if it is a result title.
    if (!a.closest(HEADING) && !a.querySelector(HEADING)) return null;
    if (opaque[a.href]) return opaque[a.href]!;
    if (unresolved.has(a.href)) return a.href;
    const resolved = resolveOpaque(a);
    if (resolved) {
      opaque[a.href] = resolved;
      return resolved;
    }
    // Keep it as a candidate under its own (engine) address for now.
    unresolved.add(a.href);
    return a.href;
  };

  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const fonts: number[] = [];
  const linkInfo: { a: HTMLAnchorElement; url: string; rect: DOMRect; font: number }[] = [];
  for (const el of anchors) {
    const a = el as HTMLAnchorElement;
    if (a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]')) {
      continue;
    }
    const rect = visibleRect(a);
    if (!rect || rect.top + scrollY > opts.maxTop) continue;
    const target = destination(a);
    if (!target) continue;
    const font = parseFloat(getComputedStyle(a).fontSize) || 0;
    if (clean(a.innerText)) fonts.push(font);
    linkInfo.push({ a, url: target, rect, font });
  }
  fonts.sort((x, y) => x - y);
  const baseFont = fonts.length ? fonts[Math.floor(fonts.length / 2)]! : 14;

  const byUrl = new Map<string, Cand>();
  for (const { a, url, rect } of linkInfo) {
    const outer = a.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const inner = a.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const heading = outer || inner;
    let titleEl: Element = heading || a;
    let font = parseFloat(getComputedStyle(titleEl).fontSize) || 0;
    if (!heading) {
      // No heading markup: the title is the largest text inside the link
      // (e.g. a big <span> next to a small breadcrumb).
      for (const el of Array.from(a.querySelectorAll("*"))) {
        if (!clean((el as HTMLElement).innerText)) continue;
        const f = parseFloat(getComputedStyle(el).fontSize) || 0;
        if (f > font) {
          font = f;
          titleEl = el;
        }
      }
    }
    const title = clean((titleEl as HTMLElement).innerText);
    if (title.length < 3 || /^https?:\/\//i.test(title)) continue;
    // Heading markup counts most; otherwise the title must *look* like one.
    const score = heading ? 2 : font >= baseFont * 1.15 ? 1 : 0;
    if (score === 0) continue;
    // Column position: the left edge of the enclosing block, not of the link
    // itself (an inline link's x depends on whatever text precedes it).
    let block: Element = titleEl;
    while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    const blockRect = block.getBoundingClientRect();
    const pos = new DOMRect(blockRect.left, rect.top, rect.width, rect.height);
    const prev = byUrl.get(url);
    if (!prev || score > prev.score || (score === prev.score && font > prev.font)) {
      byUrl.set(url, { url, title, titleEl, rect: pos, score, font });
    }
  }
  let cands = Array.from(byUrl.values());

  // Horizontal carousels (videos, top stories): 3+ titles on one row. Checked
  // before the column filter, which would otherwise keep a carousel's first card.
  const rowKey = (c: Cand) => Math.round(c.rect.top / 8);
  const rows = new Map<number, number>();
  for (const c of cands) rows.set(rowKey(c), (rows.get(rowKey(c)) || 0) + 1);
  cands = cands.filter((c) => (rows.get(rowKey(c)) || 0) < 3);

  // Main column: the left edge shared by the most titles in the upper page.
  const buckets = new Map<number, number>();
  for (const c of cands) {
    const key = Math.round(c.rect.left / 24);
    const weight = c.rect.top + scrollY < 4000 ? 1 : 0.5;
    buckets.set(key, (buckets.get(key) || 0) + weight);
  }
  let column: number | null = null;
  let best = 0;
  for (const [key, w] of buckets) {
    if (w > best) {
      best = w;
      column = key * 24;
    }
  }
  if (column !== null) {
    const colLeft = Math.min(...cands.filter((c) => Math.abs(c.rect.left - column!) <= 24).map((c) => c.rect.left));
    // Indented entries (sitelinks under a result) sit to the right; drop them.
    cands = cands.filter((c) => c.rect.left >= colLeft - 8 && c.rect.left <= colLeft + 16);
  }

  cands.sort((x, y) => x.rect.top - y.rect.top);
  const titleEls = cands.map((c) => c.titleEl);

  const visual: RawResult[] = [];
  for (const c of cands) {
    // Result box: grow upwards until the next ancestor would include another result.
    let box: Element = c.titleEl;
    while (box.parentElement && box.parentElement !== document.body) {
      const p: Element = box.parentElement;
      if (titleEls.some((o) => o !== c.titleEl && p.contains(o))) break;
      if (p.getBoundingClientRect().height > 700) break;
      box = p;
    }
    const lines = ((box as HTMLElement).innerText || "")
      .split("\n")
      .map(clean)
      .filter(Boolean);
    // Ads are labeled for people; use the label, not the markup.
    if (lines.some((l) => /^(sponsored|ad|ads)(\s*[·•:].*)?$/i.test(l)) || box.querySelector('[aria-label="Ads"], [aria-label="Ad"]')) {
      continue;
    }
    // Remove the title, then a leading URL/domain and breadcrumb, from each
    // line; what is left and long enough is the snippet.
    const snippetLines = lines
      .map((l) =>
        l
          .split(c.title)
          .join(" ")
          .replace(/^\s*(https?:\/\/\S+|[\w-]+(\.[\w-]+)+)((\s*›\s*[^\s›]+)*)\s*/i, "")
          .trim(),
      )
      .filter((l) => l.length >= 30 && !l.includes("›"));
    visual.push({ url: c.url, title: c.title, snippet: snippetLines.join(" ").slice(0, 500) });
  }

  // ---------- strategy: selectors ----------
  const selected: RawResult[] = [];
  for (const table of opts.selectors) {
    let items: Element[] = [];
    try {
      items = Array.from(document.querySelectorAll(table.item));
    } catch {
      continue;
    }
    for (const item of items) {
      const titleEl = item.querySelector(table.title);
      if (!titleEl) continue;
      const link = (titleEl.closest("a[href]") || titleEl.querySelector("a[href]") || item.querySelector("a[href]")) as HTMLAnchorElement | null;
      if (!link) continue;
      const url = destination(link);
      if (!url) continue;
      const snippetEl = item.querySelector(table.snippet);
      selected.push({
        url,
        title: clean((titleEl as HTMLElement).innerText),
        snippet: clean(snippetEl ? (snippetEl as HTMLElement).innerText : "").slice(0, 500),
      });
    }
    if (selected.length) break;
  }

  return {
    visual,
    selectors: selected,
    opaque,
    unresolved: Array.from(unresolved),
    signals: { url: location.href, title: document.title, challenge, consent, noResults },
    debug: { anchors: anchors.length, candidates: byUrl.size, column },
  };
}

/** The expression sent to Runtime.evaluate. */
export function serpInPageExpression(opts: InPageOptions): string {
  return `(${serpInPage.toString()})(${JSON.stringify(opts)}, ${unwrapTarget.toString()})`;
}
