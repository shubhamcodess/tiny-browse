/**
 * Read one search results page with three independent strategies, merge them
 * by voting, and judge whether the outcome is healthy.
 */
import type { Page } from "../browser/page.js";
import { serpInPageExpression, type InPageOutput } from "./inpage.js";
import type { ProviderDef } from "./providers.js";
import type { RedirectResolver } from "./redirects.js";
import type { PageSignals, RawResult, SerpResult, SerpStatus, StrategyName, StrategyOutput } from "./types.js";
import { isInternal, normalizeUrl, unwrapTarget } from "./urls.js";

interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  properties?: { name: string; value?: { value?: unknown } }[];
}

/**
 * Strategy "accessibility": links whose parent or child is a heading, read
 * from Chrome's accessibility tree. Screen-reader semantics change far less
 * often than markup.
 */
export function resultsFromAxTree(
  nodes: AxNode[],
  pageUrl: string,
  internalHost: string,
  opaque: Record<string, string> = {},
): RawResult[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const isHeading = (n?: AxNode) => n?.role?.value === "heading";
  const out: RawResult[] = [];
  for (const n of nodes) {
    if (n.ignored || n.role?.value !== "link") continue;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const grand = parent?.parentId ? byId.get(parent.parentId) : undefined;
    const childHeading = (n.childIds ?? []).map((id) => byId.get(id)).find(isHeading);
    if (!isHeading(parent) && !isHeading(grand) && !childHeading) continue;
    const href = n.properties?.find((p) => p.name === "url")?.value?.value;
    if (typeof href !== "string") continue;
    const url = opaque[href] ?? unwrapTarget(href, pageUrl, internalHost);
    if (!url || isInternal(url, internalHost)) continue;
    const title = String(childHeading?.name?.value ?? n.name?.value ?? "").replace(/\s+/g, " ").trim();
    if (title.length < 3) continue;
    out.push({ url, title, snippet: "" });
  }
  return out;
}

/** Replace result URLs found in `map` (opaque link -> destination). */
export function remapUrls(outputs: StrategyOutput[], map: Record<string, string>): StrategyOutput[] {
  if (!Object.keys(map).length) return outputs;
  return outputs.map((o) => ({ ...o, results: o.results.map((r) => (map[r.url] ? { ...r, url: map[r.url]! } : r)) }));
}

export interface MergeOutput {
  results: SerpResult[];
  counts: Record<StrategyName, number>;
}

/**
 * Merge strategies by URL. With two or more strategies producing results, a
 * result needs two votes; with only one working strategy we trust it (that is
 * exactly the case the redundancy exists for).
 */
export function mergeStrategies(outputs: StrategyOutput[], internalHost: string): MergeOutput {
  const counts = { visual: 0, accessibility: 0, selectors: 0 } as Record<StrategyName, number>;
  type Entry = { url: string; titles: Partial<Record<StrategyName, string>>; snippets: string[]; ranks: Partial<Record<StrategyName, number>> };
  const entries = new Map<string, Entry>();

  for (const out of outputs) {
    const seen = new Set<string>();
    let rank = 0;
    for (const r of out.results) {
      if (!r.url || isInternal(r.url, internalHost)) continue;
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      let e = entries.get(key);
      if (!e) entries.set(key, (e = { url: r.url, titles: {}, snippets: [], ranks: {} }));
      e.titles[out.name] = r.title;
      if (r.snippet) e.snippets.push(r.snippet);
      e.ranks[out.name] = rank;
    }
    counts[out.name] = seen.size;
  }

  const working = (Object.keys(counts) as StrategyName[]).filter((k) => counts[k] >= 3);
  const needed = working.length >= 2 ? 2 : 1;
  // Order by the most trusted strategy that saw the result.
  const order: StrategyName[] = ["visual", "selectors", "accessibility"];

  const kept = [...entries.values()].filter((e) => {
    const votes = Object.keys(e.ranks).length;
    if (votes >= needed) return true;
    // A lone vote is enough from a strategy that is the only working one.
    return needed === 1;
  });

  kept.sort((a, b) => {
    for (const s of order) {
      const ra = a.ranks[s];
      const rb = b.ranks[s];
      if (ra !== undefined && rb !== undefined) return ra - rb;
    }
    return avgRank(a.ranks) - avgRank(b.ranks);
  });

  const results = kept.map((e, i) => ({
    rank: i + 1,
    url: e.url,
    title: e.titles.visual ?? e.titles.selectors ?? e.titles.accessibility ?? "",
    snippet: e.snippets.sort((x, y) => y.length - x.length)[0] ?? "",
    foundBy: order.filter((s) => e.ranks[s] !== undefined),
  }));
  return { results, counts };
}

function avgRank(ranks: Partial<Record<StrategyName, number>>): number {
  const v = Object.values(ranks);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Infinity;
}

const STOPWORDS = new Set(
  "the and for with what how why when where who which from into that this are was were does did not you your can about vs versus between best top".split(" "),
);

/** Distinct words of a query worth checking for (no operators, no stopwords). */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/\b(site|inurl|intitle|filetype):\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * How well results match the query: the best single result's share of query
 * terms, and the average share. Engines that distrust automation sometimes
 * serve plausible-looking but unrelated results; this catches that.
 */
export function relevance(query: string, results: SerpResult[]): { best: number; mean: number } {
  const terms = queryTerms(query);
  if (!terms.length || !results.length) return { best: 1, mean: 1 };
  const shares = results.map((r) => {
    const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    return terms.filter((t) => text.includes(t)).length / terms.length;
  });
  return { best: Math.max(...shares), mean: shares.reduce((a, b) => a + b, 0) / shares.length };
}

/** Decide what this page is. */
export function judge(signals: PageSignals, results: SerpResult[], query?: string): SerpStatus {
  if (signals.challenge) return "challenge";
  if (results.length === 0 && signals.consent) return "consent";
  if (results.length === 0 && signals.noResults) return "no_results";
  if (results.length < 3) return signals.noResults ? "no_results" : "unhealthy";
  const titles = new Set(results.map((r) => r.title.toLowerCase()));
  if (titles.size / results.length < 0.7) return "unhealthy";
  if (query) {
    const { best, mean } = relevance(query, results);
    if (best < 0.6 && mean < 0.35) return "off_topic";
  }
  return "ok";
}

export interface ReadSerpResult {
  status: SerpStatus;
  results: SerpResult[];
  signals: PageSignals;
  strategies: Record<StrategyName, number>;
}

/**
 * Read a SERP already loaded in `page`. Polls briefly so we can start as
 * soon as results exist instead of waiting for the page to finish loading.
 */
export async function readSerp(
  page: Page,
  provider: ProviderDef,
  opts: {
    settleMs?: number;
    signal?: AbortSignal;
    query?: string;
    resolve?: RedirectResolver;
    /** How many results the caller needs; only that many opaque links are followed. */
    limit?: number;
  } = {},
): Promise<ReadSerpResult> {
  const expr = serpInPageExpression({ internalHost: provider.internalHost, selectors: provider.selectors, maxTop: 12_000 });
  const deadline = Date.now() + (opts.settleMs ?? 2500);
  const limit = opts.limit ?? 10;
  let inPage: InPageOutput | undefined;
  let lastError: Error | undefined;
  for (;;) {
    try {
      inPage = await page.evaluate<InPageOutput>(expr);
      const s = inPage.signals;
      if (s.challenge || s.consent || s.noResults) break;
      // Ready when there are enough results and their destinations are known
      // (engines stream the data that resolves opaque links after first paint).
      const resolvedTop = inPage.visual.slice(0, limit).filter((r) => !inPage!.unresolved.includes(r.url)).length;
      if (inPage.visual.length >= 5 && resolvedTop >= Math.min(limit, inPage.visual.length) - 1) break;
    } catch (err) {
      // The page navigated while we read it (e.g. a redirect to a CAPTCHA): try again.
      lastError = err as Error;
    }
    if (Date.now() >= deadline || opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!inPage) throw lastError ?? new Error("could not read the results page");

  // Opaque result links the page gives no destination for: follow the ones we need.
  let followed: Record<string, string> = {};
  if (inPage.unresolved.length && opts.resolve && !inPage.signals.challenge) {
    const needed = inPage.visual
      .slice(0, limit + 2)
      .map((r) => r.url)
      .filter((u) => inPage!.unresolved.includes(u));
    if (needed.length) followed = await opts.resolve(needed);
  }

  let ax: RawResult[] = [];
  let axError: string | undefined;
  try {
    const { nodes } = await page.cdp<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
    ax = resultsFromAxTree(nodes, inPage.signals.url, provider.internalHost, { ...inPage.opaque, ...followed });
  } catch (err) {
    axError = (err as Error).message;
  }

  const strategies: StrategyOutput[] = [
    { name: "visual", results: inPage.visual },
    { name: "accessibility", results: ax, error: axError },
    { name: "selectors", results: inPage.selectors },
  ];
  // Links still unresolved stay engine-internal and are dropped by the merge.
  const merged = mergeStrategies(remapUrls(strategies, followed), provider.internalHost);
  return {
    status: judge(inPage.signals, merged.results, opts.query),
    results: merged.results,
    signals: inPage.signals,
    strategies: merged.counts,
  };
}
