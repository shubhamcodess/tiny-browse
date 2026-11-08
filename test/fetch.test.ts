import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPublicUrl, BlockedAddressError, isPrivateAddress } from "../src/fetch/guard.js";
import { TierHints } from "../src/fetch/hints.js";
import { decodeBody, httpGet, userAgent } from "../src/fetch/http.js";

describe("private-network guard", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["2606:4700::1111", false],
  ])("%s private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("refuses local names, private IPs and non-http schemes unless allowed", async () => {
    await expect(assertPublicUrl("http://localhost:3000/", false)).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicUrl("http://127.0.0.1/", false)).rejects.toThrow(/allowPrivateNetwork/);
    await expect(assertPublicUrl("http://[::1]/", false)).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicUrl("http://metadata.internal/", false)).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicUrl("file:///etc/passwd", true)).rejects.toThrow(/only http/);
    await expect(assertPublicUrl("http://127.0.0.1/", true)).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://93.184.215.14/", false)).resolves.toBeUndefined();
  });
});

describe("tier hints", () => {
  it("remembers per site and expires after a week", () => {
    let now = 0;
    const hints = new TierHints(undefined, () => now);
    hints.set("example.com", "browser");
    expect(hints.get("example.com")).toBe("browser");
    now += 8 * 24 * 60 * 60_000;
    expect(hints.get("example.com")).toBeUndefined();
  });
});

describe("decodeBody and user agent", () => {
  it("uses the charset from the header or <meta>", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeBody(latin1, "text/html; charset=iso-8859-1")).toBe("café");
    const meta = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1]);
    expect(decodeBody(meta, "text/html")).toContain("café");
    expect(decodeBody(Buffer.from("naïve"), "")).toBe("naïve");
  });

  it("looks like Chrome and names tiny-browse", () => {
    expect(userAgent("156.0.8078.80")).toMatch(/Chrome\/156\.0\.0\.0 Safari\/537\.36 tiny-browse\/\S+$/);
  });
});

describe("httpGet", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/hop") return res.writeHead(302, { location: "/page" }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/big") return res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(3000));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<p>${req.headers.accept}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => server?.close());
  const opts = { timeoutMs: 5000, maxBytes: 2000, allowPrivate: true };

  it("follows redirects, asks for Markdown first and reports the final URL", async () => {
    const r = await httpGet(`${base}/hop`, opts);
    expect(r.url).toBe(`${base}/page`);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html");
    expect(r.body.toString()).toMatch(/^<p>text\/markdown/);
  });

  it("caps size and redirect loops, and blocks private hosts by default", async () => {
    await expect(httpGet(`${base}/big`, opts)).rejects.toThrow(/larger than/);
    await expect(httpGet(`${base}/loop`, opts)).rejects.toThrow(/too many redirects/);
    await expect(httpGet(`${base}/page`, { ...opts, allowPrivate: false })).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
