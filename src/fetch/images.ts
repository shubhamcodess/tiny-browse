/**
 * Fetch the main images of pages for vision models (return_images: true).
 * Same private-network guard and size caps as page fetches; only common
 * raster formats; a few images per answer at most.
 */
import type { ImageBlob } from "../core/engine.js";
import type { PageImage } from "../extract/types.js";
import { httpGet } from "./http.js";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface ImageOptions {
  max: number;
  maxBytes: number;
  allowPrivate: boolean;
  allowHosts?: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface FetchedImage extends ImageBlob {
  src: string;
  alt: string;
}

export async function fetchImages(images: PageImage[], opts: ImageOptions): Promise<FetchedImage[]> {
  const wanted = dedupe(images).slice(0, opts.max);
  const results = await Promise.all(
    wanted.map(async (img, i) => {
      try {
        const res = await httpGet(img.src, {
          timeoutMs: opts.timeoutMs,
          maxBytes: opts.maxBytes,
          allowPrivate: opts.allowPrivate,
          allowHosts: opts.allowHosts,
          signal: opts.signal,
        });
        if (res.status >= 400) return undefined;
        const mimeType = ALLOWED.has(res.contentType) ? res.contentType : sniff(res.body);
        if (!mimeType) return undefined;
        return { id: `img${i + 1}`, mimeType, data: res.body.toString("base64"), src: img.src, alt: img.alt || img.caption };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((x): x is FetchedImage => !!x);
}

function dedupe(images: PageImage[]): PageImage[] {
  const seen = new Set<string>();
  return images.filter((i) => (seen.has(i.src) ? false : (seen.add(i.src), true)));
}

/** Identify a raster format from its first bytes when the server's type is vague. */
function sniff(b: Buffer): string | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}
