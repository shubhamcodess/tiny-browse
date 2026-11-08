import { describe, expect, it } from "vitest";
import { candidatePaths, discoverBrowsers } from "../src/browser/discover.js";
import { chromeArgs } from "../src/browser/chrome.js";

describe("browser discovery", () => {
  it("prefers Chrome over Edge on macOS", () => {
    const installed = new Set([
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    const found = discoverBrowsers("darwin", {}, (p) => installed.has(p));
    expect(found.map((b) => b.name)).toEqual(["Google Chrome", "Microsoft Edge"]);
  });

  it("looks in Program Files and LocalAppData on Windows", () => {
    const paths = candidatePaths("win32", { PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\L" }).map((c) => c.path);
    expect(paths.some((p) => p.includes("PF") && p.endsWith("chrome.exe"))).toBe(true);
    expect(paths.some((p) => p.includes("L") && p.endsWith("msedge.exe"))).toBe(true);
  });

  it("searches PATH on Linux and dedupes", () => {
    const found = discoverBrowsers("linux", { PATH: "/opt/bin:/usr/bin" }, (p) => p === "/usr/bin/chromium");
    expect(found).toEqual([{ name: "Chromium", path: "/usr/bin/chromium" }]);
  });

  it("returns nothing when no browser is installed", () => {
    expect(discoverBrowsers("darwin", {}, () => false)).toEqual([]);
  });

  it("builds headless args on the given profile", () => {
    const args = chromeArgs({ executable: "x", profileDir: "/p", headless: true });
    expect(args).toContain("--user-data-dir=/p");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--headless");
    expect(args.at(-1)).toBe("about:blank");
    expect(chromeArgs({ executable: "x", profileDir: "/p", headless: false, startUrl: "https://g.co" })).not.toContain(
      "--headless",
    );
  });
});
