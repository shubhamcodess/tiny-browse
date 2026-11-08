/**
 * Per-site memory of which way of reading works: a plain HTTP fetch, or a
 * full Chrome load. Shared by all tiny-browse processes via the cache dir.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Tier = "http" | "browser";

interface Hint {
  tier: Tier;
  at: number;
}

const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 2000;

export class TierHints {
  private readonly file: string;
  private memory: Record<string, Hint> = {};
  private loaded = false;

  constructor(cacheDir: string | undefined, private readonly now: () => number = Date.now) {
    this.file = cacheDir ? join(cacheDir, "tier-hints.json") : "";
  }

  private load(): Record<string, Hint> {
    if (this.loaded || !this.file) return this.memory;
    this.loaded = true;
    try {
      this.memory = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.memory = {};
    }
    return this.memory;
  }

  get(host: string): Tier | undefined {
    const h = this.load()[host];
    return h && this.now() - h.at < TTL_MS ? h.tier : undefined;
  }

  set(host: string, tier: Tier): void {
    const all = this.load();
    if (all[host]?.tier === tier && this.now() - all[host]!.at < TTL_MS / 7) return;
    all[host] = { tier, at: this.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, keys.length - MAX_ENTRIES)) delete all[k];
    }
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all));
      renameSync(tmp, this.file);
    } catch {
      // hints are an optimisation only
    }
  }
}
