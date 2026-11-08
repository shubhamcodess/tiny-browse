/**
 * URL helpers shared by Node and the in-page SERP script.
 *
 * `unwrapTarget` is injected into the page with Function.prototype.toString,
 * so it must stay self-contained: no imports, no outer variables, only
 * built-ins that exist in both Node and browsers (URL, atob).
 */

/**
 * Turn a search engine's link into the address it points to.
 * Returns null for non-http links. Links on the engine's own hosts are
 * unwrapped (Google /url?q=, Bing /ck/a?u=a1<base64>, DuckDuckGo /l/?uddg=);
 * links elsewhere are returned as is.
 */
export function unwrapTarget(href: string, base: string, internalHost: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const internal = new RegExp(internalHost, "i");
  if (!internal.test(u.hostname)) return u.href;

  const keys = ["uddg", "url", "q", "u", "imgurl", "target", "to", "dest", "RU"];
  for (const key of keys) {
    const raw = u.searchParams.get(key);
    if (!raw) continue;
    let value = raw;
    if (key === "u" && raw.startsWith("a1")) {
      try {
        const b64 = raw.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        value = atob(b64 + "===".slice((b64.length + 3) % 4));
      } catch {
        continue;
      }
    }
    // Google uses ?q= for both redirects (/url) and searches (/search).
    if (key === "q" && !/\/url$/.test(u.pathname)) continue;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/")) {
      try {
        return new URL(value, u.origin).href;
      } catch {
        continue;
      }
    }
  }
  return u.href;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|dclid|yclid|mc_[a-z]+|_hs[a-z]+|ved|ei|sa|usg|srsltid)$/i;

/** Canonical form used to dedupe results: no hash, no tracking params, lowercase host. */
export function normalizeUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  let out = u.href;
  if (u.pathname === "/" && !u.search) out = out.replace(/\/$/, "");
  return out;
}

export function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isInternal(href: string, internalHost: string): boolean {
  try {
    return new RegExp(internalHost, "i").test(new URL(href).hostname);
  } catch {
    return true;
  }
}
