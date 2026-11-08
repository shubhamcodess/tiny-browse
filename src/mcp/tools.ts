import type { Config } from "../config.js";
import type { CallContext, Engine, EngineResult, Freshness, RenderMode } from "../core/engine.js";
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

const FRESHNESS: readonly Freshness[] = ["any", "day", "week", "month", "year"];
const RENDER: readonly RenderMode[] = ["auto", "http", "browser"];

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
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "What to search for, in plain words. Google operators like site: and \"quotes\" work.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: config.search.maxResults,
          description: "How many search results to consider.",
        },
        read: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          default: config.search.read,
          description: "How many of the top results to open and read. 0 returns only titles, URLs and snippets.",
        },
        max_tokens: {
          type: "integer",
          minimum: 200,
          maximum: 200_000,
          default: config.output.maxTokens,
          description: "Approximate size limit for the whole answer, in tokens.",
        },
        site: {
          type: "string",
          minLength: 1,
          description: "Only return results from this domain, e.g. \"docs.python.org\".",
        },
        freshness: {
          type: "string",
          enum: FRESHNESS,
          default: "any",
          description: "Only return results published within this period.",
        },
        return_images: {
          type: "boolean",
          default: false,
          description: "Also return the main images of the pages read (for vision models).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true },
    run(args, ctx) {
      const query = String(args.query).trim();
      const returnImages = (args.return_images as boolean | undefined) ?? false;
      const maxTokens = (args.max_tokens as number | undefined) ?? config.output.maxTokens;
      if (isHttpUrl(query)) {
        return engine.fetch({ urls: [query], maxTokens, render: "auto", returnImages }, ctx);
      }
      return engine.search(
        {
          query,
          maxResults: (args.max_results as number | undefined) ?? config.search.maxResults,
          read: (args.read as number | undefined) ?? config.search.read,
          maxTokens,
          site: args.site as string | undefined,
          freshness: (args.freshness as Freshness | undefined) ?? "any",
          returnImages,
        },
        ctx,
      );
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
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string", format: "uri" },
          minItems: 1,
          maxItems: 10,
          description: "Absolute http(s) URLs to read.",
        },
        max_tokens: {
          type: "integer",
          minimum: 200,
          maximum: 200_000,
          default: 8000,
          description: "Approximate size limit for the whole answer, in tokens.",
        },
        focus: {
          type: "string",
          minLength: 1,
          description: "Optional question or topic; only the most relevant sections are returned.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description: "Continue a page that was cut short, using the cursor from a previous result.",
        },
        render: {
          type: "string",
          enum: RENDER,
          default: "auto",
          description: "auto picks the fastest way that works; browser forces Chrome; http skips Chrome.",
        },
        return_images: {
          type: "boolean",
          default: false,
          description: "Also return the page's main images (for vision models).",
        },
      },
      required: ["urls"],
      additionalProperties: false,
    },
    annotations: { title: "Read web pages", readOnlyHint: true, openWorldHint: true },
    run(args, ctx) {
      return engine.fetch(
        {
          urls: args.urls as string[],
          maxTokens: (args.max_tokens as number | undefined) ?? 8000,
          focus: args.focus as string | undefined,
          cursor: args.cursor as string | undefined,
          render: (args.render as RenderMode | undefined) ?? "auto",
          returnImages: (args.return_images as boolean | undefined) ?? false,
        },
        ctx,
      );
    },
  };

  return [webSearch, webFetch];
}
