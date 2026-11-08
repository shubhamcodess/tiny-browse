/**
 * Plain HTTP fetch of a page: the fast path. Node's built-in fetch (undici)
 * keeps connections alive between requests to the same host.
 */
import { VERSION } from "../version.js";
import { assertPublicUrl } from "./guard.js";

export interface HttpResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  ms: number;
}

export interface HttpOptions {
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** Chrome version string ("156.0.8078.80") for the User-Agent; generic if unknown. */
  chromeVersion?: string;
  signal?: AbortSignal;
}

export class HttpFetchError extends Error {
  override name = "HttpFetchError";
}

const MAX_REDIRECTS = 10;

export function userAgent(chromeVersion?: string): string {
  const major = chromeVersion?.split(".")[0] ?? "140";
  const os =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  // A normal Chrome UA so sites send their normal page, plus our name: honest about being tiny-browse.
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 tiny-browse/${VERSION}`;
}

export async function httpGet(url: string, opts: HttpOptions): Promise<HttpResult> {
  const start = performance.now();
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop is checked: a public page may redirect to a private address.
    await assertPublicUrl(current, opts.allowPrivate);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": userAgent(opts.chromeVersion),
          accept: "text/markdown;q=1.0, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new HttpFetchError(signal.aborted ? `timed out after ${opts.timeoutMs} ms` : (cause?.code ?? cause?.message ?? (err as Error).message));
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      current = new URL(res.headers.get("location")!, current).href;
      continue;
    }
    const body = await readCapped(res, opts.maxBytes);
    return {
      url: current,
      status: res.status,
      contentType: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
      body,
      ms: Math.round(performance.now() - start),
    };
  }
  throw new HttpFetchError(`too many redirects (more than ${MAX_REDIRECTS})`);
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new HttpFetchError(`page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpFetchError(`page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Decode a body using the charset from headers or <meta>, falling back to UTF-8. */
export function decodeBody(body: Buffer, contentTypeHeader = ""): string {
  let charset = /charset=([\w-]+)/i.exec(contentTypeHeader)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
