/**
 * Private-network guard. An agent can be talked into fetching
 * http://localhost:8080/admin or a cloud metadata address by a web page or a
 * prompt; by default tiny-browse refuses any URL whose host resolves to a
 * loopback, private, link-local or otherwise internal address.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedAddressError extends Error {
  override name = "BlockedAddressError";
}

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s); // unique-local, link-local, multicast
  }
  return true; // not an IP at all: refuse
}

const cache = new Map<string, { at: number; blocked: boolean }>();

/**
 * Throws BlockedAddressError if `url` is not http(s) or its host resolves to a
 * private address. Results are cached for a minute.
 */
export async function assertPublicUrl(url: string, allowPrivate: boolean, allowHosts: readonly string[] = []): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedAddressError(`not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedAddressError(`only http(s) URLs can be read: ${url}`);
  if (allowPrivate) return;
  // Hosts the user explicitly allowed ("intranet.example" or "127.0.0.1:8080").
  if (allowHosts.length && (allowHosts.includes(u.hostname) || allowHosts.includes(u.host))) return;

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw blocked(host);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked(host);
    return;
  }
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 60_000) {
    if (hit.blocked) throw blocked(host);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return; // unresolvable: let the fetch fail with its own error
  }
  const isBlocked = addresses.some((a) => isPrivateAddress(a.address));
  cache.set(host, { at: Date.now(), blocked: isBlocked });
  if (isBlocked) throw blocked(host);
}

function blocked(host: string): BlockedAddressError {
  return new BlockedAddressError(
    `${host} is a local or private network address; tiny-browse does not read those unless fetch.allowPrivateNetwork is true`,
  );
}
