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

  static async create(conn: CdpConnection): Promise<Page> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
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

    let loaderId: string | undefined;
    let status: number | undefined;
    let mimeType: string | undefined;
    let finalUrl = url;
    const early: { loaderId: string; name: string }[] = [];
    let cleanupLifecycle: () => void = () => {};

    // Subscribe before navigating so no event is missed.
    const offResponse = this.conn.on(
      "Network.responseReceived",
      (p) => {
        if (p.type !== "Document" || p.frameId !== this.mainFrameId) return;
        if (loaderId && p.loaderId !== loaderId) return;
        status = p.response?.status;
        mimeType = p.response?.mimeType;
        finalUrl = p.response?.url ?? finalUrl;
      },
      this.sessionId,
    );
    const lifecycle = new Promise<void>((resolve) => {
      const off = this.conn.on(
        "Page.lifecycleEvent",
        (p) => {
          if (p.frameId !== this.mainFrameId || p.name !== wanted) return;
          if (!loaderId) {
            early.push({ loaderId: p.loaderId, name: p.name });
            return;
          }
          if (p.loaderId === loaderId) {
            off();
            resolve();
          }
        },
        this.sessionId,
      );
      cleanupLifecycle = off;
    });

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

      const already = early.some((e) => e.loaderId === loaderId);
      let timedOut = false;
      if (!already) {
        timedOut = await raceTimeout(lifecycle, timeoutMs, opts.signal);
      }
      return { url: finalUrl, status, mimeType, timedOut, ms: performance.now() - start };
    } finally {
      offResponse();
      cleanupLifecycle();
    }
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
