import { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { log } from "../util/log.js";
import { NotImplementedError, type CallContext, type Engine, type EngineResult, type FetchRequest, type SearchRequest } from "./engine.js";

/**
 * The real engine. M1: owns the Chrome session (eager start, spare tab, idle
 * shutdown). Search and extraction arrive in M2/M3.
 */
export class ChromeEngine implements Engine {
  readonly browser: Browser;

  constructor(private readonly config: Config) {
    this.browser = new Browser(config.browser);
  }

  start(): void {
    if (!this.config.browser.eager) return;
    // Background: never delays the MCP handshake. Failures are retried on first use.
    this.browser.warm().catch((err: Error) => log.warn(`could not start Chrome yet: ${err.message}`));
  }

  async search(_req: SearchRequest, _ctx: CallContext): Promise<EngineResult> {
    throw new NotImplementedError("web_search is not implemented yet (tiny-browse milestone M1: Chrome connection only).");
  }

  async fetch(_req: FetchRequest, _ctx: CallContext): Promise<EngineResult> {
    throw new NotImplementedError("web_fetch is not implemented yet (tiny-browse milestone M1: Chrome connection only).");
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
