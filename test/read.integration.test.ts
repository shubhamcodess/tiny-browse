/**
 * Read real pages in real Chrome from a local server: extraction, boilerplate
 * removal, JS-rendered pages, JSON-LD bodies, content types and HTTP errors,
 * plus web_search's `read` end to end. Skipped without Chrome.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverBrowsers } from "../src/browser/discover.js";
import { defaultConfig, type Config } from "../src/config.js";
import { ChromeEngine } from "../src/core/chrome-engine.js";
import { setLogLevel } from "../src/util/log.js";
import { countTokens } from "../src/util/tokens.js";

setLogLevel("silent");

const DIR = new URL("./fixtures/pages/", import.meta.url).pathname;
const hasBrowser = discoverBrowsers().length > 0;

let server: Server;
let base: string;
let engine: ChromeEngine;
const accepts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/article")) accepts.push(String(req.headers.accept));
    const html = (f: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(DIR, f)));
    if (url === "/article") return html("article.html");
    if (url === "/spa") return html("spa.html");
    if (url === "/jsonld") return html("jsonld.html");
    if (url === "/notes.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("line one\nline two\n");
    if (url === "/data.json") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
    if (url === "/md") {
      // Content negotiation: Markdown for clients that ask for it.
      if (String(req.headers.accept).includes("text/markdown")) {
        return res.writeHead(200, { "content-type": "text/markdown" }).end("# Served as Markdown\n\nHello agents.\n");
      }
      return html("article.html");
    }
    if (url === "/paper.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
    if (url === "/diagram.png") {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(png); // vague type: sniffed
    }
    if (url === "/pixel.gif") return res.writeHead(404).end();
    res.writeHead(404, { "content-type": "text/html" }).end("<title>Not Found</title><h1>Not Found</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const config: Config = defaultConfig({});
  config.browser.profileDir = mkdtempSync(join(tmpdir(), "tiny-browse-read-"));
  config.cache.enabled = false;

  config.fetch.allowPrivateNetwork = true; // the test server is on 127.0.0.1
  engine = new ChromeEngine(config);
});

afterAll(async () => {
  await engine?.close();
  server?.close();
});

const signal = () => AbortSignal.timeout(30_000);

describe.skipIf(!hasBrowser)("reading pages (real Chrome)", () => {
  it("extracts an article and leaves the clutter behind", async () => {
    const r = await engine.fetch({ urls: [`${base}/article`], maxTokens: 8000, render: "auto", returnImages: false }, { signal: signal() });
    const md = r.markdown;
    const doc = (r.data.documents as any[])[0];
    expect(doc.ok).toBe(true);
    expect(doc.quality).toBeGreaterThan(0.6);

    // Structure
    expect(md).toMatch(/^# Understanding Backpressure in Streams/);
    expect(md).toContain("## How streams signal pressure"); // styled div became a heading
    expect(md).toContain("### A minimal example");
    expect(md).toContain('```js\nconst ok = writable.write(chunk);\nif (!ok) {\n  await once(writable, "drain");\n}\n```');
    expect(md).toContain("| Approach | Memory | Complexity |");
    expect(md).toMatch(/1\. Check the return value of `write\(\)`\.\n2\. Prefer `pipeline\(\)` for chains:\n\n {3}- it forwards errors/);
    expect(md).toContain("> Backpressure is not an error.");
    expect(md).toContain("[image: Producer and consumer with a bounded buffer]");
    expect(md).toMatch(/\*\*Backpressure\*\* is what happens/);
    expect(md).toMatch(/\[Node\.js guide\]\[\d\]/);
    expect(md).toContain("Ada Example · 2026-03-14");

    // Clutter
    for (const junk of ["cookies", "Careers", "Related posts", "Streams in depth", "Twitter", "Great post", "Privacy", "Copy", "[1]</", "IGNORE ALL PREVIOUS", "screen readers", "Decorative duplicate"]) {
      expect(md, junk).not.toContain(junk);
    }
    expect(md).not.toMatch(/guide\]\[\d\]\[1\]/); // citation marker dropped
    expect(md).toContain("<!-- begin untrusted content from 127.0.0.1 -->");
  }, 60_000);

  it("reads a server-rendered page over plain HTTP (the fast path)", async () => {
    const r = await engine.fetch({ urls: [`${base}/article`], maxTokens: 8000, render: "auto", returnImages: false }, { signal: signal() });
    const doc = (r.data.documents as any[])[0];
    expect(doc.tier).toBe("http");
    expect(r.markdown).toContain("## How streams signal pressure"); // layout still available offline
    expect(r.markdown).toContain("```js\nconst ok");
    expect(r.markdown).not.toContain("cookies");
  }, 60_000);

  it("falls back to Chrome for pages that need JavaScript, and remembers the site", async () => {
    const forced = await engine.fetch({ urls: [`${base}/spa`], maxTokens: 4000, render: "http", returnImages: false }, { signal: signal() });
    expect(forced.markdown).not.toContain("## Installation"); // scripts don't run on the HTTP path

    const r = await engine.fetch({ urls: [`${base}/spa`], maxTokens: 4000, render: "auto", returnImages: false }, { signal: signal() });
    expect((r.data.documents as any[])[0].tier).toBe("browser");
    expect(engine.hints.get("127.0.0.1")).toBe("browser");
    // Back to normal for the next test.
    engine.hints.set("127.0.0.1", "http");
  }, 60_000);

  it("refuses private-network URLs unless allowed", async () => {
    const strict = defaultConfig({});
    strict.browser.profileDir = mkdtempSync(join(tmpdir(), "tiny-browse-read-"));
    strict.cache.enabled = false;
    const guarded = new ChromeEngine(strict);
    try {
      const r = await guarded.fetch({ urls: [`${base}/article`], maxTokens: 4000, render: "auto", returnImages: false }, { signal: signal() });
      expect((r.data.documents as any[])[0]).toMatchObject({ ok: false });
      expect(r.markdown).toMatch(/local or private network address/);
      const viaBrowser = await guarded.fetch({ urls: [`${base}/article`], maxTokens: 4000, render: "browser", returnImages: false }, { signal: signal() });
      expect(viaBrowser.markdown).toMatch(/local or private network address/);
    } finally {
      await guarded.close();
    }
  }, 60_000);

  it("waits for client-rendered content", async () => {
    const r = await engine.fetch({ urls: [`${base}/spa`], maxTokens: 4000, render: "browser", returnImages: false }, { signal: signal() });
    expect(r.markdown).toMatch(/^# Client Rendered Guide/);
    expect(r.markdown).toContain("## Installation");
    expect(r.markdown).toContain("```bash\nnpm install client-rendered-guide\n```");
    expect(r.markdown).not.toContain("enable JavaScript");
  }, 60_000);

  it("uses the JSON-LD article body when the page itself is empty", async () => {
    const r = await engine.fetch({ urls: [`${base}/jsonld`], maxTokens: 4000, render: "auto", returnImages: false }, { signal: signal() });
    expect(r.markdown).toContain("twelve kilometres of protected bike lanes");
    expect(r.markdown).toContain("Construction is scheduled");
    expect(r.markdown).toContain("Sam Reporter · 2026-05-02");
  }, 60_000);

  it("handles Markdown negotiation, text, JSON, PDFs and HTTP errors", async () => {
    const r = await engine.fetch(
      { urls: [`${base}/md`, `${base}/notes.txt`, `${base}/data.json`, `${base}/paper.pdf`, `${base}/missing`], maxTokens: 8000, render: "auto", returnImages: false },
      { signal: signal() },
    );
    const docs = r.data.documents as any[];
    expect(docs[0].markdown).toContain("Hello agents.");
    expect(docs[1].markdown).toContain("line one\nline two");
    expect(docs[2].markdown).toContain('```json\n{"a":1}\n```');
    expect(docs[3]).toMatchObject({ ok: false });
    expect(docs[3].error).toMatch(/PDF.*0\.2/);
    expect(docs[4]).toMatchObject({ ok: false });
    expect(docs[4].error).toMatch(/HTTP 404/);
    expect(r.markdown).toContain("_Could not read this page: HTTP 404");
  }, 60_000);

  it("asks for Markdown first on page requests", () => {
    expect(accepts.some((a) => a.startsWith("text/markdown"))).toBe(true);
  });

  it("cuts long pages to max_tokens and continues them with a cursor", async () => {
    const first = await engine.fetch({ urls: [`${base}/article`], maxTokens: 300, render: "auto", returnImages: false }, { signal: signal() });
    const doc = (first.data.documents as any[])[0];
    expect(doc.truncated).toBe(true);
    expect(countTokens(first.markdown)).toBeLessThanOrEqual(300);
    expect(first.markdown).toMatch(/To continue, call web_fetch with cursor: "[\w-]+"/);

    const next = await engine.fetch({ urls: [], cursor: doc.cursor, maxTokens: 4000, render: "auto", returnImages: false }, { signal: signal() });
    const cont = (next.data.documents as any[])[0];
    expect(cont.cached).toBe(true); // continued from the page cache, no new fetch
    expect(next.markdown).toContain("…");
    expect(next.markdown).toContain("Checklist");
    expect(next.markdown).not.toContain("Backpressure** is what happens"); // already shown
  }, 60_000);

  it("returns image bytes for vision models when asked", async () => {
    const r = await engine.fetch({ urls: [`${base}/article`], maxTokens: 8000, render: "auto", returnImages: true }, { signal: signal() });
    expect(r.markdown).toContain(`![Producer and consumer with a bounded buffer](${base}/diagram.png)`);
    expect(r.images).toHaveLength(1); // the 1x1 tracking pixel is not a content image
    expect(r.images![0]).toMatchObject({ id: "img1", mimeType: "image/png" });
    expect((r.data.images as any[])[0]).toMatchObject({ src: `${base}/diagram.png`, alt: "Producer and consumer with a bounded buffer" });
  }, 60_000);

  it("returns the sections most relevant to a focus question", async () => {
    const r = await engine.fetch({ urls: [`${base}/article`], maxTokens: 350, render: "auto", returnImages: false, focus: "comparison of memory use between approaches" }, { signal: signal() });
    expect(r.markdown).toContain("| Approach | Memory | Complexity |");
    expect(r.markdown).toMatch(/Showing the sections most relevant to "comparison of memory use between approaches"/);
    expect(countTokens(r.markdown)).toBeLessThanOrEqual(350);
  }, 60_000);

  it("web_search reads the top results, one per site, within the budget", async () => {
    // Stand-in search engine: results point at the local pages.
    (engine.searcher as any).readPage = async (def: { name: string }) => ({
      provider: def.name,
      status: "ok",
      results: [
        { rank: 1, title: "Understanding Backpressure", url: `${base}/article`, snippet: "s", foundBy: ["visual"] },
        { rank: 2, title: "Same site again", url: `${base}/spa`, snippet: "s", foundBy: ["visual"] },
        { rank: 3, title: "Bike lanes", url: `http://localhost:${new URL(base).port}/jsonld`, snippet: "s", foundBy: ["visual"] },
      ],
      strategies: { visual: 3, accessibility: 3, selectors: 3 },
      ms: 5,
    });
    const r = await engine.search(
      { query: "backpressure streams", maxResults: 5, read: 2, maxTokens: 6000, freshness: "any", returnImages: false },
      { signal: signal() },
    );
    expect(r.markdown).toMatch(/^# Search: backpressure streams/);
    expect(r.markdown).toContain("## [1] Understanding Backpressure in Streams");
    expect(r.markdown).toContain("## [3] City Council Approves New Bike Lanes"); // rank 2 skipped: same site as rank 1
    expect(r.markdown).toContain("## Other results\n\n2. [Same site again]");
    expect(r.markdown).toContain("### A minimal example"); // page headings nest under the result heading
    const results = (r.data.results as any[]).map((x) => [x.rank, x.read]);
    expect(results).toEqual([[1, true], [2, false], [3, true]]);
  }, 60_000);
});
