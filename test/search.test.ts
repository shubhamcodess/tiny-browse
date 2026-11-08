import { describe, expect, it } from "vitest";
import { loginSummary } from "../src/browser/login.js";
import { defaultConfig } from "../src/config.js";
import { PROVIDERS, type ProviderDef } from "../src/search/providers.js";
import { SearchService, SearchUnavailableError, type ReadPage } from "../src/search/search.js";
import { judge, mergeStrategies, queryTerms, relevance, resultsFromAxTree } from "../src/search/serp.js";
import { ProviderState } from "../src/search/state.js";
import { DEFAULT_LIMITS, RateBudget, type Limits } from "../src/search/budget.js";
import type { PageSignals, SerpPage, SerpResult, SerpStatus } from "../src/search/types.js";
import { normalizeUrl, unwrapTarget } from "../src/search/urls.js";
import { setLogLevel } from "../src/util/log.js";

setLogLevel("silent");

describe("unwrapTarget", () => {
  const g = PROVIDERS.google.internalHost;
  const b = PROVIDERS.bing.internalHost;
  const d = PROVIDERS.duckduckgo.internalHost;

  it("unwraps Google /url redirects but not searches", () => {
    expect(unwrapTarget("/url?q=https://example.com/a&sa=U", "https://www.google.com/search?q=x", g)).toBe(
      "https://example.com/a",
    );
    expect(unwrapTarget("/search?q=related", "https://www.google.com/search?q=x", g)).toBe(
      "https://www.google.com/search?q=related",
    );
  });

  it("decodes Bing's base64 u=a1 parameter", () => {
    const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from("https://rust-lang.org/").toString("base64url")}&ntb=1`;
    expect(unwrapTarget(href, "https://www.bing.com/search", b)).toBe("https://rust-lang.org/");
  });

  it("unwraps DuckDuckGo uddg links", () => {
    const href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&rut=1";
    expect(unwrapTarget(href, "https://html.duckduckgo.com/html/", d)).toBe("https://example.org/page");
  });

  it("leaves other sites' links alone, even with url-like params", () => {
    expect(unwrapTarget("https://example.com/r?url=https://evil.test/", "https://www.google.com/", g)).toBe(
      "https://example.com/r?url=https://evil.test/",
    );
    expect(unwrapTarget("javascript:void(0)", "https://www.google.com/", g)).toBeNull();
  });

  it("does not treat Google product sites as the engine itself", () => {
    expect(new RegExp(g).test("cloud.google.com")).toBe(false);
    expect(new RegExp(g).test("www.google.co.in")).toBe(true);
  });

  it("normalizes for dedupe", () => {
    expect(normalizeUrl("https://Example.com/a?utm_source=x&id=2#top")).toBe("https://example.com/a?id=2");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });
});

const r = (url: string, title = url, snippet = "") => ({ url, title, snippet });

describe("mergeStrategies", () => {
  const internal = PROVIDERS.google.internalHost;

  it("requires two votes when two strategies work", () => {
    const { results, counts } = mergeStrategies(
      [
        { name: "visual", results: [r("https://a.com/1", "A"), r("https://b.com", "B"), r("https://c.com", "C"), r("https://ad.com", "Ad")] },
        { name: "accessibility", results: [r("https://a.com/1", "A"), r("https://b.com", "B"), r("https://c.com", "C")] },
        { name: "selectors", results: [] },
      ],
      internal,
    );
    expect(results.map((x) => x.url)).toEqual(["https://a.com/1", "https://b.com", "https://c.com"]);
    expect(counts).toEqual({ visual: 4, accessibility: 3, selectors: 0 });
  });

  it("trusts a single working strategy (the redesign case)", () => {
    const { results } = mergeStrategies(
      [
        { name: "visual", results: [r("https://a.com"), r("https://b.com"), r("https://c.com")] },
        { name: "accessibility", results: [] },
        { name: "selectors", results: [] },
      ],
      internal,
    );
    expect(results).toHaveLength(3);
    expect(results[0]!.foundBy).toEqual(["visual"]);
  });

  it("keeps visual order, prefers visual titles and the longest snippet", () => {
    const { results } = mergeStrategies(
      [
        { name: "visual", results: [r("https://b.com", "B vis", "short"), r("https://a.com", "A vis")] },
        { name: "accessibility", results: [r("https://a.com", "A ax"), r("https://b.com", "B ax")] },
        { name: "selectors", results: [r("https://b.com", "B sel", "a much longer snippet")] },
      ],
      internal,
    );
    expect(results.map((x) => x.title)).toEqual(["B vis", "A vis"]);
    expect(results[0]!.snippet).toBe("a much longer snippet");
  });
});

describe("resultsFromAxTree", () => {
  it("takes links under or around headings and unwraps them", () => {
    const nodes = [
      { nodeId: "1", role: { value: "heading" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "link" }, name: { value: "Title A" }, properties: [{ name: "url", value: { value: "https://www.google.com/url?q=https://a.com/" } }] },
      { nodeId: "3", role: { value: "link" }, name: { value: "Not a result" }, properties: [{ name: "url", value: { value: "https://b.com/" } }] },
      { nodeId: "4", role: { value: "link" }, childIds: ["5"], properties: [{ name: "url", value: { value: "https://c.com/" } }] },
      { nodeId: "5", parentId: "4", role: { value: "heading" }, name: { value: "Title C" } },
    ];
    expect(resultsFromAxTree(nodes, "https://www.google.com/search", PROVIDERS.google.internalHost)).toEqual([
      { url: "https://a.com/", title: "Title A", snippet: "" },
      { url: "https://c.com/", title: "Title C", snippet: "" },
    ]);
  });
});

describe("judge and relevance", () => {
  const signals: PageSignals = { url: "", title: "", challenge: false, consent: false, noResults: false };
  const res = (titles: string[]): SerpResult[] =>
    titles.map((t, i) => ({ rank: i + 1, title: t, url: `https://s${i}.com`, snippet: "", foundBy: ["visual"] }));

  it("drops stopwords and operators from query terms", () => {
    expect(queryTerms("What is the best Node.js websocket client? site:github.com")).toEqual(["node", "websocket", "client"]);
  });

  it("flags challenges, consent and empty pages", () => {
    expect(judge({ ...signals, challenge: true }, res(["a", "b", "c"]))).toBe("challenge");
    expect(judge({ ...signals, consent: true }, [])).toBe("consent");
    expect(judge({ ...signals, noResults: true }, [])).toBe("no_results");
    expect(judge(signals, res(["only one"]))).toBe("unhealthy");
  });

  it("flags results unrelated to the query", () => {
    const junk = res(["YouTube", "Facebook - Log In or Sign Up", "Bing homepage quiz", "Weather"]);
    expect(judge(signals, junk, "python list comprehension")).toBe("off_topic");
    const good = res(["List Comprehensions in Python", "Python list comprehension tutorial", "PEP 202", "Comprehensions"]);
    expect(judge(signals, good, "python list comprehension")).toBe("ok");
    expect(relevance("python list comprehension", good).best).toBe(1);
  });

  it("does not count the URL scheme as matching 'http'", () => {
    const dictionary = res(["Do vs. Does: How to Use Them", "DOES Definition & Meaning", "DOES | English meaning"]);
    expect(judge(signals, dictionary, "how does http/3 quic work")).toBe("off_topic");
  });
});

describe("login summary", () => {
  it("reports what Google actually showed", () => {
    expect(loginSummary({ consentSaved: false, signedIn: false, results: true })).toBe(
      "Google showed search results: this profile can search Google.",
    );
    expect(loginSummary({ consentSaved: false, signedIn: false, results: true, challenge: true })).toMatch(/after the CAPTCHA/);
    expect(loginSummary({ consentSaved: false, signedIn: false, challenge: true })).toMatch(/fall back/);
    expect(loginSummary({ consentSaved: true, signedIn: true, results: true })).toMatch(/consent and sign-in are saved/);
    // No consent page, no cookie: normal outside the EU, so nothing alarming is said.
    expect(loginSummary({ consentSaved: false, signedIn: false, results: true })).not.toMatch(/consent/i);
  });
});

describe("SearchService fallback chain", () => {
  const page = (provider: ProviderDef["name"], status: SerpStatus, n = 3): SerpPage => ({
    provider,
    status,
    results: Array.from({ length: n }, (_, i) => ({
      rank: i + 1,
      title: `${provider} ${i}`,
      url: `https://${provider}${i}.com`,
      snippet: "",
      foundBy: ["visual"],
    })),
    signals: { url: `https://${provider}/x`, title: "", challenge: status === "challenge", consent: false, noResults: false },
    strategies: { visual: n, accessibility: n, selectors: n },
    ms: 10,
  });

  function setup(script: Partial<Record<ProviderDef["name"], SerpStatus[]>>, limits = NO_LIMITS) {
    const config = defaultConfig({});
    config.cache.enabled = false; // never touch the real cache dir from tests
    const calls: string[] = [];
    const readPage: ReadPage = async (def) => {
      calls.push(def.name);
      const status = script[def.name]?.shift() ?? "ok";
      return page(def.name, status);
    };
    let now = 1_000_000;
    const state = new ProviderState(undefined, () => now);
    const budget = new RateBudget(undefined, limits, () => now, () => 0);
    const service = new SearchService({} as never, config, state, readPage, budget);
    return { service, calls, budget, advance: (ms: number) => (now += ms) };
  }

  it("skips an engine whose rate budget is used up, without contacting it", async () => {
    const tight = { ...NO_LIMITS, google: { minGapMs: 0, jitterMs: 0, perMinute: 1, perHour: 1, perDay: 1 } };
    const { service, calls } = setup({}, tight);
    await service.search("first", opts, signal);
    const out = await service.search("second", opts, signal);
    expect(calls).toEqual(["google", "duckduckgo"]);
    expect(out.attempts[0]).toMatchObject({ provider: "google", status: "skipped" });
    expect(out.attempts[0]!.note).toMatch(/rate budget: next request allowed in 24 h/);
  });

  it("backs off longer after each CAPTCHA in a row", async () => {
    const { service, calls, advance } = setup({ google: ["challenge", "challenge"] });
    await service.search("a", opts, signal); // strike 1: 15 min
    advance(16 * 60_000);
    await service.search("b", opts, signal); // strike 2: 1 h
    advance(16 * 60_000);
    await service.search("c", opts, signal); // still cooling
    expect(calls.filter((c) => c === "google")).toHaveLength(2);
    advance(45 * 60_000);
    await service.search("d", opts, signal);
    expect(calls.filter((c) => c === "google")).toHaveLength(3);
  });
  const opts = { freshness: "any" as const, maxResults: 5 };
  const signal = new AbortController().signal;

  it("uses Google when it works", async () => {
    const { service, calls } = setup({});
    const out = await service.search("q", opts, signal);
    expect(out.page.provider).toBe("google");
    expect(calls).toEqual(["google"]);
  });

  it("falls back past a CAPTCHA and an off-topic page, and reports each attempt", async () => {
    const { service, calls } = setup({ google: ["challenge"], duckduckgo: ["off_topic"] });
    const out = await service.search("q", opts, signal);
    expect(out.page.provider).toBe("bing");
    expect(calls).toEqual(["google", "duckduckgo", "bing"]);
    expect(out.attempts.map((a) => [a.provider, a.status])).toEqual([
      ["google", "challenge"],
      ["duckduckgo", "off_topic"],
      ["bing", "ok"],
    ]);
  });

  it("skips a provider cooling down after a CAPTCHA, then retries it later", async () => {
    const { service, calls, advance } = setup({ google: ["challenge"] });
    await service.search("first", opts, signal);
    await service.search("second", opts, signal);
    expect(calls).toEqual(["google", "duckduckgo", "duckduckgo"]);
    advance(16 * 60_000);
    await service.search("third", opts, signal);
    expect(calls.at(-1)).toBe("google");
  });

  it("serves repeated queries from the cache", async () => {
    const { service, calls } = setup({});
    await service.search("same", opts, signal);
    const again = await service.search("Same", opts, signal);
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns off-topic results with a warning when nothing better exists", async () => {
    const { service } = setup({ google: ["challenge"], duckduckgo: ["challenge"], bing: ["off_topic"] });
    const out = await service.search("q", opts, signal);
    expect(out.page.provider).toBe("bing");
    expect(out.warning).toMatch(/may not match/);
  });

  it("fails with a summary when every provider fails", async () => {
    const { service } = setup({ google: ["challenge"], duckduckgo: ["consent"], bing: ["error"] });
    const err = await service.search("q", opts, signal).catch((e) => e);
    expect(err).toBeInstanceOf(SearchUnavailableError);
    expect(err.message).toMatch(/Google: CAPTCHA; DuckDuckGo: consent page/);
  });
});

const NO_LIMITS = Object.fromEntries(
  Object.keys(DEFAULT_LIMITS).map((k) => [k, { minGapMs: 0, jitterMs: 0, perMinute: 1e6, perHour: 1e6, perDay: 1e6 }]),
) as Record<keyof typeof DEFAULT_LIMITS, Limits>;

describe("RateBudget", () => {
  it("keeps Google's default gap and windows", () => {
    let now = 0;
    const b = new RateBudget(undefined, DEFAULT_LIMITS, () => now, () => 0);
    expect(b.reserve("google")).toEqual({ ok: true, waitMs: 0 });
    expect(b.reserve("google")).toEqual({ ok: true, waitMs: 8000 }); // min gap
    now = 16_000;
    expect(b.reserve("google")).toEqual({ ok: true, waitMs: 0 });
    now = 24_000;
    // 4th within a minute would have to wait 36 s for the window: refused, the search falls back.
    expect(b.reserve("google")).toMatchObject({ ok: false, reason: "rate budget: next request allowed in 36 s" });
    now = 60_001;
    expect(b.reserve("google")).toEqual({ ok: true, waitMs: 0 });
  });

  it("refuses rather than waits beyond the limit, and caps the day", () => {
    let now = 0;
    const lim = { ...DEFAULT_LIMITS, google: { minGapMs: 0, jitterMs: 0, perMinute: 100, perHour: 100, perDay: 2 } };
    const b = new RateBudget(undefined, lim, () => now, () => 0);
    b.reserve("google");
    b.reserve("google");
    const third = b.reserve("google");
    expect(third.ok).toBe(false);
    now += 24 * 60 * 60_000 + 1;
    expect(b.reserve("google").ok).toBe(true);
    expect(b.usage("google").day).toBe(1);
  });

  it("is shared through the cache dir", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tiny-browse-budget-"));
    const a = new RateBudget(dir, DEFAULT_LIMITS, () => 0, () => 0);
    const b = new RateBudget(dir, DEFAULT_LIMITS, () => 0, () => 0);
    a.reserve("google");
    expect(b.reserve("google")).toEqual({ ok: true, waitMs: 8000 });
    expect(b.strike("google")).toBe(15 * 60_000);
    expect(a.strike("google")).toBe(60 * 60_000);
  });
});
