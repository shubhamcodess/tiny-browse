import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { StubEngine, type Engine, type EngineResult } from "../src/core/engine.js";
import { createMcpServer } from "../src/mcp/server.js";
import { validate } from "../src/mcp/schema.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");

type Msg = Record<string, any>;

function setup(engine: Engine = new StubEngine()) {
  const sent: Msg[] = [];
  const server = createMcpServer({ engine, config: defaultConfig({}), send: (m) => sent.push(m as Msg) });
  let nextId = 1;
  const request = async (method: string, params?: unknown): Promise<Msg> => {
    const id = nextId++;
    await server.rpc.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const res = sent.find((m) => m.id === id);
    if (!res) throw new Error(`no response for ${method}`);
    return res;
  };
  const init = (protocolVersion = "2025-06-18") =>
    request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  return { server, sent, request, init };
}

/** Engine that records calls and returns a fixed result. */
class FakeEngine extends StubEngine {
  calls: { op: string; req: unknown }[] = [];
  override async search(req: unknown): Promise<EngineResult> {
    this.calls.push({ op: "search", req });
    return { markdown: "# results", data: { ok: true } };
  }
  override async fetch(req: unknown): Promise<EngineResult> {
    this.calls.push({ op: "fetch", req });
    return { markdown: "# page", data: { ok: true }, images: [{ id: "img1", mimeType: "image/png", data: "AAAA" }] };
  }
}

describe("MCP server", () => {
  it("negotiates the protocol version", async () => {
    const { init } = setup();
    expect((await init("2025-06-18")).result.protocolVersion).toBe("2025-06-18");
    const other = setup();
    expect((await other.init("1999-01-01")).result.protocolVersion).toBe("2025-11-25");
  });

  it("reports server info and tool capability", async () => {
    const { init } = setup();
    const { result } = await init();
    expect(result.serverInfo.name).toBe("tiny-browse");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.instructions).toMatch(/untrusted/);
  });

  it("lists exactly web_search and web_fetch", async () => {
    const { init, request } = setup();
    await init();
    const { result } = await request("tools/list");
    expect(result.tools.map((t: Msg) => t.name)).toEqual(["web_search", "web_fetch"]);
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.description.length).toBeGreaterThan(50);
    }
  });

  it("returns a tool error from the stub engine", async () => {
    const { init, request } = setup();
    await init();
    const { result } = await request("tools/call", { name: "web_search", arguments: { query: "hello" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not implemented yet/);
  });

  it("reports invalid arguments as a tool error the model can fix", async () => {
    const { init, request } = setup();
    await init();
    const { result } = await request("tools/call", { name: "web_fetch", arguments: { urls: ["not a url"], extra: 1 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/urls\[0\] must be an absolute http\(s\) URL/);
    expect(result.content[0].text).toMatch(/extra is not a known parameter/);
  });

  it("rejects unknown tools and methods with protocol errors", async () => {
    const { init, request } = setup();
    await init();
    expect((await request("tools/call", { name: "nope" })).error.code).toBe(-32602);
    expect((await request("resources/list")).error.code).toBe(-32601);
  });

  it("routes a URL given to web_search to fetch, and applies defaults", async () => {
    const engine = new FakeEngine();
    const { init, request } = setup(engine);
    await init();
    await request("tools/call", { name: "web_search", arguments: { query: "https://example.com/a" } });
    await request("tools/call", { name: "web_search", arguments: { query: "  tiny browsers  " } });
    expect(engine.calls[0]).toMatchObject({ op: "fetch", req: { urls: ["https://example.com/a"] } });
    expect(engine.calls[1]).toMatchObject({
      op: "search",
      req: { query: "tiny browsers", maxResults: 5, read: 3, maxTokens: 6000, freshness: "any", returnImages: false },
    });
  });

  it("returns text, images and structuredContent on newer protocols only", async () => {
    const newer = setup(new FakeEngine());
    await newer.init("2025-06-18");
    const a = await newer.request("tools/call", { name: "web_fetch", arguments: { urls: ["https://example.com"] } });
    expect(a.result.content).toEqual([
      { type: "text", text: "# page" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(a.result.structuredContent).toEqual({ ok: true });

    const older = setup(new FakeEngine());
    await older.init("2025-03-26");
    const b = await older.request("tools/call", { name: "web_fetch", arguments: { urls: ["https://example.com"] } });
    expect(b.result.structuredContent).toBeUndefined();
  });

  it("suppresses the response of a cancelled request", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    class SlowEngine extends StubEngine {
      override search(_req: unknown, ctx: { signal: AbortSignal }): Promise<EngineResult> {
        started();
        return new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
      }
    }
    const { server, sent, init } = setup(new SlowEngine());
    await init();
    const done = server.rpc.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } }),
    );
    await startedP;
    await server.rpc.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }));
    await done;
    expect(sent.find((m) => m.id === 99)).toBeUndefined();
    expect(server.rpc.pending).toBe(0);
  });

  it("answers malformed JSON with a parse error", async () => {
    const { server, sent } = setup();
    await server.rpc.receive("{ not json");
    expect(sent[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });
});

describe("schema validator", () => {
  const schema = {
    type: "object" as const,
    properties: { n: { type: "integer" as const, minimum: 1, maximum: 3 }, s: { type: "string" as const, enum: ["a", "b"] } },
    required: ["n"],
    additionalProperties: false,
  };
  it("accepts valid input", () => expect(validate(schema, { n: 2, s: "a" })).toEqual([]));
  it("lists every problem", () => {
    expect(validate(schema, { n: 2.5, s: "c", x: 1 })).toEqual([
      "arguments.n must be an integer",
      'arguments.s must be one of "a", "b"',
      "arguments.x is not a known parameter",
    ]);
    expect(validate(schema, {})).toEqual(["arguments.n is required"]);
    expect(validate(schema, { n: 9 })).toEqual(["arguments.n must be <= 3"]);
  });
});
