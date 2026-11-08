/**
 * Find a Chromium-family browser already installed on this computer.
 * We never download or bundle one.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface BrowserCandidate {
  name: string;
  path: string;
}

type Env = Record<string, string | undefined>;

/** Known install locations, in order of preference. */
export function candidatePaths(platform: NodeJS.Platform = process.platform, env: Env = process.env): BrowserCandidate[] {
  if (platform === "darwin") {
    const apps = (app: string, bin: string) => [
      join("/Applications", app, "Contents", "MacOS", bin),
      join(homedir(), "Applications", app, "Contents", "MacOS", bin),
    ];
    return [
      ...apps("Google Chrome.app", "Google Chrome").map((path) => ({ name: "Google Chrome", path })),
      ...apps("Chromium.app", "Chromium").map((path) => ({ name: "Chromium", path })),
      ...apps("Microsoft Edge.app", "Microsoft Edge").map((path) => ({ name: "Microsoft Edge", path })),
      ...apps("Brave Browser.app", "Brave Browser").map((path) => ({ name: "Brave", path })),
      ...apps("Google Chrome Canary.app", "Google Chrome Canary").map((path) => ({ name: "Chrome Canary", path })),
    ];
  }

  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const under = (name: string, ...rel: string[]) => roots.map((root) => ({ name, path: join(root, ...rel) }));
    return [
      ...under("Google Chrome", "Google", "Chrome", "Application", "chrome.exe"),
      ...under("Chromium", "Chromium", "Application", "chrome.exe"),
      ...under("Microsoft Edge", "Microsoft", "Edge", "Application", "msedge.exe"),
      ...under("Brave", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ];
  }

  // Linux and other Unixes: look the usual binary names up on PATH.
  const names: [string, string][] = [
    ["Google Chrome", "google-chrome-stable"],
    ["Google Chrome", "google-chrome"],
    ["Chromium", "chromium"],
    ["Chromium", "chromium-browser"],
    ["Microsoft Edge", "microsoft-edge-stable"],
    ["Microsoft Edge", "microsoft-edge"],
    ["Brave", "brave-browser"],
  ];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/bin", "/usr/local/bin", "/snap/bin"];
  const unique = [...new Set(dirs)];
  return names.flatMap(([name, bin]) => unique.map((dir) => ({ name, path: join(dir, bin) })));
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** All installed browsers we could use, best first, without duplicates. */
export function discoverBrowsers(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  exists: (path: string) => boolean = isExecutable,
): BrowserCandidate[] {
  const seen = new Set<string>();
  const found: BrowserCandidate[] = [];
  for (const c of candidatePaths(platform, env)) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    if (exists(c.path)) found.push(c);
  }
  return found;
}

export class BrowserNotFoundError extends Error {
  override name = "BrowserNotFoundError";
}

/** The browser to use: an explicit path if configured, else the best one found. */
export function resolveBrowser(explicitPath: string, platform?: NodeJS.Platform, env?: Env): BrowserCandidate {
  if (explicitPath) {
    if (!isExecutable(explicitPath)) {
      throw new BrowserNotFoundError(`browser.path does not point to an executable: ${explicitPath}`);
    }
    return { name: "configured browser", path: explicitPath };
  }
  const [best] = discoverBrowsers(platform, env);
  if (!best) {
    throw new BrowserNotFoundError(
      "No Chrome, Chromium, Edge or Brave installation found. Install Google Chrome, or set " +
        "browser.path / TINY_BROWSE_CHROME / --browser-path to a Chromium-based browser.",
    );
  }
  return best;
}
