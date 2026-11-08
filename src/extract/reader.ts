/**
 * Load one URL in a Chrome tab and turn it into an extracted document.
 * (M4 adds a plain-HTTP tier raced against this one.)
 */
import type { Browser } from "../browser/browser.js";
import type { Page } from "../browser/page.js";
import { extractExpression } from "./inpage.js";
import { quality } from "./markdown.js";
import type { Extracted } from "./types.js";

export interface ReadOptions {
  timeoutMs: number;
  /** Let images load (needed when the caller wants them). */
  images: boolean;
  signal?: AbortSignal;
  /** Title from the search result, if any: helps the quality score. */
  expectedTitle?: string;
}

export type ReadResult =
  | { ok: true; url: string; status?: number; kind: "html"; doc: Extracted; quality: number; ms: number }
  | { ok: true; url: string; status?: number; kind: "text"; text: string; lang: string; title: string; ms: number }
  | { ok: false; url: string; status?: number; error: string; ms: number };

export class UnsupportedContentError extends Error {
  override name = "UnsupportedContentError";
}

const TEXT_TYPES: Record<string, string> = {
  "text/plain": "",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "application/json": "json",
  "text/csv": "csv",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/javascript": "js",
  "text/javascript": "js",
};

export async function readWithBrowser(browser: Browser, url: string, opts: ReadOptions): Promise<ReadResult> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  try {
    return await browser.withPage(async (page) => {
      await interceptRequests(page, opts.images);
      const nav = await page.goto(url, { waitUntil: "load", timeoutMs: opts.timeoutMs, signal: opts.signal });
      const mime = (nav.mimeType ?? "text/html").toLowerCase();

      if (mime === "application/pdf") throw new UnsupportedContentError("PDF documents are not supported yet (planned for tiny-browse 0.2)");
      if (/^(image|video|audio|font)\//.test(mime) || mime === "application/octet-stream" || mime === "application/zip") {
        throw new UnsupportedContentError(`cannot read ${mime} content`);
      }
      if (mime in TEXT_TYPES) {
        const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
        return { ok: true as const, url: nav.url, status: nav.status, kind: "text" as const, text, lang: TEXT_TYPES[mime]!, title: nav.url, ms: ms() };
      }

      await settle(page, opts.signal);
      const doc = await page.evaluate<Extracted>(extractExpression({ minImageSize: 64 }), 20_000);
      if (nav.status && nav.status >= 400) {
        const title = doc.meta.title || `HTTP ${nav.status}`;
        const botCheck =
          [403, 429, 503].includes(nav.status) &&
          (await page
            .evaluate<boolean>(
              `/just a moment|verify you are human|are you a robot|captcha|access denied|attention required/i.test(document.title + " " + (document.body ? document.body.innerText.slice(0, 2000) : "")) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, .g-recaptcha, .h-captcha')`,
            )
            .catch(() => false));
        const error = botCheck
          ? `the site blocked automated access with a bot check (HTTP ${nav.status})`
          : `HTTP ${nav.status}: ${title}`;
        return { ok: false as const, url: nav.url, status: nav.status, error, ms: ms() };
      }
      return {
        ok: true as const,
        url: nav.url,
        status: nav.status,
        kind: "html" as const,
        doc,
        quality: quality(doc, opts.expectedTitle),
        ms: ms(),
      };
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const message = (err as Error).message.split("\n")[0]!.replace(/^Page\.navigate: /, "");
    return { ok: false, url, error: message, ms: ms() };
  }
}

/**
 * Ask for Markdown first on the page request (some sites serve it to agents),
 * and skip heavy resources nobody will read.
 */
async function interceptRequests(page: Page, images: boolean): Promise<void> {
  const blocked = images ? ["Media", "Font"] : ["Image", "Media", "Font"];
  const patterns = [
    { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ...blocked.map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" })),
  ];
  page.onEvent("Fetch.requestPaused", (e) => {
    if (e.resourceType === "Document") {
      const headers = Object.entries({ ...e.request.headers, Accept: "text/markdown;q=1.0, text/html;q=0.9, */*;q=0.8" }).map(
        ([name, value]) => ({ name, value: String(value) }),
      );
      page.cdp("Fetch.continueRequest", { requestId: e.requestId, headers }).catch(() => undefined);
    } else {
      page.cdp("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
    }
  });
  await page.cdp("Fetch.enable", { patterns });
}

/** Wait until the DOM stops changing (SPAs render after load), at most ~2.5 s. */
async function settle(page: Page, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await page
    .evaluate(
      `new Promise((resolve) => {
        const quietMs = 400, maxMs = 2500, start = Date.now();
        let last = Date.now();
        const obs = new MutationObserver(() => { last = Date.now(); });
        obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        // A page with almost no text is probably still rendering: being quiet isn't enough.
        const hasContent = () => (document.body ? document.body.innerText.trim().length : 0) > 300;
        const tick = () => {
          const now = Date.now();
          if ((now - last >= quietMs && hasContent()) || now - start >= maxMs) { obs.disconnect(); resolve(true); }
          else setTimeout(tick, 100);
        };
        setTimeout(tick, 100);
      })`,
      5000,
    )
    .catch(() => undefined);
}
