/**
 * Release check: pack the package, install the tarball into a fresh project
 * (offline: there are no runtime dependencies), then import it by name and
 * run one webSearch against a stand-in tiny-browse server. Catches broken
 * "exports", missing files and missing type declarations before publishing.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url).pathname;
const built = existsSync(join(root, "dist/index.js"));

let project = "";
let fake: Server;
let fakeUrl = "";

beforeAll(async () => {
  if (!built) return;
  const packDir = mkdtempSync(join(tmpdir(), "tiny-browse-pack-"));
  execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: root, stdio: "pipe" });
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".tgz"))!);
  project = mkdtempSync(join(tmpdir(), "tiny-browse-consumer-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", tarball, "--offline", "--no-audit", "--no-fund", "--silent"], { cwd: project, stdio: "pipe" });

  fake = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        markdown: "# Search: packed\n",
        data: {
          query: "packed",
          provider: "google",
          status: "ok",
          cached: false,
          attempts: [{ provider: "google", status: "ok", ms: 1 }],
          results: [{ rank: 1, title: "Packed", url: "https://packed.example/", snippet: "it works", foundBy: ["visual"], read: false }],
        },
        images: [],
      }),
    );
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}, 120_000);

afterAll(() => fake?.close());

describe.skipIf(!built)("packed package", () => {
  it("ships the CLI, the library and its types, with no dependencies", () => {
    const pkg = join(project, "node_modules/@shubhamcodess/tiny-browse");
    expect(readdirSync(join(pkg, "dist")).sort()).toEqual(["cli.js", "index.d.ts", "index.js"]);
    expect(existsSync(join(project, "node_modules/.bin/tiny-browse"))).toBe(true);
    expect(readdirSync(join(project, "node_modules")).filter((d) => !d.startsWith("."))).toEqual(["@shubhamcodess"]);
  });

  it("can be imported by name and run a (mocked) webSearch", async () => {
    const cache = mkdtempSync(join(tmpdir(), "tiny-browse-pack-cache-"));
    const script = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const lib = await import("@shubhamcodess/tiny-browse");
      // Stand-in for a running \`tiny-browse serve\`, announced the way the real one is.
      writeFileSync(join(${JSON.stringify(cache)}, "server.json"), JSON.stringify({ url: ${JSON.stringify(fakeUrl)}, pid: process.pid, version: "x" }));
      const r = await lib.webSearch({ query: "packed" }, { cacheDir: ${JSON.stringify(cache)}, useServer: "auto", config: {} });
      const pkg = (await import("@shubhamcodess/tiny-browse/package.json", { with: { type: "json" } })).default;
      console.log(JSON.stringify({ provider: r.provider, first: r.results[0], version: lib.VERSION === pkg.version, error: typeof lib.TinyBrowseError }));
    `;
    writeFileSync(join(project, "run.mjs"), script);
    // Async: the stand-in server lives in this process and must keep answering.
    const r = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["run.mjs"], { cwd: project });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", () => resolve({ stdout, stderr }));
    });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      provider: "google",
      first: { rank: 1, title: "Packed", url: "https://packed.example/", snippet: "it works" },
      version: true,
      error: "function",
    });
  }, 30_000);

  it("type-checks a consumer against the shipped declarations", () => {
    writeFileSync(
      join(project, "use.ts"),
      `import { createClient, webSearch, TinyBrowseError, type SearchResult, type WebSearchInput } from "@shubhamcodess/tiny-browse";
       const input: WebSearchInput = { query: "x", max_results: 3, read: 1 };
       export async function go(): Promise<string[]> {
         try {
           const r: SearchResult = await webSearch(input, { mode: "http", timeoutMs: 5000 });
           const c = await createClient();
           await c.close();
           return r.results.map((x) => x.url);
         } catch (e) {
           if (e instanceof TinyBrowseError && e.code === "blocked") return [];
           throw e;
         }
       }`,
    );
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023", strict: true, noEmit: true, skipLibCheck: false, types: [] }, files: ["use.ts"] }),
    );
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", "."], { cwd: project, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 30_000);
});
