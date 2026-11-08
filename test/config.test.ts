import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, configFromEnv, defaultConfig, loadConfig, mergeConfig } from "../src/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tiny-browse-test-"));
}

describe("config", () => {
  it("defaults to Chrome-first with fallbacks, eager launch and fallback on CAPTCHA", () => {
    const c = defaultConfig({});
    expect(c.search.providers).toEqual(["google", "duckduckgo", "bing"]);
    expect(c.browser.eager).toBe(true);
    expect(c.browser.onChallenge).toBe("fallback");
    expect(c.browser.profileDir).toMatch(/tiny-browse.+chrome-profile$/);
  });

  it("merges sections one level deep and replaces arrays", () => {
    const c = mergeConfig(defaultConfig({}), { search: { providers: ["duckduckgo"] }, browser: { headless: false } });
    expect(c.search.providers).toEqual(["duckduckgo"]);
    expect(c.search.read).toBe(3);
    expect(c.browser.headless).toBe(false);
    expect(c.browser.eager).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(() => mergeConfig(defaultConfig({}), { nope: 1 } as never)).toThrow(ConfigError);
    expect(() => mergeConfig(defaultConfig({}), { browser: { nope: 1 } } as never)).toThrow(/browser\.nope/);
  });

  it("reads env overrides; a CDP URL switches to attach mode", () => {
    const input = configFromEnv({ TINY_BROWSE_CDP_URL: "http://localhost:9222", TINY_BROWSE_PROVIDERS: "bing,google" });
    expect(input.browser).toEqual({ cdpUrl: "http://localhost:9222", mode: "attach" });
    expect(input.search?.providers).toEqual(["bing", "google"]);
    expect(() => configFromEnv({ TINY_BROWSE_PROVIDERS: "altavista" })).toThrow(/altavista/);
    expect(() => configFromEnv({ TINY_BROWSE_HEADLESS: "maybe" })).toThrow(ConfigError);
  });

  it("applies files, env and flags in order", () => {
    const xdg = tempDir();
    mkdirSync(join(xdg, "tiny-browse"));
    writeFileSync(join(xdg, "tiny-browse", "config.json"), JSON.stringify({ search: { read: 5 }, logLevel: "debug" }));
    const cwd = tempDir();
    writeFileSync(join(cwd, "tiny-browse.config.json"), JSON.stringify({ search: { read: 2 } }));
    const env = { XDG_CONFIG_HOME: xdg, TINY_BROWSE_LOG_LEVEL: "warn" };

    const { config, files } = loadConfig({ env, cwd, flags: { browser: { headless: false } } });
    expect(files).toHaveLength(2);
    expect(config.search.read).toBe(2); // project file beats user file
    expect(config.logLevel).toBe("warn"); // env beats files
    expect(config.browser.headless).toBe(false); // flags beat everything
  });

  it("fails clearly on a missing explicit file and bad JSON", () => {
    const cwd = tempDir();
    expect(() => loadConfig({ env: {}, cwd, file: "missing.json" })).toThrow(/not found/);
    writeFileSync(join(cwd, "bad.json"), "{ nope");
    expect(() => loadConfig({ env: {}, cwd, file: "bad.json" })).toThrow(/cannot parse/);
  });

  it("validates values", () => {
    const cwd = tempDir();
    expect(() => loadConfig({ env: {}, cwd, flags: { search: { read: 99 } } })).toThrow(/search\.read/);
    expect(() => loadConfig({ env: {}, cwd, flags: { browser: { mode: "attach" } } })).toThrow(/cdpUrl/);
  });
});
