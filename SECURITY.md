# Security policy

## Supported versions

Security fixes go into the latest release. tiny-browse is pre-1.0, so please upgrade to the newest 0.x version.

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- GitHub: [report a vulnerability](https://github.com/shubhamcodess/tiny-browse/security/advisories/new) (preferred), or
- email prakashshubham36@gmail.com with "tiny-browse security" in the subject.

Include the version, your OS and browser, steps to reproduce, and what an attacker could do. You will get a reply within 7 days. Once a fix is released, the report is credited in the release notes unless you prefer otherwise.

## What tiny-browse protects against

tiny-browse loads web pages that may be hostile, on behalf of an agent that may be manipulated by those pages. It is designed so that:

- **Local and private networks are unreachable.** URLs that resolve to loopback, private, link-local or cloud-metadata addresses are refused, on every redirect, and for every request a page makes inside Chrome (scripts, stylesheets, iframes, fetch, beacons). WebSockets are disabled in reading tabs. Opt out with `fetch.allowPrivateNetwork` or allow specific hosts with `fetch.allowHosts`.
- **Your sessions aren't used to read pages.** Pages are read in a separate, cookie-less browser context. Only search engines use the tiny-browse Chrome profile, and tiny-browse never uses your everyday Chrome profile.
- **Page content can't pose as instructions.** Hidden text is removed and output is wrapped in "untrusted content" markers. Agents should still treat web content as data.
- **The HTTP server is local.** `tiny-browse serve` listens on 127.0.0.1, rejects requests from web pages (Origin check) and refuses to listen on other addresses without a bearer token.

## Known limitations

These are known and tracked; reports with new impact are still welcome:

- Chrome's DevTools port is reachable by other programs running as your user on the same computer.
- A hostile DNS server could answer differently between the address check and the connection (DNS rebinding).
- Cached pages and queries are stored as ordinary files in your user's cache folder. Turn caching off with `cache.enabled: false`.
- Text made unreadable by styling (tiny or same-colour text) is not yet removed.

## Out of scope

- Search engines or websites blocking or rate-limiting tiny-browse.
- Content of the web pages themselves.
- Running tiny-browse with `fetch.allowPrivateNetwork: true` or a server without a token on a shared network.
