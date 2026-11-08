import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  normalizeHeadings,
  polish,
  quality,
  renderDocument,
  truncateToTokens,
} from "../src/extract/markdown.js";
import { LINK_CLOSE, LINK_MID, LINK_OPEN, type Block, type Extracted } from "../src/extract/types.js";

const link = (n: number, text: string) => `${LINK_OPEN}${n}${LINK_MID}${text}${LINK_CLOSE}`;

function doc(blocks: Block[], over: Partial<Extracted> = {}): Extracted {
  return {
    meta: { url: "https://ex.com/a", canonical: "https://ex.com/a", title: "Title", siteName: "Ex", description: "", published: "2026-01-02T00:00:00Z", author: "", lang: "en" },
    blocks,
    links: ["https://ex.com/x", "https://ex.com/y"],
    images: [{ src: "https://ex.com/i.png", alt: "A chart", caption: "Fig 1", width: 600, height: 300 }],
    stats: { textChars: 2000, linkChars: 50, paragraphs: 5, headings: 2, bodyChars: 3000, root: "scored:article", boilerplateHits: 0 },
    ...over,
  };
}

describe("headings", () => {
  it("assigns levels to appearance-detected headings and closes gaps", () => {
    const blocks: Block[] = [
      { t: "h", level: 2, size: 28, text: "A" },
      { t: "h", level: 0, size: 22, text: "B (styled)" },
      { t: "h", level: 4, size: 18, text: "C" },
      { t: "h", level: 0, size: 28, text: "D (styled like h2)" },
    ];
    normalizeHeadings(blocks, 2);
    expect(blocks.map((b) => (b as { level: number }).level)).toEqual([2, 3, 4, 2]);
  });

  it("ranks a styled heading above smaller real headings", () => {
    const blocks: Block[] = [
      { t: "h", level: 0, size: 26, text: "Styled section" },
      { t: "h", level: 3, size: 19, text: "Real h3" },
    ];
    normalizeHeadings(blocks, 2);
    expect(blocks.map((b) => (b as { level: number }).level)).toEqual([2, 3]);
  });
});

describe("render", () => {
  const blocks: Block[] = [
    { t: "h", level: 1, size: 32, text: "Title" },
    { t: "p", text: `See ${link(0, "this guide")} and ${link(1, "that one")}, then ${link(0, "this guide")} again.` },
    { t: "h", level: 2, size: 24, text: "Setup" },
    { t: "code", lang: "js", text: "const a = 1;\n```inner```" },
    { t: "list", ordered: true, start: 1, items: [[{ t: "p", text: "one" }], [{ t: "p", text: "two" }, { t: "list", ordered: false, start: 1, items: [[{ t: "p", text: "nested" }]] }]] },
    { t: "table", header: true, complex: false, rows: [["A", "B"], ["1", "x|y"]] },
    { t: "img", ref: 0 },
    { t: "quote", blocks: [{ t: "p", text: "quoted" }] },
  ];

  it("renders reference links, nested lists, safe fences, tables and drops the duplicate title", () => {
    const { markdown } = renderDocument(doc(blocks), { links: "reference", images: "off", titleLevel: 1, header: true });
    expect(markdown).toContain("# Title\n\n> https://ex.com/a · Ex · 2026-01-02");
    expect(markdown.match(/^# Title/gm)).toHaveLength(1);
    expect(markdown).toContain("See [this guide][1] and [that one][2], then [this guide][1] again.");
    expect(markdown).toContain("[1]: https://ex.com/x\n[2]: https://ex.com/y");
    expect(markdown).toContain("## Setup");
    expect(markdown).toContain("````js\nconst a = 1;\n```inner```\n````");
    expect(markdown).toContain("1. one\n2. two\n\n   - nested");
    expect(markdown).toContain("| A | B |\n| --- | --- |\n| 1 | x\\|y |");
    expect(markdown).toContain("[image: A chart]");
    expect(markdown).toContain("> quoted");
  });

  it("supports inline links, plain text and image URLs", () => {
    const inline = renderDocument(doc(blocks), { links: "inline", images: "urls", titleLevel: 2, header: false });
    expect(inline.markdown).toContain("[this guide](https://ex.com/x)");
    expect(inline.markdown).toContain("![A chart](https://ex.com/i.png)\n*Fig 1*");
    expect(inline.markdown).toContain("### Setup");
    expect(inline.imageRefs).toEqual([0]);
    const text = renderDocument(doc(blocks), { links: "text", images: "off", titleLevel: 1, header: false });
    expect(text.markdown).toContain("See this guide and that one");
  });

  it("renders key/value and complex tables as lists", () => {
    const kv = renderDocument(doc([{ t: "table", header: false, complex: true, rows: [["Developer", "IETF"], ["Released", "2021"]] }]), {
      links: "reference", images: "off", titleLevel: 1, header: false,
    });
    expect(kv.markdown).toContain("- **Developer**: IETF\n- **Released**: 2021");
  });
});

describe("polish", () => {
  it("removes noise, link-only lines, repeats and empty sections; merges split sentences", () => {
    const out = polish([
      { t: "p", text: "Advertisement" },
      { t: "p", text: `${link(0, "Home")} · ${link(1, "Blog")}` },
      { t: "h", level: 2, size: 0, text: "Empty section" },
      { t: "h", level: 2, size: 0, text: "Real section" },
      { t: "p", text: "The sentence was split by an inline ad and" },
      { t: "p", text: "continues here." },
      { t: "p", text: "Reply" },
      { t: "p", text: "Reply" },
      { t: "p", text: "Reply" },
      { t: "p", text: "*" },
    ]);
    expect(out).toEqual([
      { t: "h", level: 2, size: 0, text: "Real section" },
      { t: "p", text: "The sentence was split by an inline ad and continues here." },
    ]);
  });
});

describe("tokens and quality", () => {
  it("estimates tokens and truncates at block boundaries", () => {
    expect(estimateTokens("The quick brown fox jumps over the lazy dog.")).toBeGreaterThanOrEqual(10);
    const md = ["# T", "para one ".repeat(40), "para two ".repeat(40), "para three ".repeat(40)].join("\n\n");
    const cut = truncateToTokens(md, 120);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain("para one");
    expect(cut.text).not.toContain("para three");
    expect(cut.remainingTokens).toBeGreaterThan(0);
  });

  it("scores real articles high and link farms or walls low", () => {
    const prose = Array.from({ length: 6 }, (_, i) => ({ t: "p" as const, text: `Paragraph ${i} about streams and backpressure `.repeat(8) }));
    expect(quality(doc([{ t: "h", level: 2, size: 0, text: "S" }, ...prose]), "Streams backpressure")).toBeGreaterThan(0.8);
    const farm = doc([{ t: "p", text: "Home Blog About" }], { stats: { textChars: 500, linkChars: 480, paragraphs: 1, headings: 0, bodyChars: 600, root: "body", boilerplateHits: 2 } });
    expect(quality(farm)).toBeLessThan(0.2);
  });
});
