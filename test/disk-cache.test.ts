import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskCache } from "../src/util/disk-cache.js";

describe("DiskCache", () => {
  it("shares values between instances, expires them and prunes old files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiny-browse-dc-"));
    let now = 0;
    const a = new DiskCache<{ n: number }>(dir, 1000, 3, () => now);
    const b = new DiskCache<{ n: number }>(dir, 1000, 3, () => now);
    a.set("k1", { n: 1 });
    expect(b.get("k1")).toEqual({ n: 1 });
    now = 1500;
    expect(b.get("k1")).toBeUndefined();
    for (let i = 0; i < 6; i++) a.set(`x${i}`, { n: i });
    a.prune();
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(3);
  });

  it("does nothing without a directory", () => {
    const c = new DiskCache<number>(undefined, 1000);
    c.set("k", 1);
    expect(c.get("k")).toBeUndefined();
  });
});
