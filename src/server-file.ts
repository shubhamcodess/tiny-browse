/**
 * `tiny-browse serve --http` announces itself in `<cacheDir>/server.json` so
 * library clients with useServer: "auto" can use its warm Chrome instead of
 * starting their own. The file is private to the user (0600); it is removed
 * when the server stops, and ignored if its process is gone.
 */
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { EngineResult } from "./core/engine.js";
import { TinyBrowseError, type TinyBrowseErrorCode } from "./errors.js";
import { log } from "./util/log.js";

export interface ServerInfo {
  url: string;
  pid: number;
  version: string;
  token?: string;
}

const FILE = "server.json";

export function serverFilePath(cacheDir: string): string {
  return join(cacheDir, FILE);
}

export function writeServerFile(cacheDir: string, info: ServerInfo): string {
  mkdirSync(cacheDir, { recursive: true });
  const path = serverFilePath(cacheDir);
  writeFileSync(path, JSON.stringify(info), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Remove the file, but only if it still describes this process. */
export function removeServerFile(cacheDir: string, pid = process.pid): void {
  const path = serverFilePath(cacheDir);
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    if (info.pid === pid) unlinkSync(path);
  } catch {
    // already gone
  }
}

export function findServer(cacheDir: string): ServerInfo | undefined {
  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(serverFilePath(cacheDir), "utf8")) as ServerInfo;
  } catch {
    return undefined;
  }
  if (typeof info.url !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(info.url)) return undefined;
  try {
    process.kill(info.pid, 0); // throws if the process is gone
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return info;
}

/**
 * Send a call to the server. Returns undefined if it can't be reached (the
 * caller then runs in-process); throws TinyBrowseError for errors it reports.
 */
export async function callServer(info: ServerInfo, path: "/search" | "/fetch", input: unknown, signal: AbortSignal): Promise<EngineResult | undefined> {
  let res: Response;
  try {
    res = await fetch(info.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(info.token ? { authorization: `Bearer ${info.token}` } : {}) },
      body: JSON.stringify(input),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    log.debug(`tiny-browse server at ${info.url} not reachable, running in-process`, err);
    return undefined;
  }
  const body = (await res.json().catch(() => ({}))) as Partial<EngineResult> & { error?: string; code?: TinyBrowseErrorCode };
  if (res.ok && typeof body.markdown === "string") return body as EngineResult;
  if (res.status === 401 || res.status === 403) {
    log.debug(`tiny-browse server at ${info.url} refused the call (HTTP ${res.status}), running in-process`);
    return undefined;
  }
  throw new TinyBrowseError(body.code ?? "network", body.error ?? `tiny-browse server answered HTTP ${res.status}`);
}
