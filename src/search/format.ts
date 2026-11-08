/** Render a search outcome as Markdown for the model and JSON for code. */
import { PROVIDERS } from "./providers.js";
import type { SearchOutcome } from "./search.js";
import { hostOf } from "./urls.js";

export function searchMarkdown(query: string, outcome: SearchOutcome, opts: { pagesRequested: number }): string {
  const { page, attempts } = outcome;
  const label = PROVIDERS[page.provider].label;
  const fallbacks = attempts
    .filter((a) => a.provider !== page.provider)
    .map((a) => `${PROVIDERS[a.provider].label} ${a.status === "skipped" ? "skipped" : "unavailable"}: ${a.note ?? a.status}`);
  const meta = [
    label,
    `${page.results.length} result${page.results.length === 1 ? "" : "s"}`,
    outcome.cached ? "cached" : `${(page.ms / 1000).toFixed(1)} s`,
    ...fallbacks,
  ].join(" · ");

  const lines = [`# Search: ${query}`, meta, ""];
  if (outcome.warning) lines.push(`> **Warning:** ${outcome.warning}`, "");
  if (page.status === "no_results" || page.results.length === 0) {
    lines.push("No results found.");
    return lines.join("\n");
  }
  for (const r of page.results) {
    lines.push(`${r.rank}. [${escapeLinkText(r.title)}](${r.url})`);
    const snippet = r.snippet ? ` — ${r.snippet}` : "";
    lines.push(`   ${hostOf(r.url)}${snippet}`, "");
  }
  if (opts.pagesRequested > 0) {
    lines.push("_This tiny-browse version returns search results only; page contents are not included yet._");
  }
  return lines.join("\n").trimEnd();
}

export function searchData(query: string, outcome: SearchOutcome): Record<string, unknown> {
  const { page } = outcome;
  return {
    query,
    provider: page.provider,
    status: page.status,
    cached: outcome.cached,
    warning: outcome.warning,
    attempts: outcome.attempts,
    strategies: page.strategies,
    results: page.results.map(({ rank, title, url, snippet, foundBy }) => ({ rank, title, url, snippet, foundBy })),
  };
}

function escapeLinkText(s: string): string {
  return s.replace(/([[\]\\])/g, "\\$1");
}
