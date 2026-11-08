import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { StubEngine, type EngineResult } from "../src/core/engine.js";
import { originAllowed, serveHttp, ServeError } from "../src/http/server.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");

class FakeEngine extends StubEngine {
  override async search(req: { query: string }): Promise<EngineResult> {
    return { markdown: `# Search: ${req.query}`, data: { query: req.query } };
  }
}

let server: Server;
let base: string;
let secured: Server;
let securedBase: string;

beforeAll(async () => {
  const config = defaultConfig({});
  server = await serveHttp(new FakeEngine(), config, { port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secured = await serveHttp(new FakeEngine(), config, { port: 0, host: "127.0.0.1", token: "s3cret" });
  securedBase = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
});
afterAll(() => {
  server?.close();
  secured?.close();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("HTTP server", () => {
  it("answers health checks", async () => {
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toMatchObject({ ok: true, name: "tiny-browse" });
  });

  it("speaks MCP over Streamable HTTP with optional sessions", async () => {
    const init = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    expect((await init.json()).result.protocolVersion).toBe("2025-06-18");

    const note = await post(`${base}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session! });
    expect(note.status).toBe(202);

    const list = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": session! });
    expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["web_search", "web_fetch"]);

    const call = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "hi" } } }, { "mcp-session-id": session! });
    const body = await call.json();
    expect(body.result.content[0].text).toBe("# Search: hi");
    expect(body.result.structuredContent).toEqual({ query: "hi" });

    const gone = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 4, method: "ping" }, { "mcp-session-id": "nope" });
    expect(gone.status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it("offers a plain JSON API with the same validation", async () => {
    const ok = await post(`${base}/search`, { query: "tiny" });
    expect(await ok.json()).toMatchObject({ markdown: "# Search: tiny", data: { query: "tiny" } });
    const bad = await post(`${base}/search`, { query: "" , extra: 1 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/must not be empty; arguments.extra is not a known parameter/);
    const notJson = await fetch(`${base}/fetch`, { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
  });

  it("rejects cross-site requests (DNS rebinding) and wrong tokens", async () => {
    const evil = await post(`${base}/search`, { query: "x" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(originAllowed("http://localhost:3000")).toBe(true);
    expect(originAllowed("null")).toBe(false);

    expect((await post(`${securedBase}/search`, { query: "x" })).status).toBe(401);
    expect((await post(`${securedBase}/search`, { query: "x" }, { authorization: "Bearer wrong!" })).status).toBe(401);
    expect((await post(`${securedBase}/search`, { query: "x" }, { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await fetch(`${securedBase}/health`)).status).toBe(200);
  });

  it("refuses to listen beyond this machine without a token", async () => {
    await expect(serveHttp(new FakeEngine(), defaultConfig({}), { port: 0, host: "0.0.0.0" })).rejects.toBeInstanceOf(ServeError);
  });
});
