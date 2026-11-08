/** One Chrome tab, driven over a flat CDP session. */
import { CdpConnection, CdpError } from "./cdp.js";

export type WaitUntil = "domcontentloaded" | "load";

export interface GotoOptions {
  timeoutMs?: number;
  waitUntil?: WaitUntil;
  signal?: AbortSignal;
}

export interface GotoResult {
  /** URL after redirects. */
  url: string;
  /** HTTP status of the main document, if there was one. */
  status?: number;
  mimeType?: string;
  /** True if the wait timed out; the page may still be usable. */
  timedOut: boolean;
  ms: number;
}

export class NavigationError extends Error {
  override name = "NavigationError";
}

export class Page {
  private closedFlag = false;

  private constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    private mainFrameId: string,
  ) {}

  /** Open a tab; with `browserContextId` it lives in that (e.g. cookie-less) context. */
  static async create(conn: CdpConnection, browserContextId?: string): Promise<Page> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
    });
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const opts = { sessionId };
    await Promise.all([
      conn.send("Page.enable", {}, opts),
      conn.send("Network.enable", {}, opts),
      conn.send("Page.setLifecycleEventsEnabled", { enabled: true }, opts),
    ]);
    const { frameTree } = await conn.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, opts);
    return new Page(conn, targetId, sessionId, frameTree.frame.id);
  }

  get closed(): boolean {
    return this.closedFlag || this.conn.closed;
  }

  private send<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.conn.send<T>(method, params, { sessionId: this.sessionId, timeoutMs });
  }

  /**
   * Navigate and wait for DOMContentLoaded or load. A slow page is not an
   * error: after the timeout we return what is there (`timedOut: true`).
   */
  async goto(url: string, opts: GotoOptions = {}): Promise<GotoResult> {
    const start = performance.now();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const wanted = opts.waitUntil === "load" ? "load" : "DOMContentLoaded";

    // The document we wait for. A page may replace itself (JS or meta
    // redirect, e.g. Google -> its CAPTCHA page) before it finishes loading;
    // we then follow the newest main-frame document.
    let loaderId: string | undefined;
    const responses = new Map<string, { status?: number; mimeType?: string; url?: string }>();
    const reached = new Set<string>(); // `${loaderId}|${event}` seen for the main frame
    let wake: () => void = () => {};

    // Subscribe before navigating so no event is missed.
    const offs = [
      this.conn.on(
        "Network.responseReceived",
        (p) => {
          if (p.type !== "Document" || p.frameId !== this.mainFrameId) return;
          responses.set(p.loaderId, { status: p.response?.status, mimeType: p.response?.mimeType, url: p.response?.url });
        },
        this.sessionId,
      ),
      this.conn.on(
        "Page.lifecycleEvent",
        (p) => {
          if (p.frameId !== this.mainFrameId) return;
          reached.add(`${p.loaderId}|${p.name}`);
          wake();
        },
        this.sessionId,
      ),
      this.conn.on(
        "Page.frameNavigated",
        (p) => {
          const f = p.frame;
          if (!f || f.parentId || f.id !== this.mainFrameId) return;
          if (loaderId && f.loaderId && f.loaderId !== loaderId) {
            loaderId = f.loaderId;
            wake();
          }
        },
        this.sessionId,
      ),
    ];

    try {
      const nav = await this.send<{ frameId: string; loaderId?: string; errorText?: string }>(
        "Page.navigate",
        { url },
        timeoutMs,
      );
      if (nav.errorText) throw new NavigationError(`${url}: ${nav.errorText}`);
      this.mainFrameId = nav.frameId;
      // Same-document navigation (only the #hash changed): nothing to wait for.
      if (!nav.loaderId) return { url, timedOut: false, ms: performance.now() - start };
      loaderId = nav.loaderId;

      const done = () => reached.has(`${loaderId}|${wanted}`);
      const waitDone = new Promise<void>((resolve) => {
        wake = () => {
          if (done()) resolve();
        };
        wake();
      });
      const timedOut = await raceTimeout(waitDone, timeoutMs, opts.signal);
      const res = responses.get(loaderId) ?? responses.get(nav.loaderId) ?? {};
      return { url: res.url ?? url, status: res.status, mimeType: res.mimeType, timedOut, ms: performance.now() - start };
    } finally {
      for (const off of offs) off();
    }
  }

  /** Listen to a CDP event from this tab. Returns an unsubscribe function. */
  onEvent(method: string, listener: (params: Record<string, any>) => void): () => void {
    return this.conn.on(method, listener, this.sessionId);
  }

  /** Send a raw CDP command to this tab. */
  cdp<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.send<T>(method, params, timeoutMs);
  }

  /** Run an expression in the page and return its JSON-serializable value. */
  async evaluate<T = unknown>(expression: string, timeoutMs = 10_000): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new CdpError("Runtime.evaluate", d.exception?.description ?? d.text);
    }
    return res.result.value as T;
  }

  html(): Promise<string> {
    return this.evaluate<string>("document.documentElement ? document.documentElement.outerHTML : ''");
  }

  title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closedFlag = true;
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId }, { timeoutMs: 5000 });
    } catch {
      // already gone
    }
  }
}

/** Resolves false when `p` settles first, true on timeout; rejects on abort. */
function raceTimeout(p: Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(true), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const done = (timedOut: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(timedOut);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(() => done(false));
  });
}
