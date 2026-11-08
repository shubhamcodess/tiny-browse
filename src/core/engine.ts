/**
 * The engine does the actual work (search, fetch, extract, rank). Transports
 * (MCP, CLI, later HTTP) only translate to and from these types.
 */

export type Freshness = "any" | "day" | "week" | "month" | "year";
export type RenderMode = "auto" | "http" | "browser";

export interface SearchRequest {
  query: string;
  maxResults: number;
  read: number;
  maxTokens: number;
  site?: string;
  freshness: Freshness;
  returnImages: boolean;
}

export interface FetchRequest {
  urls: string[];
  maxTokens: number;
  focus?: string;
  cursor?: string;
  render: RenderMode;
  returnImages: boolean;
}

export interface ImageBlob {
  id: string;
  mimeType: string;
  /** base64 */
  data: string;
}

export interface EngineResult {
  /** What the model reads. */
  markdown: string;
  /** Machine-readable form of the same result. */
  data: Record<string, unknown>;
  /** Image bytes for vision models (only when images were requested). */
  images?: ImageBlob[];
}

export interface CallContext {
  signal: AbortSignal;
}

export interface Engine {
  /** Start background work (e.g. eager browser launch). Must not block. */
  start(): void;
  search(req: SearchRequest, ctx: CallContext): Promise<EngineResult>;
  fetch(req: FetchRequest, ctx: CallContext): Promise<EngineResult>;
  close(): Promise<void>;
}

export class NotImplementedError extends Error {
  override name = "NotImplementedError";
}

/** M0 placeholder: every operation reports that it is not built yet. */
export class StubEngine implements Engine {
  start(): void {}

  async search(_req: SearchRequest, _ctx: CallContext): Promise<EngineResult> {
    throw new NotImplementedError("web_search is not implemented yet (tiny-browse is in early development, milestone M0).");
  }

  async fetch(_req: FetchRequest, _ctx: CallContext): Promise<EngineResult> {
    throw new NotImplementedError("web_fetch is not implemented yet (tiny-browse is in early development, milestone M0).");
  }

  async close(): Promise<void> {}
}
