/**
 * Read one URL into an extracted document, from two angles:
 *
 * - http:    fetch the page over plain HTTP, then hand those exact bytes to a
 *            Chrome tab as its response with scripts off and only stylesheets
 *            allowed. Same extractor, full layout, no page scripts, images or
 *            trackers: usually several times faster.
 * - browser: a normal Chrome load with scripts, for pages that need them.
 *
 * `readUrl` races them: HTTP starts at once, Chrome joins if HTTP is slow or
 * its result looks thin, the better extraction wins and the loser is
 * cancelled. Which tier worked is remembered per site.
 */
import type { Browser } from "../browser/browser.js";
import type { Page } from "../browser/page.js";
import { assertPublicUrl, BlockedAddressError } from "../fetch/guard.js";
import type { TierHints, Tier } from "../fetch/hints.js";
import { decodeBody, httpGet, HttpFetchError } from "../fetch/http.js";
import { log } from "../util/log.js";
import { extractExpression } from "./inpage.js";
import { extractLite } from "./lite.js";
import { quality } from "./markdown.js";
import type { Extracted } from "./types.js";

/** "lite" = plain HTTP and the no-Chrome extractor (browser.mode "off"). */
export type RenderMode = "auto" | "http" | "browser" | "lite";

export interface ReadOptions {
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** Private hosts allowed anyway ("host" or "host:port"). */
  allowHosts?: string[];
  /** Let images load (needed when the caller wants them). */
  images: boolean;
  signal?: AbortSignal;
  /** Title from the search result, if any: helps the quality score. */
  expectedTitle?: string;
}

interface Common {
  url: string;
  status?: number;
  ms: number;
  tier: Tier;
}
export type ReadResult =
  | (Common & { ok: true; kind: "html"; doc: Extracted; quality: number })
  | (Common & { ok: true; kind: "text"; text: string; lang: string; title: string; quality: number })
  | (Common & { ok: false; error: string; quality: 0; retryable: boolean });

export class UnsupportedContentError extends Error {
  override name = "UnsupportedContentError";
}

const TEXT_TYPES: Record<string, string> = {
  "text/plain": "",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "application/json": "json",
  "application/ld+json": "json",
  "text/csv": "csv",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/javascript": "js",
  "text/javascript": "js",
};
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml", ""]);
const BOT_CHECK_TEXT = /just a moment|verify you are human|are you a robot|captcha|access denied|attention required|enable javascript and cookies/i;

// ---------------------------------------------------------------- race

/** A result this good ends the race at once. */
const GOOD = 0.7;
/** Below this, an HTTP result is not trusted alone: Chrome must try. */
const THIN = 0.5;
/** Chrome starts this long after HTTP if HTTP has not finished. */
const HEAD_START_MS = 400;

export async function readUrl(
  browser: Browser,
  url: string,
  opts: ReadOptions & { render: RenderMode; hints?: TierHints },
): Promise<ReadResult> {
  const start = performance.now();
  try {
    await assertPublicUrl(url, opts.allowPrivate, opts.allowHosts);
  } catch (err) {
    return failure(url, "http", (err as Error).message, start, false);
  }
  const host = hostOf(url);
  const hinted = opts.hints?.get(host);
  const mode: RenderMode = opts.render !== "auto" ? opts.render : hinted === "browser" ? "browser" : "auto";
  if (opts.render === "lite") return readLite(url, opts);
  if (mode === "browser") return readWithBrowser(browser, url, opts);
  if (mode === "http") return readWithHttp(browser, url, opts);

  const outer = opts.signal;
  const httpAc = new AbortController();
  const browserAc = new AbortController();
  const link = (ac: AbortController) => (outer ? AbortSignal.any([outer, ac.signal]) : ac.signal);

  const httpP = readWithHttp(browser, url, { ...opts, signal: link(httpAc) }).catch((err: Error) =>
    failure(url, "http", err.message, start, true),
  );
  let browserP: Promise<ReadResult> | undefined;
  const startBrowser = () => {
    browserP ??= readWithBrowser(browser, url, { ...opts, signal: link(browserAc) }).catch((err: Error) =>
      failure(url, "browser", err.message, start, false),
    );
    return browserP;
  };

  // Sites known to work over HTTP don't get a Chrome head start.
  const headStart = hinted === "http" ? opts.timeoutMs : HEAD_START_MS;
  const timer = setTimeout(startBrowser, headStart);
  const first = await httpP;
  clearTimeout(timer);

  let winner: ReadResult;
  if (first.ok && first.quality >= GOOD) {
    winner = first;
  } else if (!first.ok && !first.retryable) {
    winner = first; // blocked address, unsupported type: Chrome won't do better
  } else {
    const second = await startBrowser();
    winner = pickBetter(first, second);
  }
  // Cancel whatever is still running (a Chrome load that lost to HTTP).
  if (winner.tier === "http") browserAc.abort();
  httpAc.abort();

  learn(opts.hints, host, first, winner);
  log.debug(`read ${url}: ${winner.tier} won (q=${winner.quality}) in ${Math.round(performance.now() - start)} ms`);
  return { ...winner, ms: Math.round(performance.now() - start) };
}

function pickBetter(a: ReadResult, b: ReadResult): ReadResult {
  if (!a.ok) return b.ok ? b : a;
  if (!b.ok) return a;
  // Prefer the browser on near-ties: it saw what scripts render.
  return b.quality >= a.quality - 0.05 ? b : a;
}

function learn(hints: TierHints | undefined, host: string, httpResult: ReadResult, winner: ReadResult): void {
  if (!hints || !host) return;
  if (httpResult.ok && httpResult.quality >= GOOD) hints.set(host, "http");
  else if (winner.tier === "browser" && winner.ok && winner.quality >= (httpResult.ok ? httpResult.quality + 0.2 : 0)) {
    hints.set(host, "browser");
  }
}

// ---------------------------------------------------------------- http tier

export async function readWithHttp(browser: Browser, url: string, opts: ReadOptions): Promise<ReadResult> {
  const start = performance.now();
  void browser.ensure().catch(() => undefined); // needed for rendering; start it now, don't wait
  let res;
  try {
    res = await httpGet(url, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      allowPrivate: opts.allowPrivate,
      allowHosts: opts.allowHosts,
      chromeVersion: browser.product?.split("/")[1],
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const retryable = err instanceof HttpFetchError;
    if (err instanceof BlockedAddressError) return failure(url, "http", err.message, start, false);
    return failure(url, "http", (err as Error).message, start, retryable);
  }

  const type = res.contentType;
  if (type === "application/pdf") return failure(res.url, "http", "PDF documents are not supported yet (planned for tiny-browse 0.2)", start, false, res.status);
  if (type in TEXT_TYPES && res.status < 400) {
    const text = decodeBody(res.body, type);
    return { ok: true, tier: "http", kind: "text", url: res.url, status: res.status, text, lang: TEXT_TYPES[type]!, title: res.url, quality: 1, ms: since(start) };
  }
  if (!HTML_TYPES.has(type)) return failure(res.url, "http", `cannot read ${type} content`, start, false, res.status);

  const html = decodeBody(res.body, type);
  if (res.status >= 400) {
    // Bot checks often answer plain HTTP with 403/503; a real browser may get through.
    const botCheck = [403, 429, 503].includes(res.status) && BOT_CHECK_TEXT.test(html.slice(0, 20_000));
    return failure(res.url, "http", botCheck ? `bot check (HTTP ${res.status})` : `HTTP ${res.status}`, start, true, res.status);
  }

  const doc = await renderOffline(browser, res.url, html, opts);
  return { ok: true, tier: "http", kind: "html", url: res.url, status: res.status, doc, quality: quality(doc, opts.expectedTitle), ms: since(start) };
}

/**
 * Show `html` in a tab as the response for `url`: correct base URL for links,
 * page scripts off, nothing but stylesheets loaded.
 */
async function renderOffline(browser: Browser, url: string, html: string, opts: ReadOptions): Promise<Extracted> {
  return browser.withPage(async (page) => {
    await page.cdp("Emulation.setScriptExecutionDisabled", { value: true });
    let served = false;
    page.onEvent("Fetch.requestPaused", (e) => {
      const id = { requestId: e.requestId };
      if (e.resourceType === "Document" && !served) {
        served = true;
        page
          .cdp("Fetch.fulfillRequest", {
            ...id,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(html, "utf8").toString("base64"),
          })
          .catch(() => undefined);
      } else if (e.resourceType === "Stylesheet") {
        // Stylesheets come from the page's HTML, so they are guarded like any request.
        assertPublicUrl(e.request.url, opts.allowPrivate, opts.allowHosts).then(
          () => page.cdp("Fetch.continueRequest", id).catch(() => undefined),
          () => page.cdp("Fetch.failRequest", { ...id, errorReason: "AccessDenied" }).catch(() => undefined),
        );
      } else {
        page.cdp("Fetch.failRequest", { ...id, errorReason: "BlockedByClient" }).catch(() => undefined);
      }
    });
    await page.cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    // Stylesheets get a short window; layout without them still works.
    await page.goto(url, { waitUntil: "load", timeoutMs: Math.min(2500, opts.timeoutMs), signal: opts.signal });
    return page.evaluate<Extracted>(extractExpression({ minImageSize: 64 }), 20_000);
  });
}

// ---------------------------------------------------------------- lite tier (no Chrome)

export async function readLite(url: string, opts: ReadOptions): Promise<ReadResult> {
  const start = performance.now();
  let res;
  try {
    res = await httpGet(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, allowPrivate: opts.allowPrivate, allowHosts: opts.allowHosts, signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return failure(url, "http", (err as Error).message, start, false);
  }
  const type = res.contentType;
  if (type === "application/pdf") return failure(res.url, "http", "PDF documents are not supported yet (planned for tiny-browse 0.2)", start, false, res.status);
  if (type in TEXT_TYPES && res.status < 400) {
    return { ok: true, tier: "http", kind: "text", url: res.url, status: res.status, text: decodeBody(res.body, type), lang: TEXT_TYPES[type]!, title: res.url, quality: 1, ms: since(start) };
  }
  if (!HTML_TYPES.has(type)) return failure(res.url, "http", `cannot read ${type} content`, start, false, res.status);
  const html = decodeBody(res.body, type);
  if (res.status >= 400) {
    const botCheck = [403, 429, 503].includes(res.status) && BOT_CHECK_TEXT.test(html.slice(0, 20_000));
    return failure(res.url, "http", botCheck ? `the site blocked automated access with a bot check (HTTP ${res.status})` : `HTTP ${res.status}`, start, false, res.status);
  }
  const doc = extractLite(html, res.url, { minImageSize: 64 });
  return { ok: true, tier: "http", kind: "html", url: res.url, status: res.status, doc, quality: quality(doc, opts.expectedTitle), ms: since(start) };
}

// ---------------------------------------------------------------- browser tier

export async function readWithBrowser(browser: Browser, url: string, opts: ReadOptions): Promise<ReadResult> {
  const start = performance.now();
  try {
    await assertPublicUrl(url, opts.allowPrivate, opts.allowHosts);
    return await browser.withPage(async (page) => {
      await interceptRequests(page, opts);
      const nav = await page.goto(url, { waitUntil: "load", timeoutMs: opts.timeoutMs, signal: opts.signal });
      const mime = (nav.mimeType ?? "text/html").toLowerCase();

      if (mime === "application/pdf") throw new UnsupportedContentError("PDF documents are not supported yet (planned for tiny-browse 0.2)");
      if (/^(image|video|audio|font)\//.test(mime) || mime === "application/octet-stream" || mime === "application/zip") {
        throw new UnsupportedContentError(`cannot read ${mime} content`);
      }
      if (mime in TEXT_TYPES) {
        const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
        return { ok: true as const, tier: "browser" as const, url: nav.url, status: nav.status, kind: "text" as const, text, lang: TEXT_TYPES[mime]!, title: nav.url, quality: 1, ms: since(start) };
      }

      await settle(page, opts.signal);
      const doc = await page.evaluate<Extracted>(extractExpression({ minImageSize: 64 }), 20_000);
      if (nav.status && nav.status >= 400) {
        const title = doc.meta.title || `HTTP ${nav.status}`;
        const botCheck =
          [403, 429, 503].includes(nav.status) &&
          (await page
            .evaluate<boolean>(
              `${BOT_CHECK_TEXT}.test(document.title + " " + (document.body ? document.body.innerText.slice(0, 2000) : "")) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, .g-recaptcha, .h-captcha')`,
            )
            .catch(() => false));
        const error = botCheck ? `the site blocked automated access with a bot check (HTTP ${nav.status})` : `HTTP ${nav.status}: ${title}`;
        return failure(nav.url, "browser", error, start, false, nav.status);
      }
      return { ok: true as const, tier: "browser" as const, url: nav.url, status: nav.status, kind: "html" as const, doc, quality: quality(doc, opts.expectedTitle), ms: since(start) };
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const message = (err as Error).message.split("\n")[0]!.replace(/^Page\.navigate: /, "");
    return failure(url, "browser", message, start, false);
  }
}

/**
 * Every request the page makes passes through here, not just the page itself:
 * scripts, stylesheets, iframes, XHR/fetch, beacons. Requests to local or
 * private addresses are refused, so a public page cannot use this browser to
 * reach your router or dev servers. Heavy resources are skipped, and the page
 * request asks for Markdown first (some sites serve it to agents).
 */
async function interceptRequests(page: Page, opts: ReadOptions): Promise<void> {
  const skip = new Set(opts.images ? ["Media", "Font"] : ["Image", "Media", "Font"]);
  let mainServed = false;
  page.onEvent("Fetch.requestPaused", (e) => {
    const id = { requestId: e.requestId };
    const url: string = e.request.url;
    if (skip.has(e.resourceType)) {
      page.cdp("Fetch.failRequest", { ...id, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    if (/^(data|blob):/i.test(url)) {
      page.cdp("Fetch.continueRequest", id).catch(() => undefined);
      return;
    }
    assertPublicUrl(url, opts.allowPrivate, opts.allowHosts).then(
      () => {
        if (e.resourceType === "Document" && !mainServed) {
          mainServed = true;
          const headers = Object.entries({ ...e.request.headers, Accept: "text/markdown;q=1.0, text/html;q=0.9, */*;q=0.8" }).map(
            ([name, value]) => ({ name, value: String(value) }),
          );
          page.cdp("Fetch.continueRequest", { ...id, headers }).catch(() => undefined);
          return;
        }
        page.cdp("Fetch.continueRequest", id).catch(() => undefined);
      },
      () => page.cdp("Fetch.failRequest", { ...id, errorReason: "AccessDenied" }).catch(() => undefined),
    );
  });
  // WebSockets can't be intercepted this way; reading a page never needs one.
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: "Object.defineProperty(window, 'WebSocket', { value: undefined, configurable: false }); Object.defineProperty(window, 'WebTransport', { value: undefined, configurable: false });",
  });
  await page.cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
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

// ---------------------------------------------------------------- helpers

function failure(url: string, tier: Tier, error: string, start: number, retryable: boolean, status?: number): ReadResult {
  return { ok: false, tier, url, status, error, quality: 0, retryable, ms: since(start) };
}

function since(start: number): number {
  return Math.round(performance.now() - start);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
