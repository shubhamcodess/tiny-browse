/**
 * Start Chrome on the tiny-browse profile, or find the one already running on
 * it, or resolve a user-supplied remote-debugging address.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { log } from "../util/log.js";

export interface LaunchOptions {
  executable: string;
  profileDir: string;
  headless: boolean;
  /** Page to open instead of about:blank (used by `login`). */
  startUrl?: string;
  timeoutMs?: number;
}

export interface Launched {
  wsUrl: string;
  child: ChildProcess;
}

export class LaunchError extends Error {
  override name = "LaunchError";
}

export function chromeArgs(opts: LaunchOptions): string[] {
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
  ];
  // Avoid OS keychain prompts for the dedicated profile.
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  if (process.platform === "linux") args.push("--password-store=basic");
  if (opts.headless) args.push("--headless", "--hide-scrollbars");
  args.push(opts.startUrl ?? "about:blank");
  return args;
}

/** Spawn Chrome and wait for its DevTools WebSocket address. */
export function launchChrome(opts: LaunchOptions): Promise<Launched> {
  mkdirSync(opts.profileDir, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 20_000;
  // Own process group (not on Windows): Chrome and all its helper processes
  // can then be killed together, so none outlives tiny-browse.
  const child = spawn(opts.executable, chromeArgs(opts), { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });

  return new Promise((resolve, reject) => {
    const tail: string[] = [];
    const lines = createInterface({ input: child.stderr! });
    let done = false;

    const finish = (err: Error | null, wsUrl?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        killTree(child);
        reject(err);
      } else {
        // Keep draining stderr so Chrome never blocks on a full pipe.
        lines.removeAllListeners("line");
        lines.on("line", (l) => log.debug(`chrome: ${l}`));
        resolve({ wsUrl: wsUrl!, child });
      }
    };

    lines.on("line", (line) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(line);
      if (m) finish(null, m[1]);
    });
    child.once("error", (err) => finish(new LaunchError(`cannot start ${opts.executable}: ${err.message}`)));
    child.once("exit", (code) => {
      const hint = tail.some((l) => /existing browser session/i.test(l))
        ? " Another Chrome is already using the tiny-browse profile without remote debugging; close it and retry."
        : "";
      finish(new LaunchError(`Chrome exited (code ${code}) before it was ready.${hint}\n${tail.join("\n")}`));
    });
    const timer = setTimeout(
      () => finish(new LaunchError(`Chrome did not start within ${timeoutMs} ms.\n${tail.join("\n")}`)),
      timeoutMs,
    );
  });
}

/**
 * If a Chrome with remote debugging is already running on this profile (for
 * example another tiny-browse serving a second agent), return its address.
 */
export async function findRunningOnProfile(profileDir: string): Promise<string | undefined> {
  let content: string;
  try {
    content = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
  } catch {
    return undefined;
  }
  const [port, path] = content.split(/\r?\n/);
  if (!port || !path || !/^\d+$/.test(port)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    // The file may be stale from a crashed browser whose port got reused.
    const expected = `ws://127.0.0.1:${port}${path}`;
    return info.webSocketDebuggerUrl === expected ? expected : undefined;
  } catch {
    return undefined;
  }
}

/** Accept `ws://…` as is, or ask an `http://host:port` endpoint for its WebSocket address. */
export async function resolveCdpUrl(url: string): Promise<string> {
  if (/^wss?:\/\//.test(url)) return url;
  if (!/^https?:\/\//.test(url)) throw new LaunchError(`browser.cdpUrl must start with ws:// or http://, got ${url}`);
  const base = url.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    throw new LaunchError(
      `cannot reach Chrome at ${base} (${(err as Error).message}). Start Chrome with ` +
        "--remote-debugging-port=9222 --user-data-dir=<a separate folder>.",
    );
  }
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new LaunchError(`${base}/json/version did not return a WebSocket address`);
  return info.webSocketDebuggerUrl;
}

/** Kill Chrome and every helper process it started (its process group). */
export function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // group already gone: fall through to the single process
    }
  }
  child.kill("SIGKILL");
}
