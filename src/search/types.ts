import type { SearchProviderName } from "../config.js";

/** One result as seen by a single extraction strategy. */
export interface RawResult {
  url: string;
  title: string;
  snippet: string;
}

export type StrategyName = "visual" | "accessibility" | "selectors";

export interface StrategyOutput {
  name: StrategyName;
  results: RawResult[];
  /** Set if the strategy itself failed (e.g. script error). */
  error?: string;
}

export interface SerpResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  /** Strategies that found this result. */
  foundBy: StrategyName[];
}

/** What the page is, independent of the results we parsed from it. */
export interface PageSignals {
  url: string;
  title: string;
  challenge: boolean;
  consent: boolean;
  noResults: boolean;
}

export type SerpStatus =
  | "ok" // healthy results
  | "no_results" // the engine says there are none
  | "challenge" // CAPTCHA / bot check
  | "consent" // cookie consent wall
  | "unhealthy" // page loaded but parsing looks wrong (layout drift?)
  | "off_topic" // results don't match the query (engine serving degraded results?)
  | "error"; // navigation or other failure

export interface SerpPage {
  provider: SearchProviderName;
  status: SerpStatus;
  results: SerpResult[];
  signals?: PageSignals;
  /** Result count per strategy, for diagnosing drift. */
  strategies: Record<StrategyName, number>;
  ms: number;
  error?: string;
}

export interface SearchOptions {
  site?: string;
  freshness: "any" | "day" | "week" | "month" | "year";
  maxResults: number;
}
