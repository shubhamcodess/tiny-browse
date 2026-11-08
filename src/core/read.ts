/**
 * Read several pages in parallel within a token budget and render each as a
 * Markdown section. Shared by web_fetch and web_search's `read`.
 */
import type { Browser } from "../browser/browser.js";
import type { Config } from "../config.js";
import { estimateTokens, renderDocument, truncateToTokens, type ImageMode } from "../extract/markdown.js";
import { readUrl, type ReadResult, type RenderMode } from "../extract/reader.js";
import type { TierHints } from "../fetch/hints.js";
import type { PageImage } from "../extract/types.js";
import { hostOf } from "../search/urls.js";

export interface ReadRequest {
  url: string;
  /** Title we expect (from search), for the quality score and as a fallback heading. */
  title?: string;
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
  quality?: number;
  ms: number;
  /** Which way of reading produced this: plain HTTP (rendered offline) or a full Chrome load. */
  tier: "http" | "browser";
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
  signal: AbortSignal;
}

export async function readMany(browser: Browser, config: Config, reqs: ReadRequest[], opts: ReadManyOptions): Promise<ReadDoc[]> {
  const results: ReadDoc[] = new Array(reqs.length);
  let next = 0;
  const worker = async () => {
    while (next < reqs.length && !opts.signal.aborted) {
      const i = next++;
      const req = reqs[i]!;
      const r = await readUrl(browser, req.url, {
        timeoutMs: config.fetch.timeoutMs,
        maxBytes: config.fetch.maxBytes,
        allowPrivate: config.fetch.allowPrivateNetwork,
        images: opts.images,
        signal: opts.signal,
        expectedTitle: req.title,
        render: opts.render,
        hints: opts.hints,
      });
      results[i] = toDoc(req, r, config, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.fetch.concurrency, reqs.length) }, worker));
  return results.filter(Boolean);
}

function toDoc(req: ReadRequest, r: ReadResult, config: Config, opts: ReadManyOptions): ReadDoc {
  const base = { url: req.url, finalUrl: r.url, ms: r.ms, tier: r.tier, images: [] as PageImage[] };
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
  const cut = truncateToTokens(markdown, opts.maxTokensEach);
  return {
    ...base,
    title,
    ok: true,
    markdown: cut.text,
    tokens: estimateTokens(cut.text),
    truncated: cut.truncated,
    remainingTokens: cut.remainingTokens,
    quality,
    images,
    meta,
  };
}

/**
 * Wrap a document for the model: mark the page content as untrusted and say
 * when it was cut short.
 */
export function docSection(doc: ReadDoc, heading: string): string {
  if (!doc.ok) return `${heading}\n\n> ${doc.url}\n\n_Could not read this page: ${doc.error}_\n`;
  const host = hostOf(doc.finalUrl) || "web";
  const [first, ...rest] = doc.markdown.split("\n");
  // The document's own title line is replaced by the caller's heading.
  const body = (first?.startsWith("#") ? rest.join("\n") : doc.markdown).trim();
  const more = doc.truncated
    ? `\n\n_[Cut to fit the token budget: about ${doc.remainingTokens} more tokens on this page. Use web_fetch with a larger max_tokens to read more.]_`
    : "";
  return `${heading}\n\n<!-- begin untrusted content from ${host} -->\n${body}${more}\n<!-- end untrusted content -->\n`;
}
