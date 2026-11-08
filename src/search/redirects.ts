/**
 * Find where an engine's opaque result link (e.g. Google /goto?url=<token>)
 * leads, the way a click would: open it in a background tab, let requests on
 * the engine's own hosts through, and stop at the first request that leaves
 * them. The destination page itself is never loaded.
 */
import type { Browser } from "../browser/browser.js";
import { userAgent } from "../fetch/http.js";
import { log } from "../util/log.js";

export type RedirectResolver = (hrefs: string[]) => Promise<Record<string, string>>;

export function redirectResolver(
  browser: Browser,
  internalHost: string,
  opts: {
    timeoutMs?: number;
    concurrency?: number;
    /** Asked before following `n` links; false = follow none (rate budget). */
    allow?: (n: number) => boolean;
  } = {},
): RedirectResolver {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const concurrency = opts.concurrency ?? 2;
  const internal = new RegExp(internalHost, "i");

  /**
   * Fast path: Google's /goto answers a plain GET with a 302 to the result,
   * no cookies or browser needed (~0.2 s). (A HEAD gets 200 and no Location.)
   */
  const viaHttp = async (href: string): Promise<string | undefined> => {
    let current = href;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": userAgent(browser.product?.split("/")[1]), "accept-language": "en-US,en;q=0.9" },
      });
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location || res.status < 300 || res.status >= 400) return undefined;
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") return undefined;
      if (!internal.test(next.hostname)) return next.href;
      current = next.href; // another hop on the engine's own hosts
    }
    return undefined;
  };

  const resolveOne = async (href: string): Promise<string | undefined> =>
    (await viaHttp(href).catch(() => undefined)) ?? (await viaTab(href));

  /** Fallback: follow the link in a background tab and stop at the first request off the engine. */
  const viaTab = (href: string): Promise<string | undefined> =>
    browser.withPage(async (page) => {
      await page.cdp("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
      return new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        let off: () => void = () => {};
        const finish = (url: string | undefined) => {
          clearTimeout(timer);
          off();
          resolve(url);
        };
        off = page.onEvent("Fetch.requestPaused", (e) => {
          const url: string = e.request?.url ?? "";
          let host = "";
          try {
            host = new URL(url).hostname;
          } catch {
            // not a URL we can judge; let it through
          }
          if (!host || internal.test(host)) {
            page.cdp("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
            return;
          }
          page.cdp("Fetch.failRequest", { requestId: e.requestId, errorReason: "Aborted" }).catch(() => undefined);
          finish(url);
        });
        page.cdp("Page.navigate", { url: href }).catch(() => finish(undefined));
      });
    }, { kind: "profile" });

  return async (hrefs) => {
    const out: Record<string, string> = {};
    const queue = [...new Set(hrefs)];
    if (opts.allow && !opts.allow(queue.length)) {
      log.debug(`not following ${queue.length} result links: rate budget`);
      return out;
    }
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let href = queue.shift(); href; href = queue.shift()) {
        try {
          const dest = await resolveOne(href);
          if (dest) out[href] = dest;
        } catch (err) {
          log.debug(`could not follow ${href}`, err);
        }
      }
    });
    await Promise.all(workers);
    return out;
  };
}
