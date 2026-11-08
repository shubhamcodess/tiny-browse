/**
 * End-to-end: spawn the built CLI (dist/cli.js) and talk MCP over stdio,
 * exactly like Claude Code or any other client does. Run `npm run build` first.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const built = existsSync(CLI);

describe.skipIf(!built)("built CLI", () => {
  it("serves MCP over stdio and lists the tools", async () => {
    // Temp cache dir: the eager Chrome start must not touch the real tiny-browse profile.
    const env = { ...process.env, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "tiny-browse-cache-")) };
    const child = spawn(process.execPath, [CLI, "--log-level", "silent"], { stdio: ["pipe", "pipe", "pipe"], env });
    const responses = new Map<number, any>();
    const lines = createInterface({ input: child.stdout });
    const waiters = new Map<number, (v: any) => void>();
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      responses.set(msg.id, msg);
      waiters.get(msg.id)?.(msg);
    });
    const call = (id: number, method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const init = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    expect(init.result.serverInfo.name).toBe("tiny-browse");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const list = await call(2, "tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["web_search", "web_fetch"]);

    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.end();
    expect(await exit).toBe(0);
  }, 30_000);

  it("prints help, version and client config", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    expect(run("--help").stdout).toMatch(/Usage:/);
    expect(run("--version").stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // From a source checkout the snippet points at this build, not at npx.
    expect(run("config", "claude-code").stdout).toContain(`claude mcp add tiny-browse -- ${process.execPath} ${CLI}`);
    const bad = run("frobnicate");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/unknown command/);
  });

  it("init creates the config and profile, then prints the agent snippet", () => {
    const root = mkdtempSync(join(tmpdir(), "tiny-browse-init-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(root, "cfg"), XDG_CACHE_HOME: join(root, "cache") };
    const first = spawnSync(process.execPath, [CLI, "init"], { encoding: "utf8", env });
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/config: created/);
    expect(first.stdout).toMatch(/claude mcp add tiny-browse/);
    const cfg = JSON.parse(readFileSync(join(root, "cfg", "tiny-browse", "config.json"), "utf8"));
    expect(cfg.search.providers).toEqual(["google", "duckduckgo", "bing"]);
    expect(existsSync(join(root, "cache", "tiny-browse", "chrome-profile"))).toBe(true);

    const second = spawnSync(process.execPath, [CLI, "init"], { encoding: "utf8", env });
    expect(second.stdout).toMatch(/already exists, left unchanged/);
  });
});
