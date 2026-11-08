/**
 * Attacks against the reading path, in real Chrome:
 * 1. A "public" page tries to reach the local network from inside the browser.
 * 2. A page read must never carry the profile's cookies (e.g. a Google sign-in).
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverBrowsers } from "../src/browser/discover.js";
import { defaultConfig } from "../src/config.js";
import { ChromeEngine } from "../src/core/chrome-engine.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");
const hasBrowser = discoverBrowsers().length > 0;

const FILLER = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} of a perfectly ordinary article about gardening, soil and seasons, long enough to read as real prose.</p>`).join("");

let victim: Server;
let site: Server;
let victimPort = 0;
let sitePort = 0;
const hits: string[] = [];
let engine: ChromeEngine;

beforeAll(async () => {
  // Stands in for your router or a local dev server: it must never be reached.
  victim = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("victim");
  });
  victim.on("upgrade", (req, socket) => {
    hits.push(`ws ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((r) => victim.listen(0, "127.0.0.1", r));
  victimPort = (victim.address() as AddressInfo).port;

  // The "public" site the agent reads (allowed explicitly via fetch.allowHosts).
  site = createServer((req, res) => {
    const v = `127.0.0.1:${victimPort}`;
    if (req.url === "/attack") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Gardening</title>
        <link rel="stylesheet" href="http://${v}/style.css">
        <img src="http://${v}/img.png" width="300" height="200" alt="x">
        <iframe src="http://localhost:${victimPort}/frame"></iframe>
        <script>
          fetch("http://${v}/fetch").catch(() => {});
          navigator.sendBeacon("http://${v}/beacon", "x");
          try { new WebSocket("ws://${v}/ws"); } catch (e) {}
          addEventListener("DOMContentLoaded", () =>
            document.querySelector("main").insertAdjacentHTML("beforeend", "<p>Page check: WebSocket is " + typeof WebSocket + " in this reading tab, as expected.</p>"));
        </script>
        <main><h1>Gardening</h1>${FILLER}</main>`);
      return;
    }
    if (req.url === "/setcookie") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "session=SECRET-SIGNED-IN; Path=/; SameSite=Lax" }).end("<p>set</p>");
      return;
    }
    if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Echo</title><main><h1>Echo</h1><p>cookies: ${req.headers.cookie ?? "none"}</p>${FILLER}</main>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  sitePort = (site.address() as AddressInfo).port;

  const config = defaultConfig({});
  config.browser.profileDir = mkdtempSync(join(tmpdir(), "tiny-browse-sec-"));
  config.cache.enabled = false;
  config.fetch.allowPrivateNetwork = false;
  config.fetch.allowHosts = [`127.0.0.1:${sitePort}`];
  engine = new ChromeEngine(config);
});

afterAll(async () => {
  await engine?.close();
  victim?.close();
  site?.close();
});

const signal = () => AbortSignal.timeout(30_000);

describe.skipIf(!hasBrowser)("reading-path security (real Chrome)", () => {
  it.each(["browser", "http", "auto"] as const)("a page cannot reach the local network from inside Chrome (render: %s)", async (render) => {
    hits.length = 0;
    const r = await engine.fetch({ urls: [`http://127.0.0.1:${sitePort}/attack`], maxTokens: 4000, render, returnImages: false }, { signal: signal() });
    await new Promise((res) => setTimeout(res, 800)); // let any late beacon arrive
    expect((r.data.documents as any[])[0].ok).toBe(true);
    expect(r.markdown).toContain("perfectly ordinary article about gardening");
    expect(hits).toEqual([]);
    if (render === "browser") expect(r.markdown).toContain("WebSocket is undefined in this reading tab");
  }, 60_000);

  it("pages are read without the profile's cookies", async () => {
    // A sign-in stored in the tiny-browse profile...
    await engine.browser.withPage(async (p) => {
      await p.goto(`http://127.0.0.1:${sitePort}/setcookie`);
    }, { kind: "profile" });
    const inProfile = await engine.browser.withPage(async (p) => {
      await p.goto(`http://127.0.0.1:${sitePort}/echo`);
      return p.evaluate<string>("document.body.innerText");
    }, { kind: "profile" });
    expect(inProfile).toContain("SECRET-SIGNED-IN");

    // ...is never sent when an agent reads a page, on either path.
    for (const render of ["browser", "http"] as const) {
      const r = await engine.fetch({ urls: [`http://127.0.0.1:${sitePort}/echo`], maxTokens: 4000, render, returnImages: false }, { signal: signal() });
      expect(r.markdown).toContain("cookies: none");
      expect(r.markdown).not.toContain("SECRET");
    }
  }, 60_000);
});
