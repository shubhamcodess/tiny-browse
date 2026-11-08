/**
 * `tiny-browse login`: open a visible Chrome on the tiny-browse profile so the
 * user can accept Google's consent screen (and, only if they ask, sign in).
 * Cookies stay in the profile and are reused by the headless searches.
 */
import type { Config } from "../config.js";
import { log } from "../util/log.js";
import { CdpConnection } from "./cdp.js";
import { findRunningOnProfile, killTree, launchChrome } from "./chrome.js";
import { resolveBrowser } from "./discover.js";

export interface LoginOptions {
  signIn: boolean;
  /** Where progress messages go (stderr by default). */
  print?: (line: string) => void;
}

export interface LoginResult {
  consentSaved: boolean;
  signedIn: boolean;
  /** Google showed a results page at some point. */
  results?: boolean;
  /** Google showed its "unusual traffic" CAPTCHA at some point. */
  challenge?: boolean;
  /** Google showed its consent page at some point. */
  consent?: boolean;
}

/** What to tell the user after `login`. */
export function loginSummary(r: LoginResult): string {
  const lines: string[] = [];
  if (r.results) {
    lines.push(
      r.challenge
        ? "Google showed search results after the CAPTCHA: this profile can search Google now."
        : "Google showed search results: this profile can search Google.",
    );
  } else if (r.challenge) {
    lines.push(
      "Google showed a CAPTCHA and no results were reached. Searches will fall back to DuckDuckGo/Bing " +
        "until Google trusts this profile; run `tiny-browse login` again and solve it, or try `--sign-in`.",
    );
  } else {
    lines.push("No Google results page was seen before the window was closed.");
  }
  if (r.consentSaved) lines.push(`Google consent${r.signedIn ? " and sign-in are" : " is"} saved in the profile.`);
  else if (r.consent) lines.push("Google's consent page appeared but the choice was not saved; run login again and accept it.");
  else if (r.signedIn) lines.push("Your Google sign-in is saved in the profile.");
  // No consent page and no cookie is normal outside regions that require it.
  return lines.join("\n");
}

const CONSENT_URL = "https://www.google.com/search?q=tiny-browse&hl=en";
const SIGN_IN_URL = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(CONSENT_URL)}`;

export async function login(config: Config, opts: LoginOptions): Promise<LoginResult> {
  const print = opts.print ?? ((l: string) => process.stderr.write(`${l}\n`));
  if (config.browser.mode === "attach") {
    throw new Error("login uses the tiny-browse profile; it is not needed when attaching to your own Chrome (browser.cdpUrl).");
  }

  // The profile can only be open in one Chrome. Close the background one
  // (an agent's tiny-browse restarts it automatically when needed).
  const running = await findRunningOnProfile(config.browser.profileDir);
  if (running) {
    print("Closing the background tiny-browse Chrome (it restarts automatically when needed)...");
    const conn = await CdpConnection.connect(running);
    await conn.send("Browser.close").catch(() => undefined);
    conn.close();
    await waitUntil(async () => !(await findRunningOnProfile(config.browser.profileDir)), 5000);
  }

  const exe = resolveBrowser(config.browser.path);
  const { wsUrl, child } = await launchChrome({
    executable: exe.path,
    profileDir: config.browser.profileDir,
    headless: false,
    startUrl: opts.signIn ? SIGN_IN_URL : CONSENT_URL,
  });
  const conn = await CdpConnection.connect(wsUrl);

  print(`Opened ${exe.name} with the tiny-browse profile (${config.browser.profileDir}).`);
  print(
    opts.signIn
      ? "Sign in to Google, accept the consent screen if it appears, then close the Chrome window."
      : "Accept Google's consent screen if it appears, then close the Chrome window.\n" +
          "(Signing in is optional: run `tiny-browse login --sign-in` if you want it.)",
  );

  // Note what Google showed while the window was open.
  const seen = { results: false, challenge: false, consent: false };
  const track = (url: unknown) => {
    if (typeof url !== "string") return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (/^consent\.google\./.test(u.hostname)) seen.consent = true;
    else if (/google\./.test(u.hostname) && /\/sorry\//.test(u.pathname)) seen.challenge = true;
    else if (/google\./.test(u.hostname) && u.pathname === "/search") seen.results = true;
  };
  conn.on("Target.targetCreated", (p) => track(p.targetInfo?.url));
  conn.on("Target.targetInfoChanged", (p) => track(p.targetInfo?.url));

  // Done when the last tab is closed (on macOS closing the window doesn't quit Chrome), or on Ctrl+C.
  await Promise.race([
    waitForNoPages(conn),
    new Promise<void>((resolve) => process.once("SIGINT", resolve)),
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
  ]);

  let result: LoginResult = { consentSaved: false, signedIn: false };
  if (!conn.closed) {
    result = await readGoogleState(conn);
    // Graceful close writes the cookies to disk.
    await conn.send("Browser.close").catch(() => undefined);
  }
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

  result = { ...result, ...seen };
  print(loginSummary(result));
  return result;
}

async function waitForNoPages(conn: CdpConnection): Promise<void> {
  await conn.send("Target.setDiscoverTargets", { discover: true });
  const pages = new Set<string>();
  const { targetInfos } = await conn.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  for (const t of targetInfos) if (t.type === "page") pages.add(t.targetId);
  if (pages.size === 0) return;
  await new Promise<void>((resolve) => {
    const offCreated = conn.on("Target.targetCreated", (p) => {
      if (p.targetInfo?.type === "page") pages.add(p.targetInfo.targetId);
    });
    const offDestroyed = conn.on("Target.targetDestroyed", (p) => {
      pages.delete(p.targetId);
      if (pages.size === 0) {
        offCreated();
        offDestroyed();
        resolve();
      }
    });
    conn.onClosed(resolve);
  });
}

async function readGoogleState(conn: CdpConnection): Promise<LoginResult> {
  try {
    const { cookies } = await conn.send<{ cookies: { name: string; domain: string }[] }>("Storage.getCookies");
    const google = cookies.filter((c) => /(^|\.)google\.[a-z.]+$/.test(c.domain.replace(/^\./, "")));
    return {
      consentSaved: google.some((c) => c.name === "SOCS" || c.name === "CONSENT"),
      signedIn: google.some((c) => c.name === "SID" || c.name === "__Secure-1PSID"),
    };
  } catch (err) {
    log.debug("could not read cookies", err);
    return { consentSaved: false, signedIn: false };
  }
}

async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
