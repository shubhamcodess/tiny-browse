import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEntities, find, findAll, hasClass, parseHtml, textOf } from "../src/extract/html.js";
import { extractLite } from "../src/extract/lite.js";
import { quality, renderDocument } from "../src/extract/markdown.js";
import { parseHttpSerp } from "../src/search/http-search.js";
import { PROVIDERS } from "../src/search/providers.js";

const fixture = (p: string) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8");

describe("lite HTML parser", () => {
  it("decodes entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#8212; &#x2014; &mdash; &nbsp;&unknown;")).toBe("a & b <c> — — —  &unknown;");
  });

  it("handles implied end tags, void elements, comments and raw text", () => {
    const doc = parseHtml(`<ul><li>one<li>two</ul><p>a<p>b<br>c<!-- <p>hidden --><script>if (a < b) "</p>"</script><table><tr><td>1<td>2<tr><td>3</table>`);
    expect(findAll(doc, (e) => e.tag === "li").map(textOf)).toEqual(["one", "two"]);
    expect(findAll(doc, (e) => e.tag === "p").map(textOf)).toEqual(["a", "b c"]);
    expect(String(find(doc, (e) => e.tag === "script")!.children[0])).toBe('if (a < b) "</p>"');
    expect(findAll(doc, (e) => e.tag === "tr").length).toBe(2);
    expect(findAll(doc, (e) => e.tag === "td").map(textOf)).toEqual(["1", "2", "3"]);
  });

  it("matches classes exactly", () => {
    const doc = parseHtml(`<div class="result  result--ad x"></div><div class="results"></div>`);
    expect(findAll(doc, (e) => hasClass(e, "result")).length).toBe(1);
  });
});

describe("lite extractor (no Chrome)", () => {
  const doc = extractLite(fixture("pages/article.html"), "https://ex.com/a");
  const md = renderDocument(doc, { links: "reference", images: "off", titleLevel: 1, header: true }).markdown;

  it("keeps the article's structure", () => {
    expect(md).toMatch(/^# Understanding Backpressure in Streams/);
    expect(md).toContain("Ada Example · 2026-03-14");
    expect(md).toContain('```js\nconst ok = writable.write(chunk);\nif (!ok) {\n  await once(writable, "drain");\n}\n```');
    expect(md).toContain("| Approach | Memory | Complexity |");
    expect(md).toMatch(/2\. Prefer `pipeline\(\)` for chains:\n\n {3}- it forwards errors/);
    expect(md).toContain("> Backpressure is not an error.");
    expect(md).toContain("[image: Producer and consumer with a bounded buffer]");
    expect(md).toMatch(/\[Node\.js guide\]\[1\]/);
    expect(quality(doc)).toBeGreaterThan(0.6);
  });

  it("drops clutter and hidden text", () => {
    for (const junk of ["cookies", "Careers", "Related posts", "Twitter", "Great post", "Privacy", "IGNORE ALL PREVIOUS", "screen readers", "Decorative duplicate"]) {
      expect(md, junk).not.toContain(junk);
    }
  });

  it("uses the JSON-LD body for script-rendered pages", () => {
    const d = extractLite(fixture("pages/jsonld.html"), "https://news.example/a");
    const out = renderDocument(d, { links: "reference", images: "off", titleLevel: 1, header: true }).markdown;
    expect(out).toContain("twelve kilometres of protected bike lanes");
    expect(d.stats.root).toBe("lite:json-ld");
  });
});

describe("search results over plain HTTP", () => {
  it("parses DuckDuckGo's HTML results and skips ads", () => {
    const page = parseHttpSerp(PROVIDERS.duckduckgo, fixture("serp/duckduckgo-results.html"), "https://html.duckduckgo.com/html/?q=x", 200, "python list comprehension");
    expect(page.status).toBe("ok");
    expect(page.results.map((r) => r.url)).toEqual([
      "https://docs.python.org/3/tutorial/datastructures.html#list-comprehensions",
      "https://realpython.com/list-comprehension-python/",
      "https://www.w3schools.com/python/python_lists_comprehension.asp",
    ]);
    expect(page.results[0]!.title).toBe("5. Data Structures — Python 3 documentation");
    expect(page.results[0]!.snippet).toMatch(/concise way to create lists/);
  });

  it("parses Bing's results page", () => {
    const page = parseHttpSerp(PROVIDERS.bing, fixture("serp/bing-results.html"), "https://www.bing.com/search?q=x", 200, "rust programming language");
    expect(page.status).toBe("ok");
    expect(page.results).toHaveLength(10);
    expect(page.results[0]).toMatchObject({ title: "Rust Programming Language", url: "https://rust-lang.org/" });
  });

  it("recognises DuckDuckGo's bot check", () => {
    const page = parseHttpSerp(PROVIDERS.duckduckgo, fixture("serp/duckduckgo-challenge.html"), "https://html.duckduckgo.com/html/?q=x", 202);
    expect(page.status).toBe("challenge");
  });
});
