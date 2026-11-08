/**
 * Run the full SERP reader (all three strategies + voting + health) in real
 * Chrome against saved and hand-written result pages. Skipped without Chrome.
 */
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "../src/browser/browser.js";
import { discoverBrowsers } from "../src/browser/discover.js";
import { defaultConfig } from "../src/config.js";
import { PROVIDERS, type ProviderDef } from "../src/search/providers.js";
import { readSerp, type ReadSerpResult } from "../src/search/serp.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");

const DIR = new URL("./fixtures/serp/", import.meta.url).pathname;
const hasBrowser = discoverBrowsers().length > 0;

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  const files = new Map(readdirSync(DIR).map((f) => [`/${f}`, readFileSync(join(DIR, f))]));
  server = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    if (!body) return void res.writeHead(404).end();
    // Hermetic: saved pages reference the engines' own CSS, fonts and images.
    // Loading those made results depend on the network and the runner's fonts.
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      })
      .end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  browser = new Browser({ ...defaultConfig({}).browser, profileDir: mkdtempSync(join(tmpdir(), "tiny-browse-serp-")) });
  // Start Chrome here, not in the first test: a cold start takes seconds on CI runners.
  if (hasBrowser) await browser.warm();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

function read(
  file: string,
  provider: ProviderDef,
  query?: string,
  resolve?: (hrefs: string[]) => Promise<Record<string, string>>,
): Promise<ReadSerpResult> {
  return browser.withPage(async (page) => {
    // Saved pages reference remote images/CSS; don't wait for those.
    await page.goto(`${base}/${file}`, { waitUntil: "domcontentloaded" });
    return readSerp(page, provider, { settleMs: 500, query, resolve });
  });
}

describe.skipIf(!hasBrowser)("SERP fixtures (real Chrome)", () => {
  it("reads a real Bing page: all three strategies agree on 10 results", async () => {
    const r = await read("bing-results.html", PROVIDERS.bing);
    expect(r.status).toBe("ok");
    expect(r.results).toHaveLength(10);
    expect(r.strategies.visual).toBe(10);
    expect(r.strategies.selectors).toBe(10);
    expect(r.results.every((x) => x.foundBy.length === 3)).toBe(true);
    expect(r.results[0]).toMatchObject({ title: "Rust Programming Language", url: "https://rust-lang.org/" });
    expect(r.results[0]!.snippet).toMatch(/blazingly fast/);
  }, 60_000);

  it("reads a real Google page whose result links are opaque /goto redirects", async () => {
    const r = await read("google-results.html", PROVIDERS.google, "typescript satisfies operator");
    expect(r.status).toBe("ok");
    const urls = r.results.map((x) => x.url);
    // Resolved from the page itself: breadcrumb + title matched to URLs the page contains.
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
        "https://www.freecodecamp.org/news/typescript-satisfies-operator/",
        "https://refine.dev/blog/typescript-satisfies-operator/",
        "https://mimo.org/glossary/typescript/satisfies",
      ]),
    );
    expect(urls.some((u) => u.includes("stackoverflow.com/questions/78636946/"))).toBe(true);
    // Never a bare homepage or a Google link standing in for a deep result.
    expect(urls.every((u) => !/google\./.test(new URL(u).hostname) && new URL(u).pathname !== "/")).toBe(true);
    expect(r.results.every((x) => x.foundBy.length === 3)).toBe(true);
  }, 60_000);

  it("follows the opaque links the page gives no destination for", async () => {
    const asked: string[] = [];
    const r = await read("google-results.html", PROVIDERS.google, "typescript satisfies operator", async (hrefs) => {
      asked.push(...hrefs);
      return Object.fromEntries(hrefs.map((h, i) => [h, `https://followed.example/${i}`]));
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((h) => h.startsWith("https://www.google.com/goto?"))).toBe(true);
    expect(r.results.filter((x) => x.url.startsWith("https://followed.example/")).length).toBe(asked.length);
    expect(r.results.length).toBe(9);
  }, 60_000);

  it("reads a Google-shaped page and skips ads, PAA, carousel, sitelinks, sidebar and footer", async () => {
    const r = await read("google-like.html", PROVIDERS.google, "model context protocol");
    expect(r.status).toBe("ok");
    expect(r.results.map((x) => x.url)).toEqual([
      "https://modelcontextprotocol.io/introduction",
      "https://en.wikipedia.org/wiki/Model_Context_Protocol",
      "https://github.com/modelcontextprotocol/modelcontextprotocol",
      "https://www.anthropic.com/news/model-context-protocol?utm_source=google",
      "https://blog.example.dev/what-is-mcp",
    ]);
    expect(r.results[1]!.snippet).toMatch(/open standard/);
    expect(r.results[0]!.snippet).not.toMatch(/›/);
  }, 60_000);

  it("survives a redesign with no headings and new markup (visual strategy alone)", async () => {
    const r = await read("google-redesign.html", PROVIDERS.google, "model context protocol");
    expect(r.strategies).toMatchObject({ accessibility: 0, selectors: 0 });
    expect(r.status).toBe("ok");
    expect(r.results.map((x) => x.title)).toEqual([
      "Introduction - Model Context Protocol",
      "Model Context Protocol - Wikipedia",
      "Specification and documentation for the Model Context Protocol",
      "Introducing the Model Context Protocol - Anthropic",
    ]);
    expect(r.results[1]!.url).toBe("https://en.wikipedia.org/wiki/Model_Context_Protocol");
    expect(r.results[0]!.snippet).toMatch(/standardizes how applications/);
  }, 60_000);

  it.each([
    ["google-sorry.html", PROVIDERS.google],
    ["duckduckgo-challenge.html", PROVIDERS.duckduckgo],
    ["brave-challenge.html", PROVIDERS.google],
  ])("detects the bot check in %s", async (file, provider) => {
    const r = await read(file, provider);
    expect(r.status).toBe("challenge");
    expect(r.results).toEqual([]);
  }, 60_000);
});
