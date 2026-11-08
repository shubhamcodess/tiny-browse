/** Render a search outcome (and any pages read) as Markdown for the model and JSON for code. */
import { docSection, type ReadDoc } from "../core/read.js";
import { PROVIDERS } from "./providers.js";
import type { SearchOutcome } from "./search.js";
import type { SerpResult } from "./types.js";
import { hostOf } from "./urls.js";

/** Pages read, keyed by result rank. */
export type DocsByRank = Map<number, ReadDoc>;

export function searchMarkdown(query: string, outcome: SearchOutcome, docs: DocsByRank = new Map()): string {
  const { page, attempts } = outcome;
  const label = PROVIDERS[page.provider].label;
  const fallbacks = attempts
    .filter((a) => a.provider !== page.provider)
    .map((a) => `${PROVIDERS[a.provider].label} ${a.status === "skipped" ? "skipped" : "unavailable"}: ${a.note ?? a.status}`);
  const meta = [
    label,
    `${page.results.length} result${page.results.length === 1 ? "" : "s"}`,
    docs.size ? `${[...docs.values()].filter((d) => d.ok).length} read` : "",
    outcome.cached ? "cached" : `${(page.ms / 1000).toFixed(1)} s`,
    ...fallbacks,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`# Search: ${query}`, meta, ""];
  if (outcome.warning) lines.push(`> **Warning:** ${outcome.warning}`, "");
  if (page.status === "no_results" || page.results.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }

  if (docs.size) {
    for (const r of page.results) {
      const doc = docs.get(r.rank);
      if (!doc) continue;
      lines.push(docSection(doc, `## [${r.rank}] ${doc.ok ? doc.title : r.title}`));
    }
    const rest = page.results.filter((r) => !docs.has(r.rank));
    if (rest.length) {
      lines.push("## Other results", "");
      for (const r of rest) lines.push(resultLine(r), "");
    }
  } else {
    for (const r of page.results) lines.push(resultLine(r), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function resultLine(r: SerpResult): string {
  const snippet = r.snippet ? ` — ${r.snippet}` : "";
  return `${r.rank}. [${escapeLinkText(r.title)}](${r.url})\n   ${hostOf(r.url)}${snippet}`;
}

export function searchData(query: string, outcome: SearchOutcome, docs: DocsByRank = new Map()): Record<string, unknown> {
  const { page } = outcome;
  return {
    query,
    provider: page.provider,
    status: page.status,
    cached: outcome.cached,
    warning: outcome.warning,
    attempts: outcome.attempts,
    strategies: page.strategies,
    results: page.results.map(({ rank, title, url, snippet, foundBy }) => {
      const doc = docs.get(rank);
      return { rank, title, url, snippet, foundBy, read: !!doc, doc: doc ? docData(doc) : undefined };
    }),
  };
}

export function docData(d: ReadDoc): Record<string, unknown> {
  return {
    url: d.url,
    finalUrl: d.finalUrl,
    title: d.title,
    ok: d.ok,
    error: d.error,
    markdown: d.markdown,
    tokens: d.tokens,
    truncated: d.truncated,
    remainingTokens: d.remainingTokens,
    cursor: d.cursor,
    focus: d.focus,
    cached: d.cached,
    quality: d.quality,
    ms: d.ms,
    tier: d.tier,
    images: d.images,
    meta: d.meta,
  };
}

function escapeLinkText(s: string): string {
  return s.replace(/([[\]\\])/g, "\\$1");
}
