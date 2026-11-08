/** Environment checks shared by `tiny-browse doctor` and the library's doctor(). */
import { Browser } from "../browser/browser.js";
import { discoverBrowsers, resolveBrowser } from "../browser/discover.js";
import type { Config } from "../config.js";
import { limitsFrom, RateBudget } from "../search/budget.js";
import { ProviderState } from "../search/state.js";

export interface Check {
  name: string;
  /** null = information only (not a pass/fail result). */
  ok: boolean | null;
  detail: string;
}

export async function runChecks(config: Config, opts: { startChrome?: boolean } = {}): Promise<Check[]> {
  const major = Number(process.versions.node.split(".")[0]);
  const checks: Check[] = [{ name: "node >= 22", ok: major >= 22, detail: process.version }];
  if (config.browser.mode === "off") {
    checks.push({ name: "browser", ok: null, detail: 'Chrome turned off (browser.mode "off"): plain HTTP only' });
  } else {
    const discovery = discoveryCheck(config);
    checks.push(discovery);
    if (opts.startChrome !== false) {
      checks.push(discovery.ok === false ? { name: "chrome session", ok: null, detail: "skipped" } : await browserCheck(config));
    }
  }
  checks.push(...budgetChecks(config));
  return checks;
}

/** Start (or reuse) Chrome and load a tiny page, timing each step. */
async function browserCheck(config: Config): Promise<Check> {
  const browser = new Browser(config.browser);
  try {
    const s = await browser.ensure();
    const nav = await browser.withPage(async (page) => {
      const res = await page.goto("data:text/html,<title>tiny-browse ok</title>", { timeoutMs: 10_000 });
      return { ...res, title: await page.title() };
    });
    const how = s.kind === "launched" ? "started" : s.kind === "shared" ? "reused running" : "attached to";
    return { name: "chrome session", ok: nav.title === "tiny-browse ok", detail: `${how} ${s.product} in ${s.startMs} ms, page load ${Math.round(nav.ms)} ms` };
  } catch (err) {
    return { name: "chrome session", ok: false, detail: (err as Error).message.split("\n")[0]! };
  } finally {
    await browser.close();
  }
}

function discoveryCheck(config: Config): Check {
  if (config.browser.mode === "attach") return { name: "browser", ok: null, detail: `attach mode: ${config.browser.cdpUrl}` };
  try {
    const chosen = resolveBrowser(config.browser.path);
    const others = discoverBrowsers().filter((b) => b.path !== chosen.path).map((b) => b.name);
    return { name: "browser", ok: true, detail: `${chosen.name} (${chosen.path})${others.length ? `; also found: ${others.join(", ")}` : ""}` };
  } catch (err) {
    return { name: "browser", ok: false, detail: (err as Error).message };
  }
}

function budgetChecks(config: Config): Check[] {
  const dir = config.cache.enabled ? config.cache.dir : undefined;
  const limits = limitsFrom(config.search.limits);
  const budget = new RateBudget(dir, limits);
  const state = new ProviderState(dir);
  return config.search.providers.map((p) => {
    const u = budget.usage(p);
    const lim = limits[p];
    const cooling = state.coolingDown(p);
    const parts = [`used ${u.minute}/${lim.perMinute} per min, ${u.hour}/${lim.perHour} per hour, ${u.day}/${lim.perDay} per day`];
    if (cooling) parts.push(`paused ${Math.ceil((cooling.until - Date.now()) / 60_000)} min after ${cooling.reason}`);
    if (u.strikes) parts.push(`${u.strikes} CAPTCHA(s) in a row`);
    // Information, not a failure: a paused engine just means searches use the next one.
    return { name: `search: ${p}`, ok: null, detail: parts.join("; ") };
  });
}
