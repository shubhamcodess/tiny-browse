/**
 * Calibration of the model-agnostic token counter against real tokenizers
 * (gpt-tokenizer is a dev dependency only; it is never shipped).
 */
import { readFileSync } from "node:fs";
import { encode as cl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as o200k } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
import { countTokens } from "../src/util/tokens.js";

const root = new URL("../", import.meta.url).pathname;
const file = (p: string) => readFileSync(root + p, "utf8");

const SAMPLES: [string, string][] = [
  ["design doc (Markdown prose)", file("docs/DESIGN.md")],
  ["README", file("README.md")],
  ["TypeScript (in-page extractor)", file("src/extract/inpage.ts")],
  ["TypeScript (search service)", file("src/search/search.ts")],
  ["HTML article", file("test/fixtures/pages/article.html")],
  ["reference links", Array.from({ length: 40 }, (_, i) => `[${i}]: https://developer.example.com/en-US/docs/Web/API/Thing${i}/method_name?ref=page&id=${i * 7919}`).join("\n")],
  ["numbers table", Array.from({ length: 200 }, (_, i) => `| ${(i * 12345.67).toFixed(2)} | ${2026 - i} | ${(i * 0.031).toFixed(3)}% |`).join("\n")],
  ["Chinese", "模型上下文协议是一种开放标准，用于让人工智能应用程序与外部工具和数据源进行连接。它定义了客户端与服务器之间的消息格式。".repeat(8)],
  ["Japanese", "東京は日本の首都であり、世界で最も人口の多い都市圏の一つです。交通網が非常に発達しています。".repeat(8)],
  ["German", "Die Geschwindigkeitsbegrenzung auf deutschen Autobahnen ist ein häufig diskutiertes Thema in der Verkehrspolitik. ".repeat(10)],
];

describe("countTokens calibration", () => {
  const rows = SAMPLES.map(([name, text]) => {
    const a = cl100k(text).length;
    const b = o200k(text).length;
    const ours = countTokens(text);
    return { name, chars: text.length, cl100k: a, o200k: b, ours, vsCl: ours / a, vsO2: ours / b };
  });

  it("prints the calibration table", () => {
    console.table(rows.map((r) => ({ ...r, vsCl: r.vsCl.toFixed(2), vsO2: r.vsO2.toFixed(2) })));
  });

  // Real tokenizers disagree (o200k needs ~35% fewer tokens than cl100k for CJK),
  // so "model-agnostic" means: inside the range they span, with a margin.
  it.each(SAMPLES.map(([n]) => n))("%s: within the range of real tokenizers (-15%% / +25%%)", (name) => {
    const r = rows.find((x) => x.name === name)!;
    expect(r.ours).toBeGreaterThanOrEqual(Math.min(r.cl100k, r.o200k) * 0.85);
    expect(r.ours).toBeLessThanOrEqual(Math.max(r.cl100k, r.o200k) * 1.25);
  });

  it("is biased high overall: totals at or above both real tokenizers", () => {
    const sum = (k: "cl100k" | "o200k" | "ours") => rows.reduce((n, r) => n + r[k], 0);
    expect(sum("ours")).toBeGreaterThanOrEqual(sum("o200k"));
    expect(sum("ours") / sum("cl100k")).toBeGreaterThan(0.97);
    expect(sum("ours") / sum("cl100k")).toBeLessThan(1.15);
  });

  it("handles the edges", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello")).toBe(2); // 1 word, rounded up by the safety margin
    expect(countTokens("hello world")).toBeLessThanOrEqual(3);
  });
});
