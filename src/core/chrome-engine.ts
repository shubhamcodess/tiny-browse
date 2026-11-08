import { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { searchData, searchMarkdown } from "../search/format.js";
import { SearchService } from "../search/search.js";
import { ProviderState } from "../search/state.js";
import { log } from "../util/log.js";
import { NotImplementedError, type CallContext, type Engine, type EngineResult, type FetchRequest, type SearchRequest } from "./engine.js";

/**
 * The real engine. M2: search results through the provider chain. Reading
 * pages (web_fetch, `read`) arrives with extraction in M3.
 */
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
    return {
      markdown: searchMarkdown(req.query, outcome, { pagesRequested: req.read }),
      data: searchData(req.query, outcome),
    };
  }

  async fetch(_req: FetchRequest, _ctx: CallContext): Promise<EngineResult> {
    throw new NotImplementedError("web_fetch is not implemented yet (tiny-browse milestone M2: search results only).");
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
