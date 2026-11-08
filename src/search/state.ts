/**
 * Small persistent state shared by all tiny-browse processes on this computer:
 * which providers are cooling down after a CAPTCHA/consent wall, and when.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SearchProviderName } from "../config.js";

export interface Cooldown {
  until: number;
  reason: string;
}

export class ProviderState {
  private readonly file: string;
  private memory: Partial<Record<SearchProviderName, Cooldown>> = {};

  constructor(cacheDir: string | undefined, private readonly now: () => number = Date.now) {
    this.file = cacheDir ? join(cacheDir, "provider-state.json") : "";
  }

  private load(): Partial<Record<SearchProviderName, Cooldown>> {
    if (!this.file) return this.memory;
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return this.memory;
    }
  }

  private save(state: Partial<Record<SearchProviderName, Cooldown>>): void {
    this.memory = state;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, this.file);
    } catch {
      // state is an optimisation; never fail a search over it
    }
  }

  coolingDown(provider: SearchProviderName): Cooldown | undefined {
    const c = this.load()[provider];
    return c && c.until > this.now() ? c : undefined;
  }

  coolDown(provider: SearchProviderName, ms: number, reason: string): void {
    const state = this.load();
    state[provider] = { until: this.now() + ms, reason };
    this.save(state);
  }

  clear(provider: SearchProviderName): void {
    const state = this.load();
    if (!state[provider]) return;
    delete state[provider];
    this.save(state);
  }
}
