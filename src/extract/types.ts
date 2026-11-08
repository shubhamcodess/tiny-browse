/**
 * The page as a tree of blocks: what the in-page extractor returns and the
 * Markdown renderer consumes.
 *
 * Inline text is plain text with sentinel markers, so link and image style can
 * be chosen after extraction:
 *   link:  \u0001<n>\u0002<text>\u0003   (n = index into `links`)
 *   image: \u0004<n>\u0005               (n = index into `images`)
 * Emphasis and inline code are already Markdown (**b**, *i*, `c`).
 */

export const LINK_OPEN = "\u0001";
export const LINK_MID = "\u0002";
export const LINK_CLOSE = "\u0003";
export const IMG_OPEN = "\u0004";
export const IMG_CLOSE = "\u0005";

export type Block =
  /** level: 1-6 for real headings; 0 for headings detected by appearance (resolved later). */
  | { t: "h"; level: number; size: number; text: string }
  | { t: "p"; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "code"; lang: string; text: string }
  | { t: "table"; rows: string[][]; header: boolean; complex: boolean }
  | { t: "quote"; blocks: Block[] }
  | { t: "img"; ref: number }
  | { t: "math"; tex: string }
  | { t: "hr" };

export interface PageImage {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
}

export interface PageMeta {
  url: string;
  canonical: string;
  title: string;
  siteName: string;
  description: string;
  published: string;
  author: string;
  lang: string;
}

export interface PageStats {
  /** Characters of text in the chosen content. */
  textChars: number;
  /** Characters of that text inside links. */
  linkChars: number;
  paragraphs: number;
  headings: number;
  /** Characters of visible text in the whole page body. */
  bodyChars: number;
  /** How the main content was chosen. */
  root: string;
  /** Boilerplate phrases found in the content (cookie walls, "enable JavaScript"...). */
  boilerplateHits: number;
}

export interface Extracted {
  meta: PageMeta;
  blocks: Block[];
  links: string[];
  images: PageImage[];
  stats: PageStats;
}
