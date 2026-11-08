/**
 * Heading-aware chunks of a rendered Markdown page, BM25 ranking against a
 * question, and packing into a token budget.
 *
 * - A chunk is a section under a heading and carries its heading path
 *   ("Install › macOS"), so it reads on its own.
 * - Code fences and tables are never split; oversized sections are split at
 *   paragraph boundaries.
 * - Reference-style link definitions ([1]: url) are set aside and re-attached
 *   for the links the chosen chunks actually use.
 */
import { countTokens } from "../util/tokens.js";

export interface Chunk {
  index: number;
  /** Heading path, outermost first. */
  path: string[];
  text: string;
  tokens: number;
}

export interface SplitDoc {
  /** Everything before the first chunk that must always be shown (title, source line). */
  head: string;
  chunks: Chunk[];
  /** Reference link number -> URL. */
  refs: Map<string, string>;
}

const FENCE = /^(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const REF_DEF = /^\[(\d+)\]:\s+(\S+)\s*$/;

/** Split a document rendered by renderDocument() into a head and chunks. */
export function splitDocument(md: string, opts: { maxTokens?: number; minTokens?: number } = {}): SplitDoc {
  const maxTokens = opts.maxTokens ?? 600;
  const minTokens = opts.minTokens ?? 60;
  const lines = md.replace(/\s+$/, "").split("\n");

  // Reference definitions sit at the very end.
  const found: [string, string][] = [];
  while (lines.length && (REF_DEF.test(lines.at(-1)!) || lines.at(-1) === "")) {
    const m = REF_DEF.exec(lines.pop()!);
    if (m) found.unshift([m[1]!, m[2]!]);
  }
  const refs = new Map(found);

  // Blocks: paragraphs, fenced code (kept whole) and headings.
  type Raw = { heading?: { level: number; text: string }; text: string };
  const blocks: Raw[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (buf.length) blocks.push({ text: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    if (fence) {
      buf.push(line);
      if (line.startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      flush();
      fence = f[1]!;
      buf.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ heading: { level: h[1]!.length, text: h[2]!.trim() }, text: line });
      continue;
    }
    if (line.trim() === "") flush();
    else buf.push(line);
  }
  flush();

  // Head: the title heading (level of the first heading) and the "> source" line.
  const head: string[] = [];
  let i = 0;
  if (blocks[0]?.heading) head.push(blocks[i++]!.text);
  while (blocks[i] && !blocks[i]!.heading && blocks[i]!.text.startsWith("> ") && head.length < 2) head.push(blocks[i++]!.text);
  const titleLevel = blocks[0]?.heading?.level ?? 0;

  // Sections.
  type Section = { path: string[]; parts: string[] };
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let cur: Section = { path: [], parts: [] };
  for (; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.heading && b.heading.level > titleLevel) {
      if (cur.parts.length) sections.push(cur);
      while (stack.length && stack.at(-1)!.level >= b.heading.level) stack.pop();
      stack.push(b.heading);
      cur = { path: stack.map((s) => s.text), parts: [b.text] };
    } else {
      cur.parts.push(b.text);
    }
  }
  if (cur.parts.length) sections.push(cur);

  // Size: split big sections at block boundaries, merge tiny neighbours.
  const pieces: { path: string[]; text: string; tokens: number }[] = [];
  for (const s of sections) {
    let acc: string[] = [];
    let accTokens = 0;
    for (const part of s.parts) {
      const t = countTokens(part);
      // Split before this part, but never leave a heading alone in its own piece.
      const headingOnly = acc.length === 1 && HEADING.test(acc[0]!);
      if (acc.length && !headingOnly && accTokens + t > maxTokens) {
        pieces.push({ path: s.path, text: acc.join("\n\n"), tokens: accTokens });
        acc = [];
        accTokens = 0;
      }
      acc.push(part);
      accTokens += t;
    }
    if (acc.length) pieces.push({ path: s.path, text: acc.join("\n\n"), tokens: accTokens });
  }
  const merged: typeof pieces = [];
  for (const p of pieces) {
    const prev = merged.at(-1);
    if (prev && prev.tokens < minTokens && prev.tokens + p.tokens <= maxTokens) {
      prev.text = `${prev.text}\n\n${p.text}`;
      prev.tokens += p.tokens;
      prev.path = p.path.length >= prev.path.length ? p.path : prev.path;
    } else merged.push({ ...p });
  }

  return {
    head: head.join("\n\n"),
    chunks: merged.map((p, index) => ({ index, path: p.path, text: p.text, tokens: p.tokens })),
    refs,
  };
}

// ---------------------------------------------------------------- BM25

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its of on or that the their them then there these this to was we what when where which who why will with you your".split(" "),
);

/** Lowercase words, light stemming, no stopwords. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m)));
}

/** BM25 score of each chunk for `query`, with extra weight for matches in the heading path. */
export function rankChunks(chunks: Chunk[], query: string): number[] {
  const q = [...new Set(terms(query))];
  if (!q.length || !chunks.length) return chunks.map(() => 0);
  const docs = chunks.map((c) => terms(`${c.text}`));
  const heads = chunks.map((c) => new Set(terms(c.path.join(" "))));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      if (f) s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
      if (heads[i]!.has(t)) s += idf * 0.8;
    }
    return s;
  });
}

// ---------------------------------------------------------------- packing

export interface Packed {
  text: string;
  tokens: number;
  /** Chunks included, in document order. */
  included: number[];
  /** First chunk not shown in reading order (for a cursor), or -1 if the rest fit. */
  next: number;
  /** Tokens of the document left out. */
  omittedTokens: number;
}

/**
 * Fit a split document into `budget` tokens.
 * - No question: chunks in order from `start` until the budget runs out.
 * - With a question: the opening chunk, then the best-matching chunks, shown
 *   in document order with "…" where sections were skipped.
 */
export function pack(doc: SplitDoc, budget: number, opts: { focus?: string; start?: number } = {}): Packed {
  const start = Math.max(0, Math.min(opts.start ?? 0, doc.chunks.length));
  const headTokens = countTokens(doc.head) + 2;
  let room = budget - headTokens - refsCost(doc, []);
  const chosen = new Set<number>();

  const fits = (c: Chunk) => c.tokens + 2 + refsCostFor(doc, c) <= room;
  const take = (c: Chunk) => {
    chosen.add(c.index);
    room -= c.tokens + 2 + refsCostFor(doc, c);
  };

  // A section that doesn't fit whole may still be worth its opening lines.
  let partialOf: Chunk | undefined;
  if (opts.focus && start === 0) {
    const scores = rankChunks(doc.chunks, opts.focus);
    const first = doc.chunks[0];
    if (first && fits(first)) take(first);
    const order = doc.chunks
      .filter((c) => c.index !== 0)
      .sort((a, b) => scores[b.index]! - scores[a.index]! || a.index - b.index);
    for (const c of order) {
      if (scores[c.index]! <= 0) break;
      if (fits(c)) take(c);
      else partialOf ??= c; // the best match that didn't fit
    }
  } else {
    for (const c of doc.chunks.slice(start)) {
      if (!fits(c)) {
        partialOf = c; // next in reading order
        break;
      }
      take(c);
    }
  }
  const partial = partialOf && room > 80 ? cutText(partialOf.text, room) : "";

  const included = [...chosen].sort((a, b) => a - b);
  const entries: [number, string][] = included.map((i) => [i, doc.chunks[i]!.text]);
  if (partial) entries.push([partialOf!.index, partial]);
  entries.sort((a, b) => a[0] - b[0]);

  const parts: string[] = [];
  if (start > 0) parts.push("…");
  let prev = start - 1;
  for (const [i, text] of entries) {
    if (i > prev + 1 && parts.length) parts.push("…");
    parts.push(text);
    prev = i;
  }
  const body = parts.join("\n\n");
  const used = usedRefs(doc, body);
  const defs = [...used].map((n) => `[${n}]: ${doc.refs.get(n)}`).join("\n");
  const text = [doc.head, body, defs].filter(Boolean).join("\n\n").trim() + "\n";

  const shown = new Set(included);
  const firstMissing = doc.chunks.findIndex((c) => c.index >= start && !shown.has(c.index));
  const omittedTokens = doc.chunks.filter((c) => !shown.has(c.index)).reduce((n, c) => n + c.tokens, 0);
  return { text, tokens: countTokens(text), included, next: firstMissing, omittedTokens };
}

function usedRefs(doc: SplitDoc, text: string): Set<string> {
  const used = new Set<string>();
  for (const m of text.matchAll(/\]\[(\d+)\]/g)) if (doc.refs.has(m[1]!)) used.add(m[1]!);
  return used;
}

function refsCostFor(doc: SplitDoc, c: Chunk): number {
  return refsCost(doc, [c.text]);
}

function refsCost(doc: SplitDoc, texts: string[]): number {
  let n = 0;
  for (const t of texts) for (const r of usedRefs(doc, t)) n += countTokens(`[${r}]: ${doc.refs.get(r)}`) + 1;
  return n;
}

function cutText(text: string, budget: number): string {
  const words = text.split(/(\s+)/);
  let out = "";
  for (const w of words) {
    if (countTokens(out + w) > budget - 8) break;
    out += w;
  }
  // Never leave a code fence open.
  const fences = out.split("\n").filter((l) => FENCE.test(l));
  const close = fences.length % 2 === 1 ? `\n${FENCE.exec(fences.at(-1)!)![1]}` : "";
  return `${out.trimEnd()} …${close}`;
}
