/**
 * Minimal JSON-RPC 2.0 endpoint: just enough for an MCP server.
 * Transport-agnostic: feed it raw messages with `receive`, it calls `send`.
 */
import { log } from "../util/log.js";

export type JsonRpcId = string | number;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RequestContext {
  /** Aborted when the client cancels this request. */
  signal: AbortSignal;
}

export type MethodHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

type Message = Record<string, unknown>;

export class JsonRpcEndpoint {
  private readonly methods = new Map<string, MethodHandler>();
  private readonly notifications = new Map<string, NotificationHandler>();
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly send: (msg: unknown) => void) {}

  method(name: string, handler: MethodHandler): this {
    this.methods.set(name, handler);
    return this;
  }

  notification(name: string, handler: NotificationHandler): this {
    this.notifications.set(name, handler);
    return this;
  }

  /** Abort an in-flight request; its response is then suppressed. */
  cancel(id: unknown): void {
    if (typeof id !== "string" && typeof id !== "number") return;
    this.inflight.get(idKey(id))?.abort(new Error("cancelled by client"));
  }

  /** Number of requests currently being handled. */
  get pending(): number {
    return this.inflight.size;
  }

  async receive(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(errorResponse(null, ErrorCode.ParseError, "Parse error"));
      return;
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) {
        this.send(errorResponse(null, ErrorCode.InvalidRequest, "Empty batch"));
        return;
      }
      const out = (await Promise.all(msg.map((m) => this.dispatch(m)))).filter((r) => r !== undefined);
      if (out.length) this.send(out);
      return;
    }
    const out = await this.dispatch(msg);
    if (out !== undefined) this.send(out);
  }

  private async dispatch(msg: unknown): Promise<Message | undefined> {
    if (!isObject(msg) || msg.jsonrpc !== "2.0") {
      return errorResponse(validId(isObject(msg) ? msg.id : undefined), ErrorCode.InvalidRequest, "Invalid Request");
    }
    if (typeof msg.method !== "string") {
      // A response to a server-initiated request. We send none yet, so ignore.
      if ("result" in msg || "error" in msg) return undefined;
      return errorResponse(validId(msg.id), ErrorCode.InvalidRequest, "Invalid Request");
    }

    if (!("id" in msg)) {
      const handler = this.notifications.get(msg.method);
      if (!handler) {
        log.debug(`ignoring notification ${msg.method}`);
        return undefined;
      }
      try {
        handler(msg.params);
      } catch (err) {
        log.error(`notification ${msg.method} failed`, err);
      }
      return undefined;
    }

    const id = validId(msg.id);
    if (id === null) return errorResponse(null, ErrorCode.InvalidRequest, "Request id must be a string or number");

    const handler = this.methods.get(msg.method);
    if (!handler) return errorResponse(id, ErrorCode.MethodNotFound, `Method not found: ${msg.method}`);

    const key = idKey(id);
    const ac = new AbortController();
    this.inflight.set(key, ac);
    try {
      const result = await handler(msg.params, { signal: ac.signal });
      if (ac.signal.aborted) return undefined;
      return { jsonrpc: "2.0", id, result: result ?? {} };
    } catch (err) {
      if (ac.signal.aborted) return undefined;
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message, err.data);
      log.error(`method ${msg.method} failed`, err);
      return errorResponse(id, ErrorCode.InternalError, err instanceof Error ? err.message : "Internal error");
    } finally {
      this.inflight.delete(key);
    }
  }
}

function isObject(v: unknown): v is Message {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validId(id: unknown): JsonRpcId | null {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`;
}

function errorResponse(id: JsonRpcId | null, code: number, message: string, data?: unknown): Message {
  const error: Message = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
