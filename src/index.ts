/**
 * tiny-browse as a library.
 *
 *   import { webSearch, webFetch, createClient } from "@shubhamcodess/tiny-browse";
 *
 * Importing has no side effects: no files are written, no Chrome is started,
 * nothing is logged. The exported functions and types are a public API
 * covered by semver.
 */
export {
  createClient,
  doctor,
  webFetch,
  webSearch,
  type CallOptions,
  type Client,
  type ClientOptions,
  type DoctorCheck,
  type FetchResult,
  type Image,
  type Page,
  type PageFailure,
  type SearchHit,
  type SearchResult,
  type TinyBrowseConfig,
} from "./client.js";
export type { WebFetchInput, WebSearchInput } from "./core/inputs.js";
export type { Freshness, RenderMode } from "./core/engine.js";
export { TinyBrowseError, type TinyBrowseErrorCode } from "./errors.js";
export type { Logger, LogLevel } from "./util/log.js";
export { VERSION } from "./version.js";
