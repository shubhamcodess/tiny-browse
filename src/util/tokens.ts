/**
 * Model-agnostic token counter, no vocabulary file (a few hundred bytes of
 * code instead of megabytes of BPE ranks).
 *
 * Text is first split the way modern BPE tokenizers split it before merging
 * (cl100k/o200k-style pre-tokenization: words with their leading space,
 * numbers in groups of up to three digits, punctuation runs, whitespace), then
 * each piece is costed by what BPE typically makes of it: common short words
 * are one token, longer words a few, CJK about one per character.
 *
 * Calibrated against OpenAI's cl100k (GPT-4) and o200k (GPT-4o) tokenizers on
 * prose, code, Markdown, URLs, numbers and CJK (test/tokens.test.ts), and
 * biased slightly high, so a budget counted with it is rarely exceeded by a
 * real model's tokenizer.
 */

// Same shape as the o200k pre-tokenizer: contractions, words (optionally with
// one leading non-letter like a space), 1-3 digit groups, punctuation runs,
// newlines, other whitespace.
const PIECES = /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
const CJK_ALL = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;
const NON_ASCII = /[^\x00-\x7f]/;

/** Approximate token count for any model. */
export function countTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const m of text.matchAll(PIECES)) n += pieceCost(m[0]);
  return Math.ceil(n * 1.04);
}

function pieceCost(p: string): number {
  // Letters (possibly with one leading space or symbol).
  const letters = p.replace(/^[^\p{L}\p{M}]/u, "");
  if (letters && /^[\p{L}\p{M}]+$/u.test(letters)) {
    // A leading symbol (".com", "/docs", "_name") merges with the word about half the time.
    const lead = letters.length < p.length && p[0] !== " " ? 0.5 : 0;
    const cjk = letters.match(CJK_ALL)?.length ?? 0;
    // CJK: cl100k spends ~0.95 tokens per character, o200k ~0.6; aim between.
    if (cjk) return lead + cjk * 0.78 + Math.ceil((letters.length - cjk) / 4);
    if (NON_ASCII.test(letters)) return lead + Math.max(1, Math.ceil(letters.length / 3)); // accented / non-Latin scripts
    const len = letters.length;
    // Whole English-like words of up to ~8 letters are usually one token;
    // longer ones (compounds, identifiers) split every ~4 letters; camelCase a bit more.
    const humps = (letters.match(/[a-z][A-Z]/g) ?? []).length;
    const base = len <= 8 ? 1 : 1 + Math.ceil((len - 8) / 4);
    return lead + base + humps * 0.3;
  }
  // Digits: groups of up to three are one token each.
  if (/^\p{N}+$/u.test(p)) return 1;
  // Newlines and whitespace: a run is usually one token (indentation included).
  if (/^\s+$/.test(p)) return p.length > 16 ? 2 : 1;
  // Punctuation / symbol runs: common pairs merge ("](", "**", "://", "```").
  const sym = p.trim();
  if (CJK.test(sym)) return sym.length * 0.8;
  return sym.length <= 3 ? 1 : Math.ceil(sym.length / 2.5);
}
