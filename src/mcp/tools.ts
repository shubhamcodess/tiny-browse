import type { Config } from "../config.js";
import type { CallContext, Engine, EngineResult } from "../core/engine.js";
import { fetchInputSchema, searchInputSchema, toFetchRequest, toSearchRequest, type WebFetchInput, type WebSearchInput } from "../core/inputs.js";
import { isHttpUrl, type Schema } from "./schema.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: CallContext): Promise<EngineResult>;
}

export function buildTools(engine: Engine, config: Config): ToolDef[] {
  const webSearch: ToolDef = {
    name: "web_search",
    title: "Web search",
    description: [
      "Search the web and read the best results. Searches Google in the user's local Chrome",
      "(falls back to DuckDuckGo or Bing if Google is unavailable), opens the top results,",
      "and returns clean Markdown: Google's answer box if there is one, the most relevant",
      "sections of each page read (with its URL), and a short list of other results.",
      "Use it for anything that needs current or external information.",
      "If you already have a URL, call web_fetch instead (a URL given here is fetched directly).",
    ].join(" "),
    inputSchema: searchInputSchema(config),
    annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true },
    run(args, ctx) {
      const req = toSearchRequest(args as unknown as WebSearchInput, config);
      // A URL given as the query is read directly.
      if (isHttpUrl(req.query)) {
        return engine.fetch({ urls: [req.query], maxTokens: req.maxTokens, render: "auto", returnImages: req.returnImages }, ctx);
      }
      return engine.search(req, ctx);
    },
  };

  const webFetch: ToolDef = {
    name: "web_fetch",
    title: "Read web pages",
    description: [
      "Read one or more web pages by URL and return their main content as clean Markdown",
      "with the page's heading structure, tables, lists and code blocks kept, and menus,",
      "ads and other clutter removed. Set `focus` to a question to get only the most",
      "relevant sections. If a page was cut short, pass the returned `cursor` to read on.",
    ].join(" "),
    inputSchema: fetchInputSchema(),
    annotations: { title: "Read web pages", readOnlyHint: true, openWorldHint: true },
    run(args, ctx) {
      return engine.fetch(toFetchRequest(args as WebFetchInput), ctx);
    },
  };

  return [webSearch, webFetch];
}
