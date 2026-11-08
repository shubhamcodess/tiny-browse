/**
 * Owns the Chrome session for one tiny-browse process:
 * - starts Chrome on the tiny-browse profile (or reuses the one another
 *   tiny-browse already runs on it, or attaches to a user-given address),
 * - keeps one spare blank tab ready so a request never waits for a new tab,
 * - recovers automatically if Chrome crashes or is closed,
 * - shuts Chrome down after it has been idle for a while.
 */
import type { ChildProcess } from "node:child_process";
import type { Config } from "../config.js";
import { log } from "../util/log.js";
import { CdpConnection } from "./cdp.js";
import { findRunningOnProfile, launchChrome, resolveCdpUrl } from "./chrome.js";
import { resolveBrowser } from "./discover.js";
import { Page } from "./page.js";

/** How we got hold of Chrome. */
export type SessionKind =
  | "launched" // we started it
  | "shared" // another tiny-browse started it on the same profile
  | "attached"; // the user's own Chrome via browser.cdpUrl; never closed by us

export interface BrowserSession {
  conn: CdpConnection;
  kind: SessionKind;
  child?: ChildProcess;
  product: string;
  executable?: string;
  startMs: number;
}

export interface BrowserDeps {
  launch: typeof launchChrome;
  findRunning: typeof findRunningOnProfile;
  resolveCdp: typeof resolveCdpUrl;
  resolveExecutable: typeof resolveBrowser;
}

const DEFAULT_DEPS: BrowserDeps = {
  launch: launchChrome,
  findRunning: findRunningOnProfile,
  resolveCdp: resolveCdpUrl,
  resolveExecutable: resolveBrowser,
};

export class Browser {
  private session: Promise<BrowserSession> | undefined;
  private spare: Promise<Page> | undefined;
  private active = 0;
  private lastUsed = Date.now();
  /** Tabs this instance opened; ignored when deciding whether others use Chrome. */
  private readonly ownTargets = new Set<string>();
  private readonly closingTabs = new Set<Promise<void>>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly cfg: Config["browser"],
    private readonly deps: BrowserDeps = DEFAULT_DEPS,
  ) {}

  /** Connect (starting Chrome if needed). Concurrent callers share one attempt. */
  ensure(): Promise<BrowserSession> {
    if (!this.session) {
      const attempt = this.open();
      this.session = attempt;
      attempt.then(
        (s) =>
          s.conn.onClosed(() => {
            if (this.session !== attempt) return;
            log.warn("lost the connection to Chrome; it will be restarted on the next request");
            this.session = undefined;
            this.spare = undefined;
            this.ownTargets.clear();
          }),
        () => {
          if (this.session === attempt) this.session = undefined;
        },
      );
    }
    return this.session;
  }

  /** Start Chrome and prepare a spare tab, so the first request is fast. */
  async warm(): Promise<BrowserSession> {
    const s = await this.ensure();
    if (!this.spare) this.spare = this.newSpare(s);
    await this.spare.catch(() => undefined);
    return s;
  }

  /** Run `fn` with a fresh tab; the tab is closed afterwards. */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    this.active++;
    let page: Page | undefined;
    try {
      page = await this.acquire();
      return await fn(page);
    } finally {
      this.active--;
      this.lastUsed = Date.now();
      if (page) this.closeTab(page);
    }
  }

  /** Close a tab without making the caller wait for it. */
  private closeTab(page: Page): void {
    // The target id stays in ownTargets: Chrome may still list a tab for a
    // moment after Target.closeTarget returns.
    const p = page.close().finally(() => this.closingTabs.delete(p));
    this.closingTabs.add(p);
  }

  async close(): Promise<void> {
    this.stopIdleTimer();
    const pending = this.session;
    this.session = undefined;
    const spare = this.spare;
    this.spare = undefined;
    if (!pending) return;
    let s: BrowserSession;
    try {
      s = await pending;
    } catch {
      return;
    }
    await spare?.then((p) => this.closeTab(p)).catch(() => undefined);
    await Promise.all(this.closingTabs);
    await this.release(s);
    this.ownTargets.clear();
  }

  private async open(): Promise<BrowserSession> {
    const start = performance.now();
    let wsUrl: string;
    let kind: SessionKind;
    let child: ChildProcess | undefined;
    let executable: string | undefined;

    if (this.cfg.mode === "attach") {
      wsUrl = await this.deps.resolveCdp(this.cfg.cdpUrl);
      kind = "attached";
    } else {
      const running = await this.deps.findRunning(this.cfg.profileDir);
      if (running) {
        wsUrl = running;
        kind = "shared";
      } else {
        const exe = this.deps.resolveExecutable(this.cfg.path);
        executable = exe.path;
        log.debug(`starting ${exe.name}: ${exe.path}`);
        const launched = await this.deps.launch({
          executable: exe.path,
          profileDir: this.cfg.profileDir,
          headless: this.cfg.headless,
        });
        wsUrl = launched.wsUrl;
        child = launched.child;
        kind = "launched";
        killOnExit(child);
      }
    }

    const conn = await CdpConnection.connect(wsUrl);
    const version = await conn.send<{ product: string }>("Browser.getVersion");
    const startMs = Math.round(performance.now() - start);
    log.info(`${kind === "launched" ? "started" : "connected to"} ${version.product} in ${startMs} ms (${kind})`);
    this.startIdleTimer();
    return { conn, kind, child, product: version.product, executable, startMs };
  }

  private async acquire(): Promise<Page> {
    const s = await this.ensure();
    let page: Page | undefined;
    if (this.spare) {
      const spare = this.spare;
      this.spare = undefined;
      page = await spare.catch(() => undefined);
      if (page?.closed) page = undefined;
    }
    page ??= await this.createTab(s);
    // Refill in the background for the next request.
    this.spare = this.newSpare(s);
    return page;
  }

  private async createTab(s: BrowserSession): Promise<Page> {
    const page = await Page.create(s.conn);
    this.ownTargets.add(page.targetId);
    return page;
  }

  private newSpare(s: BrowserSession): Promise<Page> {
    const p = this.createTab(s);
    p.catch((err) => log.debug("could not prepare a spare tab", err));
    return p;
  }

  /** Close or disconnect from Chrome, unless someone else is using it. */
  private async release(s: BrowserSession): Promise<void> {
    if (s.kind === "attached") {
      s.conn.close();
      return;
    }
    if (await this.othersBusy(s)) {
      log.debug("leaving Chrome running: another tiny-browse is using it");
      s.conn.close();
      return;
    }
    log.debug("closing Chrome");
    try {
      // Graceful close so cookies (e.g. Google consent) are written to the profile.
      await s.conn.send("Browser.close", {}, { timeoutMs: 3000 });
    } catch {
      // fall through to kill
    }
    s.conn.close();
    if (s.child) await waitForExit(s.child, 5000);
  }

  /** True if Chrome has open tabs with real pages (another tiny-browse at work). */
  private async othersBusy(s: BrowserSession): Promise<boolean> {
    try {
      const { targetInfos } = await s.conn.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>(
        "Target.getTargets",
        {},
        { timeoutMs: 2000 },
      );
      return targetInfos.some(
        (t) => t.type === "page" && t.url !== "about:blank" && !this.ownTargets.has(t.targetId),
      );
    } catch {
      return false;
    }
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return;
    const every = Math.max(1000, Math.min(30_000, Math.floor(this.cfg.idleTimeoutMs / 2)));
    this.idleTimer = setInterval(() => void this.checkIdle(), every);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async checkIdle(): Promise<void> {
    if (this.active > 0 || !this.session) return;
    if (Date.now() - this.lastUsed < this.cfg.idleTimeoutMs) return;
    log.info(`Chrome idle for ${Math.round(this.cfg.idleTimeoutMs / 1000)} s, shutting it down`);
    await this.close();
  }
}

const children = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Make sure a Chrome we started never outlives this process. */
function killOnExit(child: ChildProcess): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const c of children) c.kill("SIGKILL");
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
