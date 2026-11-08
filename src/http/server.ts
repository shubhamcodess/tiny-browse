/**
 * `tiny-browse serve --http PORT`: MCP over Streamable HTTP (POST /mcp, JSON
 * responses, optional sessions) plus a plain JSON API for agents that don't
 * speak MCP (POST /search, POST /fetch, GET /health).
 *
 * Security defaults: listens on 127.0.0.1; rejects cross-site requests by
 * checking Origin (DNS-rebinding protection, as the MCP spec requires);
 * refuses to listen on a non-loopback address without a bearer token.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { NotImplementedError, ToolInputError, type Engine } from "../core/engine.js";
import { createMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../mcp/server.js";
import { validate } from "../mcp/schema.js";
import { toTinyBrowseError } from "../errors.js";
import { buildTools } from "../mcp/tools.js";
import { SearchUnavailableError } from "../search/search.js";
import { log } from "../util/log.js";
import { VERSION } from "../version.js";

export interface HttpServeOptions {
  port: number;
  host: string;
  /** Required on every request except /health when set. */
  token?: string;
}

const MAX_BODY = 1024 * 1024;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
const SESSION_TTL_MS = 60 * 60_000;

export class ServeError extends Error {
  override name = "ServeError";
}

export async function serveHttp(engine: Engine, config: Config, opts: HttpServeOptions): Promise<Server> {
  if (!LOOPBACK.test(opts.host) && !opts.token) {
    throw new ServeError(
      `refusing to listen on ${opts.host} without a token: anyone on the network could browse through this computer. ` +
        "Pass --token (or TINY_BROWSE_TOKEN), or keep the default host 127.0.0.1.",
    );
  }
  const tools = buildTools(engine, config);
  const sessions = new Map<string, { version: string; at: number }>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log.error("http request failed", err);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: "cross-origin requests are not allowed" });
    if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { ok: true, name: "tiny-browse", version: VERSION });
    if (opts.token && !tokenOk(req.headers.authorization, opts.token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return json(res, 401, { error: "missing or wrong bearer token" });
    }

    // Abort the work if the client goes away.
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort(new Error("client disconnected"));
    });

    if (url.pathname === "/mcp") return mcp(req, res);
    if ((url.pathname === "/search" || url.pathname === "/fetch") && req.method === "POST") {
      const tool = tools.find((t) => t.name === (url.pathname === "/search" ? "web_search" : "web_fetch"))!;
      const args = await readJson(req);
      if (!args.ok) return json(res, 400, { error: args.error });
      const problems = validate(tool.inputSchema, args.value);
      if (problems.length) return json(res, 400, { error: problems.join("; ") });
      try {
        const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(config.callTimeoutMs)]);
        const r = await tool.run(args.value as Record<string, unknown>, { signal });
        return json(res, 200, { markdown: r.markdown, data: r.data, images: r.images ?? [] });
      } catch (err) {
        const expected = err instanceof ToolInputError || err instanceof SearchUnavailableError || err instanceof NotImplementedError;
        // `code` lets library clients (useServer: "auto") rethrow the same TinyBrowseError.
        const e = toTinyBrowseError(err, { aborted: ac.signal.aborted });
        return json(res, expected ? 422 : 500, { error: e.message, code: e.code });
      }
    }
    return json(res, 404, { error: "not found: use POST /mcp, POST /search, POST /fetch or GET /health" });
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "DELETE") {
      const id = header(req, "mcp-session-id");
      if (id) sessions.delete(id);
      return json(res, 200, {});
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      return json(res, 405, { error: "this server sends JSON responses only (no SSE stream); use POST" });
    }
    const body = await readJson(req);
    if (!body.ok) return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: body.error } });

    // Sessions are optional: they only remember the negotiated protocol version.
    const sessionId = header(req, "mcp-session-id");
    pruneSessions();
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) return json(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown or expired session" } });

    let reply: unknown;
    const server = createMcpServer({
      engine,
      config,
      send: (m) => {
        reply = m;
      },
      protocolVersion: session?.version ?? header(req, "mcp-protocol-version") ?? SUPPORTED_PROTOCOL_VERSIONS[0],
    });
    await server.rpc.receive(JSON.stringify(body.value));

    const isInit = (body.value as { method?: string }).method === "initialize";
    if (isInit && server.protocolVersion) {
      const id = randomUUID();
      sessions.set(id, { version: server.protocolVersion, at: Date.now() });
      res.setHeader("Mcp-Session-Id", id);
    } else if (session) session.at = Date.now();

    if (reply === undefined) {
      res.writeHead(202).end(); // notifications and responses: accepted, nothing to say
      return;
    }
    return json(res, 200, reply);
  }

  function pruneSessions(): void {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(id);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** Same-machine pages only: no Origin (non-browser clients) or a loopback origin. */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin || origin === "null") return !origin; // "null" origins (sandboxed iframes, file:) are refused
  try {
    return LOOPBACK.test(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

function tokenOk(auth: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(auth ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return { ok: false, error: "request body too large (1 MB max)" };
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}
