/**
 * The public library API (src/index.ts): structured results, error codes,
 * client lifecycle, useServer and the shared input schemas. Runs without
 * Chrome (mode "http") against a local server, plus a stand-in tiny-browse
 * server for search.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { fetchInputSchema, searchInputSchema, type WebFetchInput, type WebSearchInput } from "../src/core/inputs.js";
import { codeForMessage } from "../src/errors.js";
import { createClient, doctor, TinyBrowseError, webFetch, webSearch, type ClientOptions } from "../src/index.js";
import { findServer, writeServerFile } from "../src/server-file.js";
import { log, withLogger, type Logger } from "../src/util/log.js";

const article = readFileSync(new URL("./fixtures/pages/article.html", import.meta.url));

let site: Server;
let base = "";
let opts: ClientOptions;

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/article") return res.writeHead(200, { "content-type": "text/html" }).end(article);
    if (req.url === "/slow") return void setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(article), 3000);
    res.writeHead(404, { "content-type": "text/html" }).end("<title>Not found</title>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(site.address() as AddressInfo).port}`;
  base = `http://${host}`;
  opts = {
    mode: "http",
    cacheDir: mkdtempSync(join(tmpdir(), "tiny-browse-lib-")),
    config: { fetch: { allowHosts: [host] }, cache: { enabled: false } },
  };
});
afterAll(() => site?.close());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    expect(err).toBeInstanceOf(TinyBrowseError);
    return (err as TinyBrowseError).code;
  }
}

describe("webFetch", () => {
  it("returns structured pages plus Markdown", async () => {
    const r = await webFetch({ urls: [`${base}/article`] }, opts);
    expect(r.failed).toEqual([]);
    expect(r.pages).toHaveLength(1);
    const p = r.pages[0]!;
    expect(p).toMatchObject({ url: `${base}/article`, finalUrl: `${base}/article`, title: "Understanding Backpressure in Streams", truncated: false });
    expect(p.tokens).toBeGreaterThan(100);
    expect(p.markdown).toContain("| Approach | Memory | Complexity |");
    expect(r.markdown).toContain("<!-- begin untrusted content from 127.0.0.1 -->");
  });

  it("reports partial failures per page and throws when nothing could be read", async () => {
    const r = await webFetch({ urls: [`${base}/article`, `${base}/missing`] }, opts);
    expect(r.pages).toHaveLength(1);
    expect(r.failed).toEqual([{ url: `${base}/missing`, code: "network", message: "HTTP 404" }]);
    expect(await code(webFetch({ urls: [`${base}/missing`] }, opts))).toBe("network");
  });

  it("uses error codes: private_address, invalid_input, timeout, aborted", async () => {
    const strict: ClientOptions = { ...opts, config: { cache: { enabled: false } } };
    expect(await code(webFetch({ urls: [`${base}/article`] }, strict))).toBe("private_address");
    expect(await code(webFetch({ urls: ["not a url"] }, opts))).toBe("invalid_input");
    expect(await code(webFetch({}, opts))).toBe("invalid_input");
    expect(await code(webFetch({ urls: [`${base}/slow`] }, { ...opts, timeoutMs: 300 }))).toBe("timeout");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect(await code(webFetch({ urls: [`${base}/slow`] }, { ...opts, signal: ac.signal }))).toBe("aborted");
    expect(await code(webFetch({ urls: [`${base}/article`] }, { config: { browser: { mode: "nope" as never } } }))).toBe("invalid_input");
  });

  it("continues a cut page with its cursor", async () => {
    const first = await webFetch({ urls: [`${base}/article`], max_tokens: 300 }, opts);
    const cursor = first.pages[0]!.cursor!;
    expect(first.pages[0]!.truncated).toBe(true);
    const next = await webFetch({ cursor }, opts);
    expect(next.pages[0]!.markdown).toContain("Checklist");
  });
});

describe("createClient", () => {
  it("reuses one client, closes idempotently, refuses calls after close", async () => {
    const client = await createClient(opts);
    await client.webFetch({ urls: [`${base}/article`] });
    await client.webFetch({ urls: [`${base}/article`], focus: "comparison of approaches" });
    await client.close();
    await client.close();
    expect(await code(client.webFetch({ urls: [`${base}/article`] }))).toBe("invalid_input");
  });

  it("creating a client starts nothing and touches no files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-browse-lazy-"));
    const client = await createClient({ cacheDir: dir, config: {} });
    expect(readdir(dir)).toEqual([]);
    await client.close();
    expect(readdir(dir)).toEqual([]);
  });
});

describe("webSearch through a running tiny-browse server (useServer: auto)", () => {
  let fake: Server;
  let dir = "";
  let reply: (body: any) => { status: number; json: unknown } = () => ({ status: 500, json: {} });
  const calls: { path: string; auth?: string; body: unknown }[] = [];

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || "{}");
      calls.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const r = reply(body);
      res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    dir = mkdtempSync(join(tmpdir(), "tiny-browse-srv-"));
    writeServerFile(dir, { url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, pid: process.pid, version: "test", token: "t0k" });
  });
  afterAll(() => fake?.close());

  const engineResult = (status = "ok") => ({
    markdown: "# Search: tiny\n",
    data: {
      query: "tiny",
      provider: "google",
      status,
      cached: false,
      attempts: [{ provider: "google", status, ms: 10 }],
      results:
        status === "no_results"
          ? []
          : [
              { rank: 1, title: "One", url: "https://one.example/", snippet: "s1", foundBy: ["visual"], read: true, doc: { url: "https://one.example/", finalUrl: "https://one.example/", title: "One", ok: true, markdown: "## One\n", tokens: 3, truncated: false } },
              { rank: 2, title: "Two", url: "https://two.example/", snippet: "s2", foundBy: ["visual"], read: true, doc: { url: "https://two.example/", finalUrl: "https://two.example/", title: "Two", ok: false, error: "the site blocked automated access with a bot check (HTTP 403)", markdown: "", tokens: 0, truncated: false } },
              { rank: 3, title: "Three", url: "https://three.example/", snippet: "s3", foundBy: ["visual"], read: false },
            ],
    },
    images: [],
  });

  it("returns structured results, pages and failures", async () => {
    reply = () => ({ status: 200, json: engineResult() });
    const r = await webSearch({ query: "tiny", read: 2 }, { cacheDir: dir, useServer: "auto", config: {} });
    expect(calls.at(-1)).toMatchObject({ path: "/search", auth: "Bearer t0k", body: { query: "tiny", read: 2 } });
    expect(r.provider).toBe("google");
    expect(r.results.map((x) => x.url)).toEqual(["https://one.example/", "https://two.example/", "https://three.example/"]);
    expect(r.results[0]).toEqual({ rank: 1, title: "One", url: "https://one.example/", snippet: "s1" });
    expect(r.pages.map((p) => p.title)).toEqual(["One"]);
    expect(r.failed).toEqual([{ url: "https://two.example/", code: "blocked", message: "the site blocked automated access with a bot check (HTTP 403)" }]);
    expect(r.markdown).toBe("# Search: tiny\n");
  });

  it("no results is an empty list, not an error", async () => {
    reply = () => ({ status: 200, json: engineResult("no_results") });
    const r = await webSearch({ query: "zzqq" }, { cacheDir: dir, useServer: "auto", config: {} });
    expect(r.results).toEqual([]);
  });

  it("passes the server's error code through", async () => {
    reply = () => ({ status: 422, json: { error: "No search engine returned results.", code: "blocked" } });
    expect(await code(webSearch({ query: "x" }, { cacheDir: dir, useServer: "auto", config: {} }))).toBe("blocked");
  });

  it("ignores a port file whose process is gone", () => {
    const d = mkdtempSync(join(tmpdir(), "tiny-browse-srv-"));
    writeServerFile(d, { url: "http://127.0.0.1:1", pid: 2 ** 22 + 12345, version: "x" });
    expect(findServer(d)).toBeUndefined();
  });
});

describe("shared pieces", () => {
  it("the exported input types and the MCP schemas list the same parameters", () => {
    const search: Record<keyof WebSearchInput, true> = { query: true, max_results: true, read: true, max_tokens: true, site: true, freshness: true, return_images: true };
    const fetchKeys: Record<keyof WebFetchInput, true> = { urls: true, max_tokens: true, focus: true, cursor: true, render: true, return_images: true };
    expect(Object.keys(searchInputSchema(defaultConfig({})).properties!).sort()).toEqual(Object.keys(search).sort());
    expect(Object.keys(fetchInputSchema().properties!).sort()).toEqual(Object.keys(fetchKeys).sort());
  });

  it("classifies page failure messages", () => {
    expect(codeForMessage("localhost is a local or private network address; tiny-browse does not read those")).toBe("private_address");
    expect(codeForMessage("bot check (HTTP 403)")).toBe("blocked");
    expect(codeForMessage("timed out after 8000 ms")).toBe("timeout");
    expect(codeForMessage("No Chrome, Chromium, Edge or Brave installation found.")).toBe("chrome_not_found");
    expect(codeForMessage("ECONNREFUSED")).toBe("network");
  });

  it("keeps each client's logs to itself", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const la: Logger = { info: (m) => a.push(m) };
    const lb: Logger = { info: (m) => b.push(m) };
    await Promise.all([
      withLogger(la, "info", async () => {
        await new Promise((r) => setTimeout(r, 5));
        log.info("from a");
      }),
      withLogger(lb, "info", async () => log.info("from b")),
    ]);
    log.info("from nobody"); // no logger outside a client: silent
    expect(a).toEqual(["from a"]);
    expect(b).toEqual(["from b"]);
  });

  it("doctor reports checks as ok/detail", async () => {
    const checks = await doctor({ mode: "http", config: { cache: { enabled: false } } });
    expect(checks[0]).toMatchObject({ name: "node >= 22", ok: true });
    expect(checks.every((c) => typeof c.ok === "boolean" && typeof c.detail === "string")).toBe(true);
  });
});

function readdir(d: string): string[] {
  return readdirSync(d);
}
