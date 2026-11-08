/**
 * Block tree -> clean Markdown, plus the polish pass and a quality score.
 * Pure functions: no browser needed, fully unit-testable.
 */
import { countTokens } from "../util/tokens.js";
import { IMG_CLOSE, IMG_OPEN, LINK_CLOSE, LINK_MID, LINK_OPEN, type Block, type Extracted } from "./types.js";

export type LinkStyle = "inline" | "reference" | "text";
export type ImageMode = "off" | "urls" | "inline";

export interface RenderOptions {
  links: LinkStyle;
  images: ImageMode;
  /** Level used for the page title; content headings start one below it. */
  titleLevel: number;
  /** Include the title + source line. */
  header: boolean;
}

export interface Rendered {
  markdown: string;
  /** Image refs (index into Extracted.images) that the Markdown refers to, in order. */
  imageRefs: number[];
}

// ---------- tokens ----------

/** Token count used for every budget (model-agnostic, see util/tokens.ts). */
export const estimateTokens = countTokens;

// ---------- headings ----------

/**
 * Give appearance-detected headings (level 0) a level by font size relative to
 * real headings, then shift and close gaps so content starts at `minLevel`.
 */
export function normalizeHeadings(blocks: Block[], minLevel: number): Block[] {
  const heads = collect(blocks).filter((b): b is Extract<Block, { t: "h" }> => b.t === "h");
  if (!heads.length) return blocks;

  const real = heads.filter((h) => h.level > 0);
  const sizesDesc = [...new Set(heads.map((h) => Math.round(h.size)))].sort((a, b) => b - a);
  for (const h of heads) {
    if (h.level > 0) continue;
    // Same size as a real heading -> same level.
    const twin = real.find((r) => Math.abs(r.size - h.size) <= 1);
    if (twin) {
      h.level = twin.level;
      continue;
    }
    // Otherwise one level below the deepest real heading that is bigger, so a
    // big styled heading sits above smaller real ones (h1 32px > styled 26px > h3 19px).
    const bigger = real.filter((r) => r.size > h.size + 1).map((r) => r.level);
    const smaller = real.filter((r) => r.size < h.size - 1).map((r) => r.level);
    if (bigger.length) h.level = Math.min(6, Math.max(...bigger) + 1);
    else if (smaller.length) h.level = Math.max(1, Math.min(...smaller) - 1); // bigger than every real heading
    else if (real.length) h.level = Math.min(...real.map((r) => r.level));
    else h.level = Math.min(6, 2 + sizesDesc.indexOf(Math.round(h.size)));
  }

  // Map the levels in use onto consecutive levels from minLevel (h2,h4 -> ##,###).
  const used = [...new Set(heads.map((h) => h.level))].sort((a, b) => a - b);
  const map = new Map<number, number>();
  used.forEach((lvl, i) => map.set(lvl, Math.min(6, minLevel + i)));
  for (const h of heads) h.level = map.get(h.level)!;
  return blocks;
}

function collect(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    out.push(b);
    if (b.t === "list") for (const item of b.items) out.push(...collect(item));
    if (b.t === "quote") out.push(...collect(b.blocks));
  }
  return out;
}

// ---------- inline ----------

function renderInline(text: string, doc: Extracted, opts: RenderOptions, refs: Map<number, number>, imageRefs: number[]): string {
  const linkRe = new RegExp(`${LINK_OPEN}(\\d+)${LINK_MID}([\\s\\S]*?)${LINK_CLOSE}`, "g");
  const imgRe = new RegExp(`${IMG_OPEN}(\\d+)${IMG_CLOSE}`, "g");
  let out = text.replace(linkRe, (_m, n: string, label: string) => {
    const url = doc.links[Number(n)];
    const t = escapeBrackets(label.trim());
    if (!url || opts.links === "text") return label;
    if (opts.links === "inline") return `[${t}](${url})`;
    let num = refs.get(Number(n));
    if (num === undefined) {
      num = refs.size + 1;
      refs.set(Number(n), num);
    }
    return `[${t}][${num}]`;
  });
  out = out.replace(imgRe, (_m, n: string) => renderImage(Number(n), doc, opts, imageRefs));
  return out;
}

function renderImage(ref: number, doc: Extracted, opts: RenderOptions, imageRefs: number[]): string {
  const img = doc.images[ref];
  if (!img) return "";
  const label = escapeBrackets(img.alt || img.caption || "image");
  if (opts.images === "off") return img.alt || img.caption ? `[image: ${label}]` : "";
  imageRefs.push(ref);
  const id = `img${imageRefs.length}`;
  return `![${label}](${opts.images === "inline" ? id : img.src})`;
}

function escapeBrackets(s: string): string {
  return s.replace(/([[\]])/g, "\\$1");
}

// ---------- blocks ----------

function renderBlocks(blocks: Block[], doc: Extracted, opts: RenderOptions, refs: Map<number, number>, imageRefs: number[]): string[] {
  const out: string[] = [];
  const il = (t: string) => renderInline(t, doc, opts, refs, imageRefs);
  for (const b of blocks) {
    switch (b.t) {
      case "h":
        out.push(`${"#".repeat(Math.max(1, Math.min(6, b.level)))} ${il(b.text).replace(/\n/g, " ")}`);
        break;
      case "p": {
        const text = il(b.text);
        if (text.trim()) out.push(text);
        break;
      }
      case "code": {
        const fence = b.text.includes("```") ? "````" : "```";
        out.push(`${fence}${b.lang}\n${b.text}\n${fence}`);
        break;
      }
      case "math":
        out.push(`$$\n${b.tex}\n$$`);
        break;
      case "hr":
        out.push("---");
        break;
      case "img": {
        const s = renderImage(b.ref, doc, opts, imageRefs);
        const cap = doc.images[b.ref]?.caption;
        if (s) out.push(cap && opts.images !== "off" ? `${s}\n*${cap}*` : s);
        break;
      }
      case "quote": {
        const inner = renderBlocks(b.blocks, doc, opts, refs, imageRefs).join("\n\n");
        if (inner.trim()) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        break;
      }
      case "list": {
        const lines: string[] = [];
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${b.start + i}.` : "-";
          const pad = " ".repeat(marker.length + 1);
          const body = renderBlocks(item, doc, opts, refs, imageRefs).join("\n\n");
          if (!body.trim()) return;
          const [first, ...rest] = body.split("\n");
          lines.push(`${marker} ${first}`);
          for (const l of rest) lines.push(l ? pad + l : "");
        });
        if (lines.length) out.push(lines.join("\n"));
        break;
      }
      case "table":
        out.push(renderTable(b, il));
        break;
    }
  }
  return out;
}

function renderTable(b: Extract<Block, { t: "table" }>, il: (s: string) => string): string {
  const rows = b.rows.map((r) => r.map((c) => il(c).replace(/\n/g, " ").replace(/\|/g, "\\|").trim()));
  const cols = Math.max(...rows.map((r) => r.length));
  if (b.complex) {
    // Merged cells or block content: a list of rows reads better than a broken grid.
    const head = b.header ? rows[0]! : [];
    const body = b.header ? rows.slice(1) : rows;
    return body
      .map((r) => {
        // Key/value rows (infoboxes): "**Key**: value".
        if (!b.header && r.length === 2 && r[0] && r[1]) return `- **${r[0]}**: ${r[1]}`;
        const parts = r.map((c, i) => (head[i] ? `**${head[i]}**: ${c}` : c)).filter((p) => p.replace(/\*\*.*\*\*: ?/, "").trim());
        return `- ${parts.join("; ")}`;
      })
      .join("\n");
  }
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill("")];
  const header = b.header ? pad(rows[0]!) : Array.from({ length: cols }, () => " ");
  const body = (b.header ? rows.slice(1) : rows).map(pad);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

// ---------- polish ----------

const NOISE_LINE = /^(advertisement|sponsored( content)?|ad|loading\.{0,3}|copy( code)?|copied!?|share( this)?( article)?|print|read more|show more|skip to (main )?content|back to top|table of contents|on this page)$/i;

/**
 * Clean up what extraction leaves behind: leftover link lists, repeated
 * buttons, ad markers, empty sections, sentinel noise.
 */
export function polish(blocks: Block[]): Block[] {
  // Lines repeated 3+ times (e.g. "Copy" under every code block, "Reply").
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.t === "p" && b.text.length < 80) counts.set(b.text, (counts.get(b.text) ?? 0) + 1);

  let out = blocks.filter((b) => {
    if (b.t !== "p") return true;
    const plain = stripMarkers(b.text).trim();
    if (!plain || /^[\p{P}\p{S}]{1,3}$/u.test(plain)) return false;
    if (NOISE_LINE.test(plain)) return false;
    if ((counts.get(b.text) ?? 0) >= 3) return false;
    return true;
  });

  // Paragraphs made only of links (tag clouds, "related posts", share rows).
  out = out.filter((b) => !(b.t === "p" && isLinkOnly(b.text)));

  // Lists whose every item is just a link: navigation that slipped through.
  // Kept when short (a "see also" list) or when they're the only content.
  if (out.some((b) => b.t === "p" && stripMarkers(b.text).length > 200)) {
    out = out.filter((b) => !(b.t === "list" && b.items.length >= 8 && b.items.every((it) => it.length === 1 && it[0]!.t === "p" && isLinkOnly(it[0]!.text))));
  }

  // Merge paragraphs split mid-sentence (by inline ads or layout wrappers).
  const merged: Block[] = [];
  for (const b of out) {
    const prev = merged[merged.length - 1];
    if (b.t === "p" && prev?.t === "p" && /[a-z,]$/.test(stripMarkers(prev.text)) && /^[a-z]/.test(stripMarkers(b.text))) {
      prev.text = `${prev.text} ${b.text}`;
      continue;
    }
    merged.push(b.t === "p" ? { ...b } : b);
  }

  // Headings with nothing under them before the next heading of the same or higher rank.
  const result: Block[] = [];
  for (let i = 0; i < merged.length; i++) {
    const b = merged[i]!;
    if (b.t === "h") {
      const next = merged.slice(i + 1).find(() => true);
      if (!next || (next.t === "h" && next.level <= b.level)) continue;
      // Drop consecutive duplicate headings.
      const prev = result[result.length - 1];
      if (prev?.t === "h" && prev.text === b.text) continue;
    }
    result.push(b);
  }
  return result;
}

function stripMarkers(s: string): string {
  return s
    .replace(new RegExp(`${LINK_OPEN}\\d+${LINK_MID}`, "g"), "")
    .replace(new RegExp(LINK_CLOSE, "g"), "")
    .replace(new RegExp(`${IMG_OPEN}\\d+${IMG_CLOSE}`, "g"), "");
}

function isLinkOnly(text: string): boolean {
  const linkText = [...text.matchAll(new RegExp(`${LINK_OPEN}\\d+${LINK_MID}([\\s\\S]*?)${LINK_CLOSE}`, "g"))]
    .map((m) => m[1]!)
    .join("");
  const all = stripMarkers(text).replace(/[\s|·•,/–—-]+/g, "");
  return linkText.length > 0 && linkText.replace(/\s+/g, "").length >= all.length * 0.9;
}

// ---------- quality ----------

/**
 * 0..1: how likely this is the real content of a readable page. Used to pick
 * between candidates and to decide whether to retry with a full browser load.
 */
export function quality(doc: Extracted, title = ""): number {
  const s = doc.stats;
  const prose = doc.blocks.filter((b) => b.t === "p").reduce((n, b) => n + stripMarkers((b as { text: string }).text).length, 0);
  let q = 0;
  q += Math.min(prose / 1500, 1) * 0.45; // enough text
  q += Math.min(s.paragraphs / 5, 1) * 0.15; // in several paragraphs
  q += (1 - Math.min(s.linkChars / Math.max(1, s.textChars), 1)) * 0.2; // not a link farm
  q += Math.min(s.headings / 2, 1) * 0.05; // some structure
  if (title) {
    const words = title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const text = doc.blocks.map((b) => (b.t === "p" || b.t === "h" ? b.text : "")).join(" ").toLowerCase();
    const hit = words.length ? words.filter((w) => text.includes(w)).length / words.length : 1;
    q += hit * 0.15;
  } else q += 0.1;
  q -= Math.min(s.boilerplateHits * 0.15, 0.45);
  return Math.max(0, Math.min(1, Number(q.toFixed(2))));
}

// ---------- document ----------

export function renderDocument(doc: Extracted, opts: RenderOptions): Rendered {
  const blocks = polish(normalizeHeadings(dropTitleHeading(structuredClone(doc.blocks), doc.meta.title), opts.titleLevel + 1));
  const refs = new Map<number, number>();
  const imageRefs: number[] = [];
  const body = renderBlocks(blocks, doc, opts, refs, imageRefs);

  const parts: string[] = [];
  if (opts.header) {
    parts.push(`${"#".repeat(opts.titleLevel)} ${doc.meta.title || doc.meta.url}`);
    const src = [doc.meta.canonical || doc.meta.url, doc.meta.siteName, doc.meta.author, doc.meta.published?.slice(0, 10)].filter(Boolean);
    parts.push(`> ${src.join(" · ")}`);
  }
  parts.push(...body);
  if (opts.links === "reference" && refs.size) {
    const defs = [...refs.entries()].sort((a, b) => a[1] - b[1]).map(([n, num]) => `[${num}]: ${doc.links[n]}`);
    parts.push(defs.join("\n"));
  }
  return { markdown: tidy(parts.join("\n\n")), imageRefs };
}

/** The page title often appears again as the first heading: drop that copy. */
function dropTitleHeading(blocks: Block[], title: string): Block[] {
  const i = blocks.findIndex((b) => b.t === "h");
  if (i < 0 || i > 2) return blocks;
  const h = blocks[i] as Extract<Block, { t: "h" }>;
  const norm = (s: string) => stripMarkers(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const ht = norm(h.text);
  const tt = norm(title);
  if (ht && tt && (tt.startsWith(ht) || ht.startsWith(tt))) blocks.splice(i, 1);
  return blocks;
}

function tidy(md: string): string {
  return (
    md
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

/** Cut Markdown at a block boundary to fit a token budget. */
export function truncateToTokens(md: string, maxTokens: number): { text: string; truncated: boolean; remainingTokens: number } {
  const total = estimateTokens(md);
  if (total <= maxTokens) return { text: md, truncated: false, remainingTokens: 0 };
  const parts = md.split(/\n\n(?=[^\n])/);
  let used = 0;
  const keep: string[] = [];
  for (const p of parts) {
    const t = estimateTokens(p) + 1;
    if (used + t > maxTokens) break;
    keep.push(p);
    used += t;
  }
  if (!keep.length) keep.push(md.slice(0, Math.max(0, Math.floor(maxTokens * 3.8))));
  return { text: `${keep.join("\n\n").trimEnd()}\n`, truncated: true, remainingTokens: total - used };
}
