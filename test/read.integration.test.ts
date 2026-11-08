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
    if (url.match(/\/(diagram\.png|pixel\.gif)$/)) return res.writeHead(404).end();
    res.writeHead(404, { "content-type": "text/html" }).end("<title>Not Found</title><h1>Not Found</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const config: Config = defaultConfig({});
  config.browser.profileDir = mkdtempSync(join(tmpdir(), "tiny-browse-read-"));
  config.cache.enabled = false;
  config.search.minGapMs = 0;
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

  it("waits for client-rendered content", async () => {
    const r = await engine.fetch({ urls: [`${base}/spa`], maxTokens: 4000, render: "auto", returnImages: false }, { signal: signal() });
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

  it("cuts long pages to the budget and says so", async () => {
    const r = await engine.fetch({ urls: [`${base}/article`], maxTokens: 400, render: "auto", returnImages: false }, { signal: signal() });
    const doc = (r.data.documents as any[])[0];
    expect(doc.truncated).toBe(true);
    expect(doc.tokens).toBeLessThanOrEqual(420);
    expect(r.markdown).toMatch(/Cut to fit the token budget: about \d+ more tokens/);
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
