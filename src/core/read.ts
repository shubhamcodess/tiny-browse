/**
 * Read several pages in parallel and fit each into its share of the token
 * budget: by sections, in order (with a cursor to continue), or the sections
 * most relevant to a question. Shared by web_fetch and web_search's `read`.
 */
import type { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { pack, splitDocument } from "../extract/chunk.js";
import { renderDocument, type ImageMode } from "../extract/markdown.js";
import { readUrl, type ReadResult, type RenderMode } from "../extract/reader.js";
import type { PageImage } from "../extract/types.js";
import type { TierHints } from "../fetch/hints.js";
import { hostOf } from "../search/urls.js";
import { encodeCursor } from "./cursor.js";

export interface ReadRequest {
  url: string;
  /** Title we expect (from search), for the quality score and as a fallback heading. */
  title?: string;
  /** Return the sections most relevant to this question. */
  focus?: string;
  /** Continue from this section (from a cursor). */
  start?: number;
}

export interface ReadDoc {
  url: string;
  finalUrl: string;
  title: string;
  ok: boolean;
  error?: string;
  markdown: string;
  tokens: number;
  truncated: boolean;
  remainingTokens: number;
  /** Pass to web_fetch to read the next sections. */
  cursor?: string;
  /** Set when sections were chosen for relevance to this question. */
  focus?: string;
  quality?: number;
  ms: number;
  /** Which way of reading produced this: plain HTTP (rendered offline) or a full Chrome load. */
  tier: "http" | "browser";
  /** True if served from the short-lived page cache. */
  cached: boolean;
  images: PageImage[];
  meta?: Record<string, string>;
}

export interface ReadManyOptions {
  maxTokensEach: number;
  /** Heading level for each document's title. */
  titleLevel: number;
  images: boolean;
  render: RenderMode;
  hints?: TierHints;
  cache?: PageCache;
  signal: AbortSignal;
}

/** Recently read pages, so cursors and repeated reads don't fetch again. */
export class PageCache {
  private readonly map = new Map<string, { at: number; r: ReadResult }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 64,
  ) {}
  get(key: string): ReadResult | undefined {
    const hit = this.map.get(key);
    if (!hit || Date.now() - hit.at > this.ttlMs) return undefined;
    return hit.r;
  }
  set(key: string, r: ReadResult): void {
    if (!r.ok) return;
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), r });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export async function readMany(browser: Browser, config: Config, reqs: ReadRequest[], opts: ReadManyOptions): Promise<ReadDoc[]> {
  const results: ReadDoc[] = new Array(reqs.length);
  let next = 0;
  const worker = async () => {
    while (next < reqs.length && !opts.signal.aborted) {
      const i = next++;
      const req = reqs[i]!;
      const key = `${req.url}|${opts.images}|${opts.render}`;
      let r = opts.cache?.get(key);
      const cached = !!r;
      if (!r) {
        r = await readUrl(browser, req.url, {
          timeoutMs: config.fetch.timeoutMs,
          maxBytes: config.fetch.maxBytes,
          allowPrivate: config.fetch.allowPrivateNetwork,
          images: opts.images,
          signal: opts.signal,
          expectedTitle: req.title,
          render: opts.render,
          hints: opts.hints,
        });
        opts.cache?.set(key, r);
      }
      results[i] = toDoc(req, r, config, opts, cached);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.fetch.concurrency, reqs.length) }, worker));
  return results.filter(Boolean);
}

function toDoc(req: ReadRequest, r: ReadResult, config: Config, opts: ReadManyOptions, cached: boolean): ReadDoc {
  const base = { url: req.url, finalUrl: r.url, ms: cached ? 0 : r.ms, tier: r.tier, cached, images: [] as PageImage[] };
  if (!r.ok) {
    return { ...base, title: req.title ?? req.url, ok: false, error: r.error, markdown: "", tokens: 0, truncated: false, remainingTokens: 0 };
  }
  let markdown: string;
  let title: string;
  let images: PageImage[] = [];
  let meta: Record<string, string> | undefined;
  let quality: number | undefined;
  if (r.kind === "text") {
    title = req.title ?? r.url;
    const body = r.lang === "markdown" || r.lang === "" ? r.text.trim() : `\`\`\`${r.lang}\n${r.text.trim()}\n\`\`\``;
    markdown = `${"#".repeat(opts.titleLevel)} ${title}\n\n> ${r.url}\n\n${body}\n`;
  } else {
    const mode: ImageMode = opts.images ? "urls" : "off";
    const rendered = renderDocument(r.doc, { links: config.output.links, images: mode, titleLevel: opts.titleLevel, header: true });
    markdown = rendered.markdown;
    title = r.doc.meta.title || req.title || r.url;
    images = rendered.imageRefs.map((n) => r.doc.images[n]!).slice(0, config.images.max);
    meta = { ...r.doc.meta };
    quality = r.quality;
  }

  const split = splitDocument(markdown);
  const packed = pack(split, opts.maxTokensEach, { focus: req.focus, start: req.start });
  const cursor = !req.focus && packed.next >= 0 ? encodeCursor({ u: req.url, c: packed.next }) : undefined;
  return {
    ...base,
    title,
    ok: true,
    markdown: packed.text,
    tokens: packed.tokens,
    truncated: packed.omittedTokens > 0,
    remainingTokens: packed.omittedTokens,
    cursor,
    focus: req.focus,
    quality,
    images,
    meta,
  };
}

/**
 * Wrap a document for the model: mark the page content as untrusted and say
 * what was left out and how to get it.
 */
export function docSection(doc: ReadDoc, heading: string): string {
  if (!doc.ok) return `${heading}\n\n> ${doc.url}\n\n_Could not read this page: ${doc.error}_\n`;
  const host = hostOf(doc.finalUrl) || "web";
  const [first, ...rest] = doc.markdown.split("\n");
  // The document's own title line is replaced by the caller's heading.
  const body = (first?.startsWith("#") ? rest.join("\n") : doc.markdown).trim();
  let more = "";
  if (doc.truncated && doc.focus) {
    more = `\n\n_[Showing the sections most relevant to "${doc.focus}"; about ${doc.remainingTokens} tokens of other sections left out. Call web_fetch on ${doc.url} without focus to read it in order.]_`;
  } else if (doc.truncated && doc.cursor) {
    more = `\n\n_[About ${doc.remainingTokens} more tokens on this page. To continue, call web_fetch with cursor: "${doc.cursor}"]_`;
  }
  return `${heading}\n\n<!-- begin untrusted content from ${host} -->\n${body}${more}\n<!-- end untrusted content -->\n`;
}
