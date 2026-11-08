/**
 * Lifecycle of the built library (dist/index.js) in a separate Node process,
 * the way a short-lived CLI uses it: no output, no files on import, the
 * process exits as soon as a one-shot call returns, and no Chrome is left
 * behind, even when the process is killed mid-call. Run `npm run build` first.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverBrowsers } from "../src/browser/discover.js";

const LIB = new URL("../dist/index.js", import.meta.url).pathname;
const built = existsSync(LIB);
const hasBrowser = discoverBrowsers().length > 0;
const article = readFileSync(new URL("./fixtures/pages/article.html", import.meta.url));

let site: Server;
let host = "";
beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(article), 20_000);
    res.writeHead(200, { "content-type": "text/html" }).end(article);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => site?.close());

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run an ES module script that imports the built library as `lib`. */
function runScript(body: string, opts: { cacheDir: string; killAfter?: (out: string) => boolean } = { cacheDir: "" }): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "tiny-browse-script-"));
  const file = join(dir, "run.mjs");
  writeFileSync(file, `import * as lib from ${JSON.stringify(LIB)};\n${body}\n`);
  const start = performance.now();
  const env = { ...process.env, XDG_CACHE_HOME: opts.cacheDir, XDG_CONFIG_HOME: opts.cacheDir };
  const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    if (opts.killAfter?.(stdout)) child.kill("SIGTERM");
  });
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr, ms: performance.now() - start })));
}

function chromeOn(dir: string): number {
  try {
    return execFileSync("pgrep", ["-f", dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "tiny-browse-life-"));

describe.skipIf(!built)("library lifecycle (built package, separate process)", () => {
  it("importing writes nothing, prints nothing, starts nothing", async () => {
    const cache = tmp();
    const r = await runScript(`process.stdout.write(Object.keys(lib).sort().join(","));`, { cacheDir: cache });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("TinyBrowseError,VERSION,createClient,doctor,webFetch,webSearch");
    expect(r.stderr).toBe("");
    expect(readdirSync(cache)).toEqual([]);
  });

  it("a one-shot call without Chrome returns and the process exits right away", async () => {
    const cache = tmp();
    const r = await runScript(
      `const t = performance.now();
       const res = await lib.webFetch({ urls: ["http://${host}/a"] }, { mode: "http", config: { fetch: { allowHosts: ["${host}"] } } });
       process.stdout.write(JSON.stringify({ title: res.pages[0].title, callMs: Math.round(performance.now() - t) }));`,
      { cacheDir: cache },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.title).toBe("Understanding Backpressure in Streams");
    // Exit follows the call immediately: whole run (Node start + import + call) stays small.
    expect(r.ms - out.callMs).toBeLessThan(1500);
  }, 30_000);

  it.skipIf(!hasBrowser)("a one-shot call with Chrome leaves no Chrome running", async () => {
    const cache = tmp();
    const r = await runScript(
      `const res = await lib.webFetch({ urls: ["http://${host}/a"], render: "browser" }, { config: { fetch: { allowHosts: ["${host}"] } } });
       process.stdout.write(res.pages[0].title);`,
      { cacheDir: cache },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Understanding Backpressure in Streams");
    expect(r.stderr).toBe("");
    await new Promise((res) => setTimeout(res, 300));
    expect(chromeOn(cache)).toBe(0);
  }, 60_000);

  it.skipIf(!hasBrowser)("killing the caller mid-call takes Chrome down with it", async () => {
    const cache = tmp();
    const r = await runScript(
      `const client = await lib.createClient({ config: { fetch: { allowHosts: ["${host}"] } } });
       await client.webFetch({ urls: ["http://${host}/a"], render: "browser" });
       process.stdout.write("warm\\n");
       await client.webFetch({ urls: ["http://${host}/slow"], render: "browser" });`,
      { cacheDir: cache, killAfter: (out) => out.includes("warm") },
    );
    expect(r.signal).toBe("SIGTERM");
    await new Promise((res) => setTimeout(res, 500));
    expect(chromeOn(cache)).toBe(0);
  }, 60_000);

  it("never writes to the terminal, even with a logger at debug level", async () => {
    const r = await runScript(
      `const lines = [];
       await lib.webFetch({ urls: ["http://${host}/a"] }, { mode: "http", logLevel: "debug", logger: { debug: (m) => lines.push(m), info: (m) => lines.push(m) }, config: { fetch: { allowHosts: ["${host}"] } } });
       process.stdout.write(String(lines.length >= 0));`,
      { cacheDir: tmp() },
    );
    expect(r.stdout).toBe("true");
    expect(r.stderr).toBe("");
  }, 30_000);
});
