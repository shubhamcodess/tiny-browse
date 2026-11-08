/**
 * The one source of truth for tool inputs: the JSON Schemas the MCP tools
 * advertise, the TypeScript types the library exports, and the conversion to
 * engine requests. Change a parameter here and every surface follows.
 */
import type { Config } from "../config.js";
import type { Schema } from "../mcp/schema.js";
import type { FetchRequest, Freshness, RenderMode, SearchRequest } from "./engine.js";
import { ToolInputError } from "./engine.js";

export const FRESHNESS: readonly Freshness[] = ["any", "day", "week", "month", "year"];
export const RENDER: readonly RenderMode[] = ["auto", "http", "browser"];

/** Input of `web_search` (MCP) and `webSearch()` (library). */
export interface WebSearchInput {
  /** What to search for, in plain words. Google operators like site: and "quotes" work. */
  query: string;
  /** How many search results to consider (1-10). */
  max_results?: number;
  /** How many of the top results to open and read (0-10). 0 returns only the result list. */
  read?: number;
  /** Size limit for the whole answer, in tokens (200-200000). A hard limit. */
  max_tokens?: number;
  /** Only return results from this domain, e.g. "docs.python.org". */
  site?: string;
  /** Only return results published within this period. */
  freshness?: Freshness;
  /** Also return the main images of the pages read (for vision models). */
  return_images?: boolean;
}

/** Input of `web_fetch` (MCP) and `webFetch()` (library). Give `urls` or `cursor`. */
export interface WebFetchInput {
  /** Absolute http(s) URLs to read (1-10). */
  urls?: string[];
  /** Size limit for the whole answer, in tokens (200-200000). A hard limit. */
  max_tokens?: number;
  /** Return only the sections most relevant to this question. */
  focus?: string;
  /** Continue a page that was cut short, using the cursor from a previous result. */
  cursor?: string;
  /** auto picks the fastest way that works; browser forces Chrome; http skips Chrome. */
  render?: RenderMode;
  /** Also return the pages' main images (for vision models). */
  return_images?: boolean;
}

const MAX_TOKENS: Schema = { type: "integer", minimum: 200, maximum: 200_000, description: "Approximate size limit for the whole answer, in tokens." };

export function searchInputSchema(config: Config): Schema {
  return {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: 'What to search for, in plain words. Google operators like site: and "quotes" work.',
      },
      max_results: { type: "integer", minimum: 1, maximum: 10, default: config.search.maxResults, description: "How many search results to consider." },
      read: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        default: config.search.read,
        description: "How many of the top results to open and read. 0 returns only titles, URLs and snippets.",
      },
      max_tokens: { ...MAX_TOKENS, default: config.output.maxTokens },
      site: { type: "string", minLength: 1, description: 'Only return results from this domain, e.g. "docs.python.org".' },
      freshness: { type: "string", enum: FRESHNESS, default: "any", description: "Only return results published within this period." },
      return_images: { type: "boolean", default: false, description: "Also return the main images of the pages read (for vision models)." },
    },
    required: ["query"],
    additionalProperties: false,
  };
}

export const FETCH_DEFAULT_MAX_TOKENS = 8000;

export function fetchInputSchema(): Schema {
  return {
    type: "object",
    properties: {
      urls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 10, description: "Absolute http(s) URLs to read." },
      max_tokens: { ...MAX_TOKENS, default: FETCH_DEFAULT_MAX_TOKENS },
      focus: { type: "string", minLength: 1, description: "Optional question or topic; only the most relevant sections are returned." },
      cursor: { type: "string", minLength: 1, description: "Continue a page that was cut short, using the cursor from a previous result." },
      render: { type: "string", enum: RENDER, default: "auto", description: "auto picks the fastest way that works; browser forces Chrome; http skips Chrome." },
      return_images: { type: "boolean", default: false, description: "Also return the page's main images (for vision models)." },
    },
    additionalProperties: false,
  };
}

/** Validated input -> engine request, with defaults from config. */
export function toSearchRequest(args: WebSearchInput, config: Config): SearchRequest {
  return {
    query: String(args.query).trim(),
    maxResults: args.max_results ?? config.search.maxResults,
    read: args.read ?? config.search.read,
    maxTokens: args.max_tokens ?? config.output.maxTokens,
    site: args.site,
    freshness: args.freshness ?? "any",
    returnImages: args.return_images ?? false,
  };
}

export function toFetchRequest(args: WebFetchInput): FetchRequest {
  const urls = args.urls ?? [];
  if (!urls.length && !args.cursor) {
    throw new ToolInputError("web_fetch needs `urls` (one or more absolute URLs) or a `cursor` from a previous result");
  }
  return {
    urls,
    maxTokens: args.max_tokens ?? FETCH_DEFAULT_MAX_TOKENS,
    focus: args.focus,
    cursor: args.cursor,
    render: args.render ?? "auto",
    returnImages: args.return_images ?? false,
  };
}
