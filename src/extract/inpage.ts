/// <reference lib="dom" />
/**
 * Runs INSIDE a loaded page (via Runtime.evaluate) and returns its main
 * content as a block tree (see types.ts). Serialized with toString(): keep it
 * self-contained, no imports used at runtime.
 *
 * It works from what is rendered, not from class names:
 * - main content = the block with the most prose and fewest links, near the
 *   centre, never fixed/sticky (semantic <main>/<article> get a bonus);
 * - boilerplate = hidden, fixed/sticky overlays, nav/aside/footer, forms,
 *   plus elements whose class/id says cookie/share/related/... AND that look
 *   like boilerplate (short or link-heavy);
 * - headings = h1-h6 plus text that is styled like a heading (large or bold,
 *   on its own line), so badly built pages still get structure.
 */
import type { Block, Extracted, PageImage } from "./types.js";

export interface ExtractOptions {
  /** Ignore images smaller than this (icons, avatars, tracking pixels). */
  minImageSize: number;
}

export function extractInPage(opts: ExtractOptions): Extracted {
  const L_OPEN = "\u0001";
  const L_MID = "\u0002";
  const L_CLOSE = "\u0003";
  const I_OPEN = "\u0004";
  const I_CLOSE = "\u0005";

  // Render everything (content-visibility:auto hides off-screen text).
  if (!document.getElementById("__tiny_browse_render_all")) {
    const style = document.createElement("style");
    style.id = "__tiny_browse_render_all";
    style.textContent = "*{content-visibility:visible!important;contain-intrinsic-size:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }

  const ws = (s: string) => s.replace(/[\s ]+/g, " ");
  const clean = (s: string | null | undefined) => ws(s || "").trim();
  const styleCache = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element) => {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };
  const abs = (u: string | null) => {
    if (!u) return "";
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return "";
    }
  };

  // ---------- metadata ----------
  const metaContent = (sel: string) => clean(document.querySelector(sel)?.getAttribute("content"));
  const ld: Record<string, any>[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const v = JSON.parse(s.textContent || "");
      const stack = Array.isArray(v) ? [...v] : [v];
      while (stack.length) {
        const x = stack.shift();
        if (!x || typeof x !== "object") continue;
        if (Array.isArray(x["@graph"])) stack.push(...x["@graph"]);
        ld.push(x);
      }
    } catch {
      // ignore broken JSON-LD
    }
  }
  const article = ld.find((x) => /Article|BlogPosting|NewsArticle|TechArticle|Report|WebPage/.test(String(x["@type"])));
  const ldAuthor = (a: any): string =>
    Array.isArray(a) ? a.map(ldAuthor).filter(Boolean).join(", ") : typeof a === "string" ? a : clean(a?.name);
  const h1 = document.querySelector("h1");
  const meta = {
    url: location.href,
    canonical: abs(document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "") || location.href,
    title:
      metaContent('meta[property="og:title"]') ||
      clean(article?.headline) ||
      clean(h1 ? (h1 as HTMLElement).innerText : "") ||
      clean(document.title),
    siteName: metaContent('meta[property="og:site_name"]') || clean(ld.find((x) => x["@type"] === "WebSite")?.name),
    description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
    published:
      clean(article?.datePublished) ||
      metaContent('meta[property="article:published_time"]') ||
      clean(document.querySelector("time[datetime]")?.getAttribute("datetime")),
    author: ldAuthor(article?.author) || metaContent('meta[name="author"]'),
    lang: clean(document.documentElement.lang),
  };

  // ---------- visibility & boilerplate ----------
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO",
    "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "NAV", "ASIDE", "DIALOG", "MAP", "HEAD", "LINK", "META",
  ]);
  const BOILER = /(^|[-_\s])(cookie|consent|gdpr|banner|share|sharing|social|newsletter|subscribe|signup|promo|related|recommend(ed|ations)?|comments?|sidebar|breadcrumbs?|advert(isement)?|ads?|sponsor(ed)?|popup|modal|overlay|toolbar|pagination|pager|footer|masthead|navbar|menu|skip-link|toc-sidebar|author-bio|byline-share)([-_\s]|$)/i;
  const viewW = innerWidth || 1280;

  const textLen = (el: Element) => clean((el as HTMLElement).innerText).length;
  const linkLen = (el: Element) => {
    let n = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) n += clean((a as HTMLElement).innerText).length;
    return n;
  };

  const hidden = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute("aria-hidden") === "true") return true;
    const s = css(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return true;
    const r = el.getBoundingClientRect();
    // Zero-size and clipped-away elements (screen-reader-only text included).
    if ((r.width < 1 || r.height < 1) && s.overflow === "hidden") return true;
    if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") return true;
    return false;
  };

  const isBoilerplate = (el: Element, inRoot: boolean): boolean => {
    if (SKIP_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute("role");
    if (role && /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar)$/.test(role)) return true;
    if ((el.tagName === "HEADER" || el.tagName === "FOOTER") && !(inRoot && el.closest("article") && textLen(el) > 400)) {
      // A header inside an article usually holds its title: keep it if it has a heading.
      if (el.tagName === "HEADER" && inRoot && el.querySelector("h1,h2")) return false;
      return true;
    }
    const s = css(el);
    if (s.position === "fixed" || s.position === "sticky") return true;
    const name = `${typeof el.className === "string" ? el.className : ""} ${el.id}`;
    if (name.trim() && BOILER.test(name)) {
      const t = textLen(el);
      // Only drop it if it also *looks* like boilerplate: short or mostly links.
      if (t < 300 || linkLen(el) / Math.max(1, t) > 0.4) return true;
    }
    return false;
  };

  // ---------- main content ----------
  const body = document.body;
  const bodyChars = body ? textLen(body) : 0;
  const scores = new Map<Element, number>();
  // Prose counts; list items don't (reference lists and link lists are long too).
  const PARA = "p, pre, blockquote";
  const NOT_ROOT = /^(UL|OL|DL|LI|DD|DT|TABLE|TBODY|THEAD|TR|TD|TH|BLOCKQUOTE|PRE|P|FIGURE|SPAN|A)$/;
  for (const p of Array.from(document.querySelectorAll(PARA))) {
    const t = clean((p as HTMLElement).innerText);
    if (t.length < 25 || hidden(p)) continue;
    const s = 1 + (t.match(/[,，、]/g) || []).length + Math.min(t.length / 100, 3);
    let node = p.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      scores.set(node, (scores.get(node) || 0) + s / (depth === 0 ? 1 : depth === 1 ? 2 : depth * 3));
    }
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, raw] of scores) {
    if (el === document.documentElement || NOT_ROOT.test(el.tagName) || hidden(el)) continue;
    let bad = false;
    for (let a: Element | null = el; a && a !== body; a = a.parentElement) {
      if (isBoilerplate(a, false)) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    const t = textLen(el);
    if (t < 100) continue;
    const density = linkLen(el) / t;
    let score = raw * (1 - Math.min(density, 0.95));
    if (/^(MAIN|ARTICLE)$/.test(el.tagName) || el.getAttribute("role") === "main" || el.getAttribute("itemprop") === "articleBody") {
      score *= 1.25;
    }
    const r = el.getBoundingClientRect();
    const centre = r.left + r.width / 2;
    if (r.width < viewW * 0.3 || Math.abs(centre - viewW / 2) > viewW * 0.3) score *= 0.7;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  let root: Element = best || document.querySelector("main, article, [role=main]") || body;
  let rootHow = best ? "scored" : root === body ? "body" : "semantic";
  // Widen to ancestors that add mostly prose (sections of a docs page, the
  // article header), with more room for <article>/<main>. Stop at link-heavy
  // ancestors (sidebars, navigation) and boilerplate.
  for (let i = 0; i < 6 && best; i++) {
    const p = root.parentElement;
    if (!p || p === body || p === document.documentElement || isBoilerplate(p, false)) break;
    const t = textLen(p);
    const rt = textLen(root);
    const addedLinks = linkLen(p) - linkLen(root);
    if (t <= rt) {
      // Same visible text: a wrapper. Skip it only if it brings hidden link lists.
      if (addedLinks > linkLen(root) * 0.2 + 50) break;
      root = p;
      continue;
    }
    const added = t - rt;
    const semantic = /^(ARTICLE|MAIN)$/.test(p.tagName) || p.getAttribute("role") === "main";
    // Reference pages are link-dense by design: allow more links inside <main>/<article>.
    const maxDensity = semantic ? 0.5 : 0.3;
    if (addedLinks / added < maxDensity && (t <= rt * 1.6 || (semantic && t <= rt * 10))) {
      root = p;
      rootHow += semantic ? "+semantic" : "+parent";
      continue;
    }
    break;
  }
  // Landing pages (home pages, product pages) have no dominant article: one
  // section would lose most of the page. Use the whole body, minus boilerplate.
  if (best && body && textLen(root) < 1500 && textLen(root) < bodyChars * 0.3) {
    root = body;
    rootHow = "landing";
  }
  // Pull in the page's h1 if it sits just outside the chosen root.
  const titleOutside = h1 && !root.contains(h1) && !hidden(h1) && root.parentElement?.contains(h1);
  if (titleOutside && root.parentElement && textLen(root.parentElement) <= textLen(root) * 1.3) {
    root = root.parentElement;
    rootHow += "+title";
  }

  // ---------- inline text ----------
  const links: string[] = [];
  const linkIndex = new Map<string, number>();
  const images: PageImage[] = [];

  const imageRef = (img: HTMLImageElement, caption = ""): number => {
    // Images may be blocked (not requested) and render as tiny broken boxes:
    // declared sizes win, then the natural size, then the layout box.
    const r = img.getBoundingClientRect();
    const w = Math.round(Number(img.getAttribute("width")) || img.naturalWidth || r.width || 0);
    const h = Math.round(Number(img.getAttribute("height")) || img.naturalHeight || r.height || 0);
    if (w < opts.minImageSize || h < opts.minImageSize) return -1;
    const src = abs(img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || "");
    if (!/^https?:/.test(src)) return -1;
    images.push({ src, alt: clean(img.alt), caption, width: w, height: h });
    return images.length - 1;
  };

  const codeTick = (s: string) => {
    const t = s.replace(/\n/g, " ");
    return t.includes("`") ? "`` " + t + " ``" : "`" + t + "`";
  };

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return ws(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (SKIP_TAGS.has(el.tagName) || hidden(el)) return "";
    const tag = el.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") {
      const n = imageRef(el as HTMLImageElement);
      return n >= 0 ? I_OPEN + n + I_CLOSE : "";
    }
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT") {
      const t = (el.textContent || "").trim();
      return t ? codeTick(t) : "";
    }
    const math = mathTex(el);
    if (math !== null) return `$${math}$`;
    let inner = "";
    for (const c of Array.from(el.childNodes)) inner += inline(c);
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      const text = inner.trim();
      // Heading permalinks ("#", "¶"), citation markers ("[12]") and empty links carry nothing.
      if (!text || (href.startsWith("#") && (text.length <= 2 || /^\[\w{1,4}\]$/.test(text)))) {
        return href.startsWith("#") ? "" : inner;
      }
      if (/^(javascript|mailto|tel):/i.test(href) || href.startsWith("#")) return inner;
      const url = abs(href);
      if (!url) return inner;
      let n = linkIndex.get(url);
      if (n === undefined) {
        n = links.length;
        links.push(url);
        linkIndex.set(url, n);
      }
      return L_OPEN + n + L_MID + text + L_CLOSE;
    }
    const s = css(el);
    const bold = tag === "B" || tag === "STRONG" || Number(s.fontWeight) >= 700;
    const italic = tag === "I" || tag === "EM" || s.fontStyle === "italic";
    const t = inner.trim();
    if (!t) return inner;
    const lead = inner.startsWith(" ") ? " " : "";
    const trail = inner.endsWith(" ") ? " " : "";
    if (bold && !/^\*\*.*\*\*$/.test(t) && !isHeadingLike(el)) return `${lead}**${t}**${trail}`;
    if (italic && tag !== "CITE") return `${lead}*${t}*${trail}`;
    return inner;
  };

  const mathTex = (el: Element): string | null => {
    if (el.classList.contains("katex") || el.classList.contains("katex-display")) {
      const a = el.querySelector('annotation[encoding="application/x-tex"]');
      return a ? clean(a.textContent) : null;
    }
    if (el.tagName === "MATH" || el.tagName === "math") {
      const a = el.querySelector('annotation[encoding="application/x-tex"]');
      return a ? clean(a.textContent) : clean(el.getAttribute("alttext")) || null;
    }
    if (el.tagName === "MJX-CONTAINER") {
      const a = el.querySelector("annotation") || el.querySelector("mjx-assistive-mml annotation");
      return a ? clean(a.textContent) : null;
    }
    return null;
  };

  // ---------- headings by appearance ----------
  const bodyFont = parseFloat(css(root).fontSize) || 16;
  function isHeadingLike(el: Element): boolean {
    if (/^H[1-6]$/.test(el.tagName) || el.getAttribute("role") === "heading") return true;
    return false;
  }
  const visualHeading = (el: Element): number => {
    // Returns font size if `el` looks like a heading, else 0.
    const s = css(el);
    if (!s.display.startsWith("block") && s.display !== "flex" && s.display !== "list-item") return 0;
    const text = clean((el as HTMLElement).innerText);
    if (text.length < 2 || text.length > 120 || /[.:;,]$/.test(text) || text.includes("\n")) return 0;
    if (el.querySelector("p, div, ul, ol, table, pre, img")) return 0;
    const size = parseFloat(s.fontSize) || 0;
    const weight = Number(s.fontWeight) || 400;
    if (size >= bodyFont * 1.3 || (size >= bodyFont * 1.1 && weight >= 600)) return size;
    return 0;
  };

  // ---------- block walk ----------
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|flow-root|table-row-group|table-row|table-cell)/;
  const isBlock = (el: Element) => {
    if (/^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|TABLE|PRE|BLOCKQUOTE|FIGURE|H[1-6]|HR|DL|DT|DD|DETAILS|SUMMARY|HEADER)$/.test(el.tagName)) {
      return css(el).display !== "inline";
    }
    return BLOCK_DISPLAY.test(css(el).display);
  };

  const codeLang = (el: Element): string => {
    const marked = el.parentElement?.closest('[class*="highlight-"], [class*="language-"], [class*="lang-"], [data-language]');
    for (const e of [el, el.querySelector("code"), el.parentElement, marked]) {
      if (!e) continue;
      const d = e.getAttribute("data-language") || e.getAttribute("data-lang");
      if (d) return d.toLowerCase();
      const m = /(?:^|\s)(?:language|lang|highlight-source|highlight|hljs|brush:?)-?([a-z0-9+#-]+)/i.exec(
        typeof e.className === "string" ? e.className : "",
      );
      if (m && !/^(none|plaintext|text|nohighlight)$/i.test(m[1]!)) return m[1]!.toLowerCase();
    }
    return "";
  };

  const preText = (pre: Element): string => {
    const copy = pre.cloneNode(true) as Element;
    for (const g of Array.from(copy.querySelectorAll('.lineno, .linenos, .line-number, .line-numbers, .gutter, [class*="lineNumber"], [aria-hidden="true"], button'))) {
      g.remove();
    }
    const text = (copy as HTMLElement).innerText || copy.textContent || "";
    // innerText of a detached clone has no layout; textContent keeps newlines in <pre>.
    return (text.trim() ? text : copy.textContent || "").replace(/ /g, " ").replace(/\s+$/, "");
  };

  const table = (t: HTMLTableElement): Block | null => {
    const rows: string[][] = [];
    let complex = false;
    let header = false;
    const trs = Array.from(t.rows).filter((r) => r.closest("table") === t);
    for (const [i, tr] of trs.entries()) {
      const cells = Array.from(tr.cells);
      if (cells.some((c) => c.rowSpan > 1 || c.colSpan > 1)) complex = true;
      if (cells.some((c) => c.querySelector("p + p, ul, ol, table, pre"))) complex = true;
      if (i === 0 && (tr.parentElement?.tagName === "THEAD" || cells.every((c) => c.tagName === "TH"))) header = true;
      rows.push(cells.map((c) => clean(Array.from(c.childNodes).map(inline).join(""))));
    }
    if (!rows.length) return null;
    // Layout tables (one column, or role=presentation): treat as plain containers.
    const cols = Math.max(...rows.map((r) => r.length));
    if (cols <= 1 || t.getAttribute("role") === "presentation") return null;
    return { t: "table", rows, header, complex };
  };

  const walk = (el: Element, out: Block[], inRoot: boolean): void => {
    let buf = "";
    const flush = () => {
      const text = buf.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();
      if (text) out.push({ t: "p", text });
      buf = "";
    };
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        buf += ws(node.textContent || "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const c = node as HTMLElement;
      if (hidden(c) || isBoilerplate(c, inRoot)) continue;
      const tag = c.tagName;
      const math = mathTex(c);
      if (math !== null) {
        if (css(c).display.startsWith("block") || c.classList.contains("katex-display") || c.getAttribute("display") === "block") {
          flush();
          out.push({ t: "math", tex: math });
        } else buf += `$${math}$`;
        continue;
      }
      if (!isBlock(c)) {
        buf += inline(c);
        continue;
      }
      flush();
      if (/^H[1-6]$/.test(tag) || c.getAttribute("role") === "heading") {
        const text = clean(inline(c).replace(/\n/g, " "));
        if (text) {
          const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Number(c.getAttribute("aria-level")) || 2;
          out.push({ t: "h", level, size: parseFloat(css(c).fontSize) || 0, text });
        }
      } else if (tag === "PRE") {
        const text = preText(c);
        if (text.trim()) out.push({ t: "code", lang: codeLang(c), text });
      } else if (tag === "UL" || tag === "OL") {
        const items: Block[][] = [];
        for (const li of Array.from(c.children)) {
          if (li.tagName !== "LI" || hidden(li)) continue;
          const blocks: Block[] = [];
          walk(li, blocks, inRoot);
          if (blocks.length) items.push(blocks);
        }
        if (items.length) out.push({ t: "list", ordered: tag === "OL", start: Number(c.getAttribute("start")) || 1, items });
      } else if (tag === "DL") {
        const items: Block[][] = [];
        for (const d of Array.from(c.children)) {
          const text = clean(inline(d));
          if (!text) continue;
          if (d.tagName === "DT") items.push([{ t: "p", text: `**${text}**` }]);
          else if (items.length) items[items.length - 1]!.push({ t: "p", text });
        }
        if (items.length) out.push({ t: "list", ordered: false, start: 1, items });
      } else if (tag === "TABLE") {
        const tb = table(c as HTMLTableElement);
        if (tb) out.push(tb);
        else walk(c, out, inRoot);
      } else if (tag === "BLOCKQUOTE") {
        const blocks: Block[] = [];
        walk(c, blocks, inRoot);
        if (blocks.length) out.push({ t: "quote", blocks });
      } else if (tag === "HR") {
        out.push({ t: "hr" });
      } else if (tag === "FIGURE") {
        const img = c.querySelector("img") as HTMLImageElement | null;
        const cap = c.querySelector("figcaption");
        const caption = cap ? clean(inline(cap)) : "";
        if (img && !c.querySelector("pre, table")) {
          const n = imageRef(img, caption);
          if (n >= 0) out.push({ t: "img", ref: n });
          else if (caption) out.push({ t: "p", text: caption });
        } else walk(c, out, inRoot);
      } else {
        const size = visualHeading(c);
        if (size) {
          // Its own bold styling is what makes it a heading; don't repeat it as **text**.
          const text = clean(Array.from(c.childNodes).map(inline).join("").replace(/\n/g, " ")).replace(/^\*\*(.*)\*\*$/, "$1");
          if (text) out.push({ t: "h", level: 0, size, text });
        } else walk(c, out, inRoot);
      }
    }
    flush();
  };

  const blocks: Block[] = [];
  walk(root, blocks, true);

  // Lone images inside paragraphs become image blocks.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.t === "p") {
      const m = new RegExp(`^${I_OPEN}(\\d+)${I_CLOSE}$`).exec(b.text);
      if (m) blocks[i] = { t: "img", ref: Number(m[1]) };
    }
  }

  // JSON-LD body when the DOM gave us almost nothing (some JS-rendered news sites).
  const domText = blocks.reduce((n, b) => n + (b.t === "p" ? b.text.length : 0), 0);
  let rootLabel = `${rootHow}:${root.tagName.toLowerCase()}`;
  const ldBody = clean(article?.articleBody);
  if (domText < 400 && ldBody.length > domText * 2 && ldBody.length > 400) {
    blocks.length = 0;
    for (const para of String(article!.articleBody).split(/\n\s*\n|\r\n\r\n/)) {
      const text = clean(para);
      if (text) blocks.push({ t: "p", text });
    }
    rootLabel = "json-ld";
  }

  const contentText = clean((root as HTMLElement).innerText);
  const boilerplateHits = (
    contentText.match(/accept (all )?cookies|enable javascript|sign in to continue|subscribe to continue|you have reached your limit|turn off your ad ?blocker|verify you are human/gi) || []
  ).length;

  return {
    meta,
    blocks,
    links,
    images,
    stats: {
      textChars: contentText.length,
      linkChars: linkLen(root),
      paragraphs: blocks.filter((b) => b.t === "p").length,
      headings: blocks.filter((b) => b.t === "h").length,
      bodyChars,
      root: rootLabel,
      boilerplateHits,
    },
  };
}

export function extractExpression(opts: ExtractOptions): string {
  return `(${extractInPage.toString()})(${JSON.stringify(opts)})`;
}
