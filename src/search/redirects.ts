/**
 * Find where an engine's opaque result link (e.g. Google /goto?url=<token>)
 * leads, the way a click would: open it in a background tab, let requests on
 * the engine's own hosts through, and stop at the first request that leaves
 * them. The destination page itself is never loaded.
 */
import type { Browser } from "../browser/browser.js";
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

  const resolveOne = (href: string): Promise<string | undefined> =>
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
    });

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
