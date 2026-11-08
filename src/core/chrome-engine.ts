import { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { estimateTokens } from "../extract/markdown.js";
import { docData, searchData, searchMarkdown, type DocsByRank } from "../search/format.js";
import { SearchService } from "../search/search.js";
import { ProviderState } from "../search/state.js";
import { hostOf } from "../search/urls.js";
import { log } from "../util/log.js";
import type { CallContext, Engine, EngineResult, FetchRequest, SearchRequest } from "./engine.js";
import { docSection, readMany } from "./read.js";

/** Smallest budget worth giving one page. */
const MIN_TOKENS_PER_DOC = 400;

export class ChromeEngine implements Engine {
  readonly browser: Browser;
  readonly searcher: SearchService;

  constructor(private readonly config: Config) {
    this.browser = new Browser(config.browser);
    this.searcher = new SearchService(this.browser, config, new ProviderState(config.cache.enabled ? config.cache.dir : undefined));
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

    const docs: DocsByRank = new Map();
    const results = outcome.page.results;
    if (req.read > 0 && results.length && outcome.page.status === "ok") {
      // One page per site, best ranked first.
      const seen = new Set<string>();
      const picks = results.filter((r) => {
        const host = hostOf(r.url);
        if (seen.has(host)) return false;
        seen.add(host);
        return true;
      }).slice(0, req.read);

      const listTokens = estimateTokens(searchMarkdown(req.query, outcome));
      const budget = Math.max(MIN_TOKENS_PER_DOC, Math.floor((req.maxTokens - listTokens) / Math.max(1, picks.length)));
      const read = await readMany(
        this.browser,
        this.config,
        picks.map((r) => ({ url: r.url, title: r.title })),
        { maxTokensEach: budget, titleLevel: 2, images: req.returnImages, signal: ctx.signal },
      );
      picks.forEach((r, i) => {
        if (read[i]) docs.set(r.rank, read[i]!);
      });
    }

    return {
      markdown: searchMarkdown(req.query, outcome, docs),
      data: searchData(req.query, outcome, docs),
    };
  }

  async fetch(req: FetchRequest, ctx: CallContext): Promise<EngineResult> {
    const each = Math.max(MIN_TOKENS_PER_DOC, Math.floor(req.maxTokens / req.urls.length));
    const docs = await readMany(
      this.browser,
      this.config,
      req.urls.map((url) => ({ url })),
      { maxTokensEach: each, titleLevel: 1, images: req.returnImages, signal: ctx.signal },
    );
    const sections = docs.map((d) => docSection(d, `# ${d.ok ? d.title : d.url}`));
    return {
      markdown: sections.join("\n---\n\n"),
      data: { documents: docs.map(docData) },
    };
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
