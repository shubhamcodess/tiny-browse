/**
 * `browser.onChallenge: "show"`: let the user solve a CAPTCHA themselves in a
 * visible window on the tiny-browse profile. We never solve it automatically.
 */
import type { Browser } from "../browser/browser.js";
import { CdpConnection } from "../browser/cdp.js";
import { killTree, launchChrome } from "../browser/chrome.js";
import { resolveBrowser } from "../browser/discover.js";
import type { Config } from "../config.js";
import { log } from "../util/log.js";

const CHALLENGE_URL = /\/sorry\/|captcha|\/challenge/i;

/**
 * Show `url` to the user and wait until they get past the challenge or the
 * time runs out. Returns true if it looks solved.
 */
export async function showChallenge(browser: Browser, config: Config, url: string, timeoutMs = 90_000): Promise<boolean> {
  if (config.browser.mode === "attach") {
    // The user's own Chrome is already visible: open the page there.
    return browser.withPage(async (page) => {
      await page.cdp("Page.bringToFront");
      await page.goto(url, { timeoutMs: 15_000 });
      return waitForSolved(() => page.evaluate<string>("location.href"), timeoutMs);
    }, { kind: "profile" });
  }

  // The profile can be open in only one Chrome: swap the headless one for a visible one.
  await browser.close();
  const exe = resolveBrowser(config.browser.path);
  const { wsUrl, child } = await launchChrome({
    executable: exe.path,
    profileDir: config.browser.profileDir,
    headless: false,
    startUrl: url,
  });
  log.warn("search engine asked for a CAPTCHA; showing it in a Chrome window for you to solve");
  const conn = await CdpConnection.connect(wsUrl);
  try {
    return await waitForSolved(async () => {
      const { targetInfos } = await conn.send<{ targetInfos: { type: string; url: string }[] }>("Target.getTargets");
      const pages = targetInfos.filter((t) => t.type === "page");
      return pages.length ? pages[0]!.url : "";
    }, timeoutMs);
  } finally {
    await conn.send("Browser.close").catch(() => undefined); // graceful: keeps the cookie Google sets
    conn.close();
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          killTree(child);
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

async function waitForSolved(currentUrl: () => Promise<string>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 750));
    let href = "";
    try {
      href = await currentUrl();
    } catch {
      return false; // window closed
    }
    if (href && /^https?:/.test(href) && !CHALLENGE_URL.test(href)) return true;
  }
  return false;
}
