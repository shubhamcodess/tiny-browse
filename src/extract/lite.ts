/**
 * No-Chrome extraction: HTML string -> the same block tree the in-page
 * extractor produces, so rendering, chunking, focus and cursors work
 * unchanged. Without layout it relies on markup only (semantic tags, roles,
 * hidden attributes, inline styles, class names), so quality is lower than
 * the Chrome path; it never runs page scripts.
 */
import { closest, find, findAll, parseHtml, textOf, type Child, type El } from "./html.js";
import { IMG_CLOSE, IMG_OPEN, LINK_CLOSE, LINK_MID, LINK_OPEN, type Block, type Extracted, type PageImage } from "./types.js";

const DROP = new Set([
  "script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg", "video", "audio", "form", "button",
  "input", "select", "textarea", "label", "nav", "aside", "dialog", "map", "head", "link", "meta", "title",
]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "ul", "ol", "li", "table", "pre", "blockquote", "figure", "figcaption", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "dl", "dt", "dd", "details", "summary", "header", "footer", "address", "center", "body", "html", "tbody",
  "thead", "tfoot", "tr", "td", "th", "caption", "picture",
]);
const BOILER =
  /(^|[-_\s])(cookie|consent|gdpr|banner|share|sharing|social|newsletter|subscribe|signup|promo|related|recommend(ed|ations)?|comments?|sidebar|breadcrumbs?|advert(isement)?|ads?|sponsor(ed)?|popup|modal|overlay|toolbar|pagination|pager|footer|masthead|navbar|menu|skip-link|sr-only|visually-hidden|screen-reader-text)([-_\s]|$)/i;
const BAD_ROLE = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar)$/;

export function extractLite(html: string, url: string, opts: { minImageSize: number } = { minImageSize: 64 }): Extracted {
  const doc = parseHtml(html);
  const baseHref = find(doc, (e) => e.tag === "base" && !!e.attrs.href)?.attrs.href;
  const base = safeUrl(baseHref ?? "", url) ?? url;
  const abs = (u: string | undefined) => (u ? safeUrl(u.trim(), base) ?? "" : "");

  // ---------- metadata
  const meta = (key: string) => {
    const m = find(doc, (e) => e.tag === "meta" && (e.attrs.property === key || e.attrs.name === key));
    return clean(m?.attrs.content);
  };
  const ld: Record<string, any>[] = [];
  for (const s of findAll(doc, (e) => e.tag === "script" && /ld\+json/i.test(e.attrs.type ?? ""))) {
    try {
      const v = JSON.parse(String(s.children[0] ?? ""));
      const stack = Array.isArray(v) ? [...v] : [v];
      while (stack.length) {
        const x = stack.shift();
        if (!x || typeof x !== "object") continue;
        if (Array.isArray(x["@graph"])) stack.push(...x["@graph"]);
        ld.push(x);
      }
    } catch {
      // broken JSON-LD
    }
  }
  const article = ld.find((x) => /Article|BlogPosting|NewsArticle|TechArticle|Report|WebPage/.test(String(x["@type"])));
  const ldAuthor = (a: any): string => (Array.isArray(a) ? a.map(ldAuthor).filter(Boolean).join(", ") : typeof a === "string" ? a : clean(a?.name));
  const titleEl = find(doc, (e) => e.tag === "title");
  const h1 = find(doc, (e) => e.tag === "h1");
  const htmlEl = find(doc, (e) => e.tag === "html");
  const metaOut = {
    url,
    canonical: abs(find(doc, (e) => e.tag === "link" && /\bcanonical\b/i.test(e.attrs.rel ?? ""))?.attrs.href) || url,
    title: meta("og:title") || clean(article?.headline) || (h1 ? textOf(h1) : "") || (titleEl ? textOf(titleEl) : ""),
    siteName: meta("og:site_name"),
    description: meta("description") || meta("og:description"),
    published: clean(article?.datePublished) || meta("article:published_time") || clean(find(doc, (e) => e.tag === "time" && !!e.attrs.datetime)?.attrs.datetime),
    author: ldAuthor(article?.author) || meta("author"),
    lang: clean(htmlEl?.attrs.lang),
  };

  // ---------- visibility & boilerplate (markup only)
  const hidden = (e: El) => {
    if ("hidden" in e.attrs || e.attrs["aria-hidden"] === "true") return true;
    const style = (e.attrs.style ?? "").replace(/\s+/g, "").toLowerCase();
    return /display:none|visibility:hidden|opacity:0(?![.\d])/.test(style);
  };
  const isBoiler = (e: El, inArticle: boolean) => {
    if (DROP.has(e.tag) || hidden(e)) return true;
    if (BAD_ROLE.test(e.attrs.role ?? "")) return true;
    if ((e.tag === "header" || e.tag === "footer") && !inArticle) return true;
    if (e.tag === "footer") return true;
    const name = `${e.attrs.class ?? ""} ${e.attrs.id ?? ""}`;
    if (name.trim() && BOILER.test(name)) {
      const t = textOf(e).length;
      if (t < 300 || linkLen(e) / Math.max(1, t) > 0.4) return true;
    }
    return false;
  };

  // ---------- main content
  const body = find(doc, (e) => e.tag === "body") ?? doc;
  const bodyChars = textOf(body).length;
  const semantic = findAll(body, (e) => e.tag === "main" || e.tag === "article" || e.attrs.role === "main" || e.attrs.itemprop === "articleBody")
    .filter((e) => !hidden(e))
    .sort((a, b) => textOf(b).length - textOf(a).length);
  let root: El = semantic[0] ?? body;
  let how = semantic[0] ? `semantic:${root.tag}` : "body";
  if (!semantic[0] || textOf(root).length < 200) {
    // Score containers by the prose in their paragraphs, readability-style.
    const scores = new Map<El, number>();
    for (const p of findAll(body, (e) => e.tag === "p" || e.tag === "pre" || e.tag === "blockquote")) {
      const t = textOf(p);
      if (t.length < 25) continue;
      const s = 1 + (t.match(/[,，、]/g) ?? []).length + Math.min(t.length / 100, 3);
      let node = p.parent;
      for (let d = 0; node && d < 3; d++, node = node.parent) scores.set(node, (scores.get(node) ?? 0) + s / (d === 0 ? 1 : d * 2));
    }
    let best = 0;
    for (const [el, raw] of scores) {
      if (closest(el, (a) => isBoiler(a, false) && a !== body)) continue;
      const t = textOf(el).length;
      if (t < 100) continue;
      const score = raw * (1 - Math.min(linkLen(el) / t, 0.95));
      if (score > best) {
        best = score;
        root = el;
        how = `scored:${el.tag}`;
      }
    }
  }
  // Landing pages: no dominant article, use the whole body minus boilerplate.
  const rootChars = textOf(root).length;
  if (root !== body && rootChars < 1500 && rootChars < bodyChars * 0.3) {
    root = body;
    how = "landing";
  }

  // ---------- inline
  const links: string[] = [];
  const linkIndex = new Map<string, number>();
  const images: PageImage[] = [];
  const imageRef = (img: El, caption = ""): number => {
    const w = Number(img.attrs.width) || 0;
    const h = Number(img.attrs.height) || 0;
    if ((w && w < opts.minImageSize) || (h && h < opts.minImageSize)) return -1;
    if (!w && !h && !img.attrs.alt) return -1; // unknown size and no description: likely decoration
    const src = abs(img.attrs.src || img.attrs["data-src"] || "");
    if (!/^https?:/.test(src)) return -1;
    images.push({ src, alt: clean(img.attrs.alt), caption, width: w, height: h });
    return images.length - 1;
  };
  const tick = (s: string) => (s.includes("`") ? "`` " + s + " ``" : "`" + s + "`");

  const inline = (c: Child, inArticle: boolean): string => {
    if (typeof c === "string") return ws(c);
    if (isBoiler(c, inArticle)) return "";
    const tag = c.tag;
    if (tag === "br") return "\n";
    if (tag === "img") {
      const n = imageRef(c);
      return n >= 0 ? IMG_OPEN + n + IMG_CLOSE : "";
    }
    if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
      const t = textOf(c);
      return t ? tick(t) : "";
    }
    let inner = c.children.map((x) => inline(x, inArticle)).join("");
    if (tag === "a") {
      const href = c.attrs.href ?? "";
      const text = inner.trim();
      if (!text || (href.startsWith("#") && (text.length <= 2 || /^\[\w{1,4}\]$/.test(text)))) return href.startsWith("#") ? "" : inner;
      if (/^(javascript|mailto|tel):/i.test(href) || href.startsWith("#")) return inner;
      const u = abs(href);
      if (!u) return inner;
      let n = linkIndex.get(u);
      if (n === undefined) {
        n = links.length;
        links.push(u);
        linkIndex.set(u, n);
      }
      return LINK_OPEN + n + LINK_MID + text + LINK_CLOSE;
    }
    const t = inner.trim();
    if (!t) return inner;
    const lead = inner.startsWith(" ") ? " " : "";
    const trail = inner.endsWith(" ") ? " " : "";
    if (tag === "b" || tag === "strong") inner = `${lead}**${t}**${trail}`;
    else if (tag === "i" || tag === "em") inner = `${lead}*${t}*${trail}`;
    return inner;
  };

  const codeLang = (pre: El): string => {
    for (const e of [pre, find(pre, (x) => x.tag === "code"), pre.parent]) {
      if (!e) continue;
      const d = e.attrs["data-language"] || e.attrs["data-lang"];
      if (d) return d.toLowerCase();
      const m = /(?:^|\s)(?:language|lang|highlight-source|highlight|hljs|brush:?)-?([a-z0-9+#-]+)/i.exec(e.attrs.class ?? "");
      if (m && !/^(none|plaintext|text|nohighlight)$/i.test(m[1]!)) return m[1]!.toLowerCase();
    }
    return "";
  };
  const rawText = (e: El): string => {
    let out = "";
    const visit = (x: El) => {
      for (const c of x.children) {
        if (typeof c === "string") out += c;
        else if (c.tag === "br") out += "\n";
        else if (!/(^|\s)(lineno|linenos|line-number|line-numbers|gutter)(\s|$)/.test(c.attrs.class ?? "") && c.tag !== "button") visit(c);
      }
    };
    visit(e);
    return out.replace(/ /g, " ").replace(/^\n/, "").replace(/\s+$/, "");
  };

  const table = (t: El, inArticle: boolean): Block | null => {
    const rows: string[][] = [];
    let complex = false;
    let header = false;
    const trs = findAll(t, (e) => e.tag === "tr" && closest(e, (x) => x.tag === "table") === t);
    trs.forEach((tr, i) => {
      const cells = tr.children.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
      if (cells.some((c) => Number(c.attrs.rowspan) > 1 || Number(c.attrs.colspan) > 1)) complex = true;
      if (cells.some((c) => find(c, (x) => x.tag === "ul" || x.tag === "ol" || x.tag === "table" || x.tag === "pre"))) complex = true;
      if (i === 0 && (tr.parent?.tag === "thead" || (cells.length > 0 && cells.every((c) => c.tag === "th")))) header = true;
      rows.push(cells.map((c) => clean(c.children.map((x) => inline(x, inArticle)).join(""))));
    });
    if (!rows.length) return null;
    const cols = Math.max(...rows.map((r) => r.length));
    if (cols <= 1 || t.attrs.role === "presentation") return null;
    return { t: "table", rows, header, complex };
  };

  const walkBlocks = (el: El, out: Block[], inArticle: boolean): void => {
    let buf = "";
    const flush = () => {
      const text = buf.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();
      if (text) out.push({ t: "p", text });
      buf = "";
    };
    for (const c of el.children) {
      if (typeof c === "string") {
        buf += ws(c);
        continue;
      }
      const inA = inArticle || c.tag === "article" || c.tag === "main";
      if (isBoiler(c, inA)) continue;
      const tag = c.tag;
      if (!BLOCK.has(tag)) {
        buf += inline(c, inA);
        continue;
      }
      flush();
      if (/^h[1-6]$/.test(tag)) {
        const text = clean(c.children.map((x) => inline(x, inA)).join("").replace(/\n/g, " "));
        if (text) out.push({ t: "h", level: Number(tag[1]), size: 0, text });
      } else if (tag === "pre") {
        const text = rawText(c);
        if (text.trim()) out.push({ t: "code", lang: codeLang(c), text });
      } else if (tag === "ul" || tag === "ol") {
        const items: Block[][] = [];
        for (const li of c.children) {
          if (typeof li === "string" || li.tag !== "li" || isBoiler(li, inA)) continue;
          const blocks: Block[] = [];
          walkBlocks(li, blocks, inA);
          if (blocks.length) items.push(blocks);
        }
        if (items.length) out.push({ t: "list", ordered: tag === "ol", start: Number(c.attrs.start) || 1, items });
      } else if (tag === "dl") {
        const items: Block[][] = [];
        for (const d of c.children) {
          if (typeof d === "string") continue;
          const text = clean(d.children.map((x) => inline(x, inA)).join(""));
          if (!text) continue;
          if (d.tag === "dt") items.push([{ t: "p", text: `**${text}**` }]);
          else if (items.length) items[items.length - 1]!.push({ t: "p", text });
        }
        if (items.length) out.push({ t: "list", ordered: false, start: 1, items });
      } else if (tag === "table") {
        const tb = table(c, inA);
        if (tb) out.push(tb);
        else walkBlocks(c, out, inA);
      } else if (tag === "blockquote") {
        const blocks: Block[] = [];
        walkBlocks(c, blocks, inA);
        if (blocks.length) out.push({ t: "quote", blocks });
      } else if (tag === "hr") {
        out.push({ t: "hr" });
      } else if (tag === "figure") {
        const img = find(c, (x) => x.tag === "img");
        const cap = find(c, (x) => x.tag === "figcaption");
        const caption = cap ? clean(cap.children.map((x) => inline(x, inA)).join("")) : "";
        if (img && !find(c, (x) => x.tag === "pre" || x.tag === "table")) {
          const n = imageRef(img, caption);
          if (n >= 0) out.push({ t: "img", ref: n });
          else if (caption) out.push({ t: "p", text: caption });
        } else walkBlocks(c, out, inA);
      } else {
        walkBlocks(c, out, inA);
      }
    }
    flush();
  };

  const blocks: Block[] = [];
  // A heading just outside the chosen root (often the article title) is included.
  if (h1 && root !== body && !isInside(h1, root) && root.parent && isInside(h1, root.parent)) blocks.push({ t: "h", level: 1, size: 0, text: textOf(h1) });
  walkBlocks(root, blocks, root.tag === "article" || root.tag === "main");
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.t === "p") {
      const m = new RegExp(`^${IMG_OPEN}(\\d+)${IMG_CLOSE}$`).exec(b.text);
      if (m) blocks[i] = { t: "img", ref: Number(m[1]) };
    }
  }

  // JSON-LD body when the markup has almost nothing (script-rendered pages).
  let rootLabel = how;
  const domText = blocks.reduce((n, b) => n + (b.t === "p" ? b.text.length : 0), 0);
  const ldBody = clean(article?.articleBody);
  if (domText < 400 && ldBody.length > domText * 2 && ldBody.length > 400) {
    blocks.length = 0;
    for (const para of String(article!.articleBody).split(/\n\s*\n|\r\n\r\n/)) {
      const text = clean(para);
      if (text) blocks.push({ t: "p", text });
    }
    rootLabel = "json-ld";
  }

  const contentText = textOf(root);
  const boilerplateHits = (
    contentText.match(/accept (all )?cookies|enable javascript|sign in to continue|subscribe to continue|you have reached your limit|turn off your ad ?blocker|verify you are human/gi) ?? []
  ).length;

  return {
    meta: metaOut,
    blocks,
    links,
    images,
    stats: {
      textChars: contentText.length,
      linkChars: linkLen(root),
      paragraphs: blocks.filter((b) => b.t === "p").length,
      headings: blocks.filter((b) => b.t === "h").length,
      bodyChars,
      root: `lite:${rootLabel}`,
      boilerplateHits,
    },
  };
}

function linkLen(el: El): number {
  return findAll(el, (e) => e.tag === "a").reduce((n, a) => n + textOf(a).length, 0);
}

function isInside(el: El, ancestor: El): boolean {
  for (let e: El | undefined = el; e; e = e.parent) if (e === ancestor) return true;
  return false;
}

function ws(s: string): string {
  return s.replace(/[\s ]+/g, " ");
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\s ]+/g, " ").trim() : "";
}

function safeUrl(u: string, base: string): string | undefined {
  try {
    return new URL(u, base).href;
  } catch {
    return undefined;
  }
}
