/**
 * Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
 * Uses flat sessions: page-level commands carry a `sessionId`.
 */

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
  }
}

export class CdpClosedError extends Error {
  override name = "CdpClosedError";
  constructor() {
    super("connection to the browser was closed");
  }
}

type Params = Record<string, any>;
type Listener = (params: Params) => void;

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SendOptions {
  sessionId?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closeHandlers = new Set<() => void>();
  private isClosed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => this.onClose());
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${wsUrl}`));
      });
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send<T = Params>(method: string, params: Params = {}, opts: SendOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new CdpClosedError());
    const id = this.nextId++;
    const msg: Params = { id, method, params };
    if (opts.sessionId) msg.sessionId = opts.sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, `no reply within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Subscribe to an event (optionally for one session). Returns an unsubscribe function. */
  on(method: string, listener: Listener, sessionId?: string): () => void {
    const key = eventKey(method, sessionId);
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Resolve with the first matching event, or reject on timeout/abort/close. */
  waitFor(
    method: string,
    opts: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal; filter?: (p: Params) => boolean } = {},
  ): Promise<Params> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        off();
        offClose();
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const off = this.on(
        method,
        (p) => {
          if (opts.filter && !opts.filter(p)) return;
          cleanup();
          resolve(p);
        },
        opts.sessionId,
      );
      const offClose = this.onClosed(() => {
        cleanup();
        reject(new CdpClosedError());
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpError(method, `event not received within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => {
        cleanup();
        reject(opts.signal?.reason ?? new Error("aborted"));
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  onClosed(handler: () => void): () => void {
    if (this.isClosed) {
      queueMicrotask(handler);
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (!this.isClosed) this.ws.close();
    this.onClose();
  }

  private onMessage(data: unknown): void {
    let msg: Params;
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.message ?? "error", msg.error.code));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const params = (msg.params ?? {}) as Params;
      // Session-specific listeners, then connection-wide listeners.
      if (msg.sessionId) this.emit(eventKey(msg.method, msg.sessionId), params);
      this.emit(eventKey(msg.method), { ...params, sessionId: msg.sessionId });
    }
  }

  private emit(key: string, params: Params): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(params);
      } catch {
        // a listener's bug must not break the connection
      }
    }
  }

  private onClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpClosedError());
    }
    this.pending.clear();
    for (const h of [...this.closeHandlers]) h();
    this.closeHandlers.clear();
    this.listeners.clear();
  }
}

function eventKey(method: string, sessionId?: string): string {
  return `${sessionId ?? "*"}|${method}`;
}
