import { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { truncateToTokens } from "../extract/markdown.js";
import { TierHints } from "../fetch/hints.js";
import { docData, searchData, searchMarkdown, type DocsByRank } from "../search/format.js";
import { isBlocked, pickToRead } from "../search/rank.js";
import { SearchService } from "../search/search.js";
import { ProviderState } from "../search/state.js";
import { log } from "../util/log.js";
import { countTokens } from "../util/tokens.js";
import { decodeCursor } from "./cursor.js";
import { ToolInputError, type CallContext, type Engine, type EngineResult, type FetchRequest, type SearchRequest } from "./engine.js";
import { docSection, PageCache, readMany, type ReadRequest } from "./read.js";

/** Smallest share of the budget worth giving one page. */
const MIN_TOKENS_PER_DOC = 300;
/** Heading, untrusted-content markers and the "more on this page" note around each page. */
const PER_DOC_OVERHEAD = 90;

export class ChromeEngine implements Engine {
  readonly browser: Browser;
  readonly searcher: SearchService;
  readonly hints: TierHints;
  readonly pages = new PageCache();

  constructor(private readonly config: Config) {
    this.browser = new Browser(config.browser);
    const dir = config.cache.enabled ? config.cache.dir : undefined;
    this.hints = new TierHints(dir);
    this.searcher = new SearchService(this.browser, config, new ProviderState(dir));
  }

  start(): void {
    if (!this.config.browser.eager) return;
    // Background: never delays the MCP handshake. Failures are retried on first use.
    this.browser.warm().catch((err: Error) => log.warn(`could not start Chrome yet: ${err.message}`));
  }

  async search(req: SearchRequest, ctx: CallContext): Promise<EngineResult> {
    const outcome = await this.searcher.search(
      req.query,
      { site: req.site, freshness: req.freshness, maxResults: req.maxResults },
      ctx.signal,
    );
    const ranking = this.config.ranking;
    const page = outcome.page;
    page.results = page.results.filter((r) => !isBlocked(r.url, ranking.block));

    const docs: DocsByRank = new Map();
    if (req.read > 0 && page.results.length && page.status === "ok") {
      // Room left after the result list, then split between the pages read.
      const listTokens = countTokens(searchMarkdown(req.query, outcome));
      const available = req.maxTokens - listTokens;
      const n = Math.min(req.read, Math.floor(available / (MIN_TOKENS_PER_DOC + PER_DOC_OVERHEAD)));
      if (n > 0) {
        const picks = pickToRead(page.results, req.query, n, ranking);
        const each = Math.floor(available / picks.length) - PER_DOC_OVERHEAD;
        const read = await readMany(
          this.browser,
          this.config,
          // The query doubles as the focus: long pages keep their most relevant sections.
          picks.map((r) => ({ url: r.url, title: r.title, focus: req.query })),
          { maxTokensEach: each, titleLevel: 2, images: req.returnImages, render: "auto", hints: this.hints, cache: this.pages, signal: ctx.signal },
        );
        picks.forEach((r, i) => {
          if (read[i]) docs.set(r.rank, read[i]!);
        });
      }
    }

    return {
      markdown: capTokens(searchMarkdown(req.query, outcome, docs), req.maxTokens),
      data: searchData(req.query, outcome, docs),
    };
  }

  async fetch(req: FetchRequest, ctx: CallContext): Promise<EngineResult> {
    let reqs: ReadRequest[];
    if (req.cursor) {
      const c = decodeCursor(req.cursor);
      if (!c) throw new ToolInputError("this cursor is not valid; use the cursor exactly as returned by a previous web_fetch");
      reqs = [{ url: c.u, start: c.c }];
    } else {
      reqs = req.urls.map((url) => ({ url, focus: req.focus }));
    }
    // Each page gets its real share, so notes like the cursor always fit under max_tokens.
    const each = Math.max(100, Math.floor(req.maxTokens / reqs.length) - PER_DOC_OVERHEAD);
    const docs = await readMany(this.browser, this.config, reqs, {
      maxTokensEach: each,
      titleLevel: 1,
      images: req.returnImages,
      render: req.render,
      hints: this.hints,
      cache: this.pages,
      signal: ctx.signal,
    });
    const sections = docs.map((d) => docSection(d, `# ${d.ok ? d.title : d.url}`));
    return {
      markdown: capTokens(sections.join("\n---\n\n"), req.maxTokens),
      data: { documents: docs.map(docData) },
    };
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}

/** Hard ceiling: the whole answer never exceeds `max` tokens (as counted by util/tokens). */
export function capTokens(markdown: string, max: number): string {
  if (countTokens(markdown) <= max) return markdown;
  const note = "\n\n_[Output cut to fit max_tokens.]_\n";
  const cut = truncateToTokens(markdown, Math.max(20, max - countTokens(note)));
  // Close a code fence or untrusted-content marker the cut may have left open.
  let text = cut.text.trimEnd();
  if ((text.match(/^```/gm)?.length ?? 0) % 2 === 1) text += "\n```";
  const opened = text.match(/<!-- begin untrusted content/g)?.length ?? 0;
  const closed = text.match(/<!-- end untrusted content -->/g)?.length ?? 0;
  if (opened > closed) text += "\n<!-- end untrusted content -->";
  return text + note;
}
