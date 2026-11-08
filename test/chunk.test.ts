import { describe, expect, it } from "vitest";
import { capTokens } from "../src/core/chrome-engine.js";
import { decodeCursor, encodeCursor } from "../src/core/cursor.js";
import { pack, rankChunks, splitDocument, terms } from "../src/extract/chunk.js";
import { pickToRead } from "../src/search/rank.js";
import type { SerpResult } from "../src/search/types.js";
import { countTokens } from "../src/util/tokens.js";

const para = (topic: string, n = 60) => `${topic} `.repeat(n).trim() + ".";

const DOC = [
  "# Guide to Widgets",
  "> https://ex.com/widgets · Ex",
  "Widgets are small reusable parts. This guide covers installing, configuring and testing them, see [the spec][1].",
  "## Installation",
  para("install the package with npm"),
  "### macOS",
  "Use Homebrew to install the native helper on macOS.",
  "```bash\nbrew install widget-helper\n\n# blank line inside the fence must not split it\nwidget-helper --version\n```",
  "## Configuration",
  para("configure the timeout and retries in widget.config.json"),
  "| key | default |\n| --- | --- |\n| timeout | 30 |\n| retries | 3 |",
  "## Testing",
  para("run the tests with the mock server"),
  "See [mocks][2].",
  "[1]: https://ex.com/spec\n[2]: https://ex.com/mocks",
].join("\n\n");

describe("splitDocument", () => {
  const doc = splitDocument(DOC, { maxTokens: 400, minTokens: 20 });

  it("keeps the title and source line as the head and the link definitions apart", () => {
    expect(doc.head).toBe("# Guide to Widgets\n\n> https://ex.com/widgets · Ex");
    expect([...doc.refs.entries()]).toEqual([["1", "https://ex.com/spec"], ["2", "https://ex.com/mocks"]]);
  });

  it("chunks by heading with heading paths, never splitting code or tables", () => {
    const paths = doc.chunks.map((c) => c.path.join(" › "));
    expect(paths).toContain("Installation › macOS");
    expect(paths).toContain("Configuration");
    const mac = doc.chunks.find((c) => c.path.at(-1) === "macOS")!;
    expect(mac.text).toContain("brew install widget-helper\n\n# blank line inside the fence must not split it\nwidget-helper --version\n```");
    expect(doc.chunks.some((c) => c.text.includes("| timeout | 30 |\n| retries | 3 |"))).toBe(true);
  });
});

describe("BM25 focus and packing", () => {
  const doc = splitDocument(DOC, { maxTokens: 400, minTokens: 20 });

  it("ranks the matching section first, with heading matches counting extra", () => {
    const scores = rankChunks(doc.chunks, "how do I configure retries?");
    const best = doc.chunks[scores.indexOf(Math.max(...scores))]!;
    expect(best.path).toEqual(["Configuration"]);
    expect(terms("Configuring retries and timeouts")).toEqual(["configur", "retri", "timeout"]);
  });

  it("packs in order and hands back a cursor position", () => {
    const p = pack(doc, 220);
    expect(p.tokens).toBeLessThanOrEqual(220);
    expect(p.text).toMatch(/^# Guide to Widgets/);
    expect(p.text).toContain("[1]: https://ex.com/spec"); // only definitions actually used
    expect(p.text).not.toContain("[2]: https://ex.com/mocks");
    expect(p.next).toBeGreaterThan(0);
    const rest = pack(doc, 2000, { start: p.next });
    expect(rest.text).toMatch(/^# Guide to Widgets\n\n> .*\n\n…/);
    expect(rest.next).toBe(-1);
    expect(rest.text).toContain("[2]: https://ex.com/mocks");
  });

  it("with a focus: opening section, then the best matches, in document order", () => {
    const p = pack(doc, 260, { focus: "testing with the mock server" });
    expect(p.text).toContain("Widgets are small reusable parts");
    expect(p.text).toContain("## Testing");
    expect(p.text).not.toContain("## Configuration");
    expect(p.text).toMatch(/…\n\n## Testing/);
    expect(p.tokens).toBeLessThanOrEqual(260);
  });

  it("cuts an oversized section rather than returning nothing, closing code fences", () => {
    const big = splitDocument(`# T\n\n## Code\n\n\`\`\`js\n${"const x = 1;\n".repeat(400)}\`\`\``);
    const p = pack(big, 120);
    expect(p.text).toContain("```js");
    expect((p.text.match(/```/g) ?? []).length % 2).toBe(0);
    expect(p.tokens).toBeLessThanOrEqual(130);
  });
});

describe("cursor and hard cap", () => {
  it("round-trips cursors and rejects junk", () => {
    const c = encodeCursor({ u: "https://ex.com/a", c: 3 });
    expect(decodeCursor(c)).toEqual({ u: "https://ex.com/a", c: 3 });
    expect(decodeCursor("not-a-cursor")).toBeUndefined();
    expect(decodeCursor(encodeCursor({ u: "file:///etc/passwd", c: 0 }))).toBeUndefined();
  });

  it("never lets the answer exceed max_tokens and leaves no block open", () => {
    const md = `# R\n\n<!-- begin untrusted content from ex.com -->\n${"paragraph text here ".repeat(30)}\n\n\`\`\`js\n${"code();\n".repeat(600)}\`\`\`\n<!-- end untrusted content -->\n`;
    for (const max of [200, 400, 800]) {
      const out = capTokens(md, max);
      expect(countTokens(out)).toBeLessThanOrEqual(max);
      expect(out).toContain("Output cut to fit max_tokens");
      expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect(out).toContain("<!-- end untrusted content -->");
    }
    expect(capTokens("short", 200)).toBe("short");
  });
});

describe("ranking what to read", () => {
  const r = (rank: number, url: string, title: string, snippet = ""): SerpResult => ({ rank, url, title, snippet, foundBy: ["visual"] });
  const results = [
    r(1, "https://www.pinterest.com/pin/1", "Widget ideas"),
    r(2, "https://docs.widgets.dev/configure", "Configure widgets", "timeout and retries"),
    r(3, "https://docs.widgets.dev/other", "More widget docs"),
    r(4, "https://blog.example.com/widgets", "Widgets retries explained", "configure retries"),
    r(5, "https://spam.example.net/x", "Widgets"),
  ];

  it("prefers relevant primary sources, one per site, and honours prefer/block", () => {
    const picks = pickToRead(results, "configure widget retries", 2, { prefer: [], block: [] });
    expect(picks.map((p) => p.rank)).toEqual([2, 4]);
    const blocked = pickToRead(results, "configure widget retries", 3, { prefer: ["spam.example.net"], block: ["widgets.dev"] });
    expect(blocked.map((p) => p.rank)).toEqual([5, 4, 1]);
  });
});
