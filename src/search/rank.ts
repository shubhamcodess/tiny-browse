/**
 * Decide which search results are worth reading. The engine's order is the
 * main signal; on top of it: how well title and snippet match the query, a
 * small built-in preference for primary sources, and the user's own
 * ranking.prefer / ranking.block lists.
 */
import { terms } from "../extract/chunk.js";
import type { SerpResult } from "./types.js";
import { hostOf } from "./urls.js";

/** Small nudges, not a whitelist: primary sources up, content farms down. */
const BUILT_IN: [RegExp, number][] = [
  [/(^|\.)wikipedia\.org$/, 0.15],
  [/^developer\.mozilla\.org$/, 0.2],
  [/^docs\.|\.readthedocs\.io$|^learn\.microsoft\.com$|^docs\.python\.org$/, 0.2],
  [/(^|\.)github\.com$/, 0.1],
  [/(^|\.)stackoverflow\.com$|\.stackexchange\.com$/, 0.1],
  [/\.(gov|edu)$|(^|\.)rfc-editor\.org$|(^|\.)ietf\.org$|(^|\.)w3\.org$/, 0.15],
  [/(^|\.)pinterest\.[a-z.]+$|(^|\.)quora\.com$|(^|\.)facebook\.com$|(^|\.)instagram\.com$|(^|\.)tiktok\.com$/, -0.3],
];

export interface RankOptions {
  prefer: string[];
  block: string[];
}

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith(`.${d}`);
}

export function isBlocked(url: string, block: string[]): boolean {
  const host = hostOf(url);
  return block.some((d) => matchesDomain(host, d));
}

export function scoreResult(r: SerpResult, query: string, opts: RankOptions): number {
  const host = hostOf(r.url);
  const q = new Set(terms(query));
  const text = new Set(terms(`${r.title} ${r.snippet} ${host} ${safePath(r.url)}`));
  const coverage = q.size ? [...q].filter((t) => text.has(t)).length / q.size : 0;
  let prior = 0;
  for (const [re, w] of BUILT_IN) if (re.test(host)) prior += w;
  if (opts.prefer.some((d) => matchesDomain(host, d))) prior += 0.5;
  return 1 / Math.log2(r.rank + 1) + coverage * 0.6 + prior;
}

/** Results to read: best scored first, one per site, `n` of them. */
export function pickToRead(results: SerpResult[], query: string, n: number, opts: RankOptions): SerpResult[] {
  const seen = new Set<string>();
  return results
    .filter((r) => !isBlocked(r.url, opts.block))
    .map((r) => ({ r, s: scoreResult(r, query, opts) }))
    .sort((a, b) => b.s - a.s)
    .filter(({ r }) => {
      const host = hostOf(r.url);
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .slice(0, n)
    .map(({ r }) => r);
}

function safePath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, " ");
  } catch {
    return "";
  }
}
