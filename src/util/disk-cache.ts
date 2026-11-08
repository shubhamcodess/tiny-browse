/**
 * Tiny JSON file cache with a TTL, shared by all tiny-browse processes.
 * One file per key (hashed), written atomically; old files are pruned.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class DiskCache<T> {
  private writes = 0;

  constructor(
    private readonly dir: string | undefined,
    private readonly ttlMs: number,
    private readonly maxFiles = 500,
    private readonly now: () => number = Date.now,
  ) {}

  private path(key: string): string {
    return join(this.dir!, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  get(key: string): T | undefined {
    if (!this.dir) return undefined;
    try {
      const { at, k, v } = JSON.parse(readFileSync(this.path(key), "utf8")) as { at: number; k: string; v: T };
      if (k !== key || this.now() - at > this.ttlMs) return undefined;
      return v;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: T): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.path(key);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: this.now(), k: key, v: value }));
      renameSync(tmp, file);
      if (++this.writes % 25 === 0) this.prune();
    } catch {
      // caching is best-effort
    }
  }

  /** Remove expired files, then the oldest beyond maxFiles. */
  prune(): void {
    if (!this.dir) return;
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const p = join(this.dir!, f);
          return { p, at: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.at - a.at);
      files.forEach((f, i) => {
        if (i >= this.maxFiles || this.now() - f.at > this.ttlMs) unlinkSync(f.p);
      });
    } catch {
      // best-effort
    }
  }
}
