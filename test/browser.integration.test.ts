/**
 * Real-Chrome tests. Skipped when no Chromium-family browser is installed.
 * Each test uses a throwaway profile and a local HTTP server (no internet).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "../src/browser/browser.js";
import { findRunningOnProfile } from "../src/browser/chrome.js";
import { discoverBrowsers } from "../src/browser/discover.js";
import { defaultConfig, type Config } from "../src/config.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");

const hasBrowser = discoverBrowsers().length > 0;

function browserConfig(over: Partial<Config["browser"]> = {}): Config["browser"] {
  return {
    ...defaultConfig({}).browser,
    profileDir: mkdtempSync(join(tmpdir(), "tiny-browse-profile-")),
    ...over,
  };
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/hello" }).end();
    } else if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/html" }).end("<title>Hello</title><h1>Hi</h1>");
    } else if (req.url === "/spa") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<title>SPA</title><div id=root></div><script>setTimeout(()=>{root.textContent="rendered"},50)</script>`);
    } else {
      res.writeHead(404, { "content-type": "text/html" }).end("<title>Nope</title>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

describe.skipIf(!hasBrowser)("Browser (real Chrome)", () => {
  it("follows redirects and reports the final status and URL", async () => {
    const browser = new Browser(browserConfig());
    try {
      const res = await browser.withPage(async (page) => {
        const nav = await page.goto(`${base}/redirect`);
        return { ...nav, title: await page.title() };
      });
      expect(res).toMatchObject({ url: `${base}/hello`, status: 200, title: "Hello", timedOut: false });

      const missing = await browser.withPage((page) => page.goto(`${base}/missing`));
      expect(missing.status).toBe(404);

      const spa = await browser.withPage(async (page) => {
        await page.goto(`${base}/spa`, { waitUntil: "load" });
        return page.evaluate<string>("new Promise(r => setTimeout(() => r(root.textContent), 150))");
      });
      expect(spa).toBe("rendered");
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("reports DNS failures as navigation errors", async () => {
    const browser = new Browser(browserConfig());
    try {
      await expect(browser.withPage((page) => page.goto("http://does-not-exist.invalid/"))).rejects.toThrow(
        /ERR_NAME_NOT_RESOLVED/,
      );
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("shares one Chrome between two tiny-browse instances on the same profile", async () => {
    const cfg = browserConfig();
    const a = new Browser(cfg);
    const b = new Browser(cfg);
    try {
      const sa = await a.ensure();
      const sb = await b.ensure();
      expect(sa.kind).toBe("launched");
      expect(sb.kind).toBe("shared");
      const title = await b.withPage(async (p) => {
        await p.goto(`${base}/hello`);
        return p.title();
      });
      expect(title).toBe("Hello");
    } finally {
      await b.close();
      await a.close();
    }
    expect(await findRunningOnProfile(cfg.profileDir)).toBeUndefined();
  }, 30_000);

  it("restarts Chrome after it was killed", async () => {
    const browser = new Browser(browserConfig());
    try {
      const first = await browser.ensure();
      first.child!.kill("SIGKILL");
      await new Promise<void>((r) => first.conn.onClosed(r));
      const title = await browser.withPage(async (p) => {
        await p.goto(`${base}/hello`);
        return p.title();
      });
      expect(title).toBe("Hello");
      const second = await browser.ensure();
      expect(second.child!.pid).not.toBe(first.child!.pid);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("shuts Chrome down when idle and starts it again on demand", async () => {
    const cfg = browserConfig({ idleTimeoutMs: 1500 });
    const browser = new Browser(cfg);
    try {
      const s = await browser.warm();
      const exited = new Promise<void>((r) => s.child!.once("exit", () => r()));
      await exited; // idle timer closes it after ~1.5-2.5 s
      expect(await findRunningOnProfile(cfg.profileDir)).toBeUndefined();
      const again = await browser.ensure();
      expect(again.child!.pid).not.toBe(s.child!.pid);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
