/**
 * Cursors let an agent continue a page that was cut to fit its budget:
 * web_fetch({ cursor }) returns the next sections. They are self-contained
 * (URL + section index), so any tiny-browse process can continue them.
 */
export interface Cursor {
  /** Page URL. */
  u: string;
  /** Index of the first section not yet shown. */
  c: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): Cursor | undefined {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof v.u !== "string" || !/^https?:\/\//.test(v.u) || typeof v.c !== "number" || v.c < 0) return undefined;
    return { u: v.u, c: Math.floor(v.c) };
  } catch {
    return undefined;
  }
}
