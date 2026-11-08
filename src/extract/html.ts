/**
 * A small, forgiving HTML parser for the no-Chrome mode. It builds a plain
 * element tree (no CSS, no layout, no scripts) good enough for reading
 * articles and search result pages. Handles comments, raw-text elements,
 * void elements, implied end tags and entities. Not a spec-complete parser.
 */

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Child[];
  parent: El | undefined;
}
export type Child = El | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp"]);
/** Opening one of these closes an open <p>. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
/** Opening the key closes an open element in the value set (within the nearest scope). */
const IMPLIED: Record<string, string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
  thead: ["tbody", "tfoot"],
  tbody: ["thead", "tbody", "tfoot"],
  tfoot: ["thead", "tbody"],
};
const SCOPE = new Set(["ul", "ol", "table", "dl", "select", "html", "body"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•", copy: "©",
  reg: "®", trade: "™", times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  shy: "", zwj: "", zwnj: "", rarr: "→", larr: "←", uarr: "↑", darr: "↓", harr: "↔", sect: "§", para: "¶",
  frac12: "½", frac14: "¼", frac34: "¾", plusmn: "±", ne: "≠", le: "≤", ge: "≥", infin: "∞", check: "✓",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function parseHtml(html: string): El {
  const root: El = { tag: "#document", attrs: {}, children: [], parent: undefined };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  const text = (t: string) => {
    if (!t) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (typeof last === "string") parent.children[parent.children.length - 1] = last + decodeEntities(t);
    else parent.children.push(decodeEntities(t));
  };
  const closeUntil = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i]!.tag === tag) {
        stack.length = i;
        return;
      }
    }
  };
  const inScope = (tags: string[]): string | undefined => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = stack[i]!.tag;
      if (tags.includes(t)) return t;
      if (SCOPE.has(t)) return undefined;
    }
    return undefined;
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/.exec(html.slice(lt, lt + 4096));
    if (!m) {
      text("<");
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (closing) {
      if (tag === "p" && !inScope(["p"])) {
        // </p> with no open <p> makes an empty paragraph; ignore it.
        continue;
      }
      if (stack.some((e) => e.tag === tag)) closeUntil(tag);
      continue;
    }
    if (tag === "p" || CLOSES_P.has(tag)) {
      if (inScope(["p"])) closeUntil("p");
    }
    const implied = IMPLIED[tag];
    if (implied) {
      const open = inScope(implied);
      if (open) closeUntil(open);
    }
    const el: El = { tag, attrs: parseAttrs(m[3] ?? ""), children: [], parent: top() };
    top().children.push(el);
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, "gi");
      re.lastIndex = i;
      const hit = re.exec(html);
      const end = hit ? hit.index : n;
      const body = html.slice(i, end);
      if (body) el.children.push(tag === "script" || tag === "style" ? body : decodeEntities(body));
      i = hit ? end + hit[0].length : n;
      continue;
    }
    if (VOID.has(tag) || m[3]?.trimEnd().endsWith("/")) continue;
    stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- queries

export function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    yield c;
    yield* walk(c);
  }
}

export function findAll(el: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  for (const e of walk(el)) if (pred(e)) out.push(e);
  return out;
}

export function find(el: El, pred: (e: El) => boolean): El | undefined {
  for (const e of walk(el)) if (pred(e)) return e;
  return undefined;
}

export function hasClass(el: El, name: string): boolean {
  return (` ${el.attrs.class ?? ""} `).replace(/\s+/g, " ").includes(` ${name} `);
}

export function closest(el: El, pred: (e: El) => boolean): El | undefined {
  for (let e: El | undefined = el; e; e = e.parent) if (pred(e)) return e;
  return undefined;
}

/** Text content with whitespace collapsed (raw-text elements excluded). */
export function textOf(el: El): string {
  let out = "";
  const visit = (e: El) => {
    if (e.tag === "script" || e.tag === "style" || e.tag === "template") return;
    for (const c of e.children) {
      if (typeof c === "string") out += c;
      else {
        if (c.tag === "br") out += " ";
        visit(c);
        if (BLOCKISH.has(c.tag)) out += " ";
      }
    }
  };
  visit(el);
  return out.replace(/[\s ]+/g, " ").trim();
}

const BLOCKISH = new Set(["p", "div", "li", "td", "th", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "blockquote", "dd", "dt"]);
