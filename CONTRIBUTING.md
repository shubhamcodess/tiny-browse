# Contributing

Thanks for helping improve tiny-browse. Bug reports, fixes and focused features are welcome.

## Before you start

- Search [existing issues](https://github.com/shubhamcodess/tiny-browse/issues) first.
- For anything larger than a small fix, open an issue to agree on the approach before writing code.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development setup

Requirements: Node.js 22 or later, and Google Chrome or Chromium for the browser tests.

```bash
git clone https://github.com/shubhamcodess/tiny-browse.git
cd tiny-browse
npm ci
npm run check
```

| Script | What it does |
|---|---|
| `npm run build` | Builds `dist/cli.js` (the CLI and MCP server) and `dist/index.js` + `dist/index.d.ts` (the library) |
| `npm run typecheck` | TypeScript, no output |
| `npm test` | All tests. Browser tests are skipped if no Chrome is found; lifecycle and package tests need a build first |
| `npm run check` | Typecheck, build and test: run this before opening a pull request |
| `npm run dev` | Rebuild on change |

Try a local build:

```bash
node dist/cli.js doctor
node dist/cli.js search "your query"
node dist/cli.js fetch https://example.com
```

On Ubuntu 24.04, Chrome's sandbox needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

## Project layout

| Path | Contents |
|---|---|
| `src/index.ts`, `src/client.ts` | Public library API |
| `src/cli.ts` | Command line |
| `src/mcp/` | MCP protocol, tool definitions, stdio transport |
| `src/http/` | HTTP server (MCP over HTTP and the JSON API) |
| `src/core/` | Engine, shared tool inputs, reading and budgets |
| `src/search/` | Search engines, result parsing, rate budgets |
| `src/extract/` | Content extraction (in Chrome and without), Markdown, chunking |
| `src/fetch/` | HTTP fetching, private-network guard, images |
| `src/browser/` | Finding, launching and driving Chrome over the DevTools protocol |
| `test/` | Tests and fixtures |
| `docs/DESIGN.md` | Design notes and findings |

## Guidelines

- **No runtime dependencies.** The package ships with none; discuss in an issue before adding one.
- **The library API is a contract.** Changes to exported functions, types, options or error codes need a changelog entry. Removing or renaming anything is a breaking change.
- **Tool inputs are defined once**, in `src/core/inputs.ts`; the MCP tools and the library both use it.
- **Don't evade bot detection.** No CAPTCHA solving, fingerprint spoofing or hiding automation. Pull requests that add these will not be accepted.
- **Keep the safety checks.** Changes that touch fetching must keep the private-network guard and the cookie-less reading context; add tests for both.
- **Test what you change.** Parsing changes need a fixture under `test/fixtures/`. Bugs need a test that fails without the fix.
- **Library code never writes to stdout or stderr.** Use `log` from `src/util/log.ts`.

## Pull requests

1. Branch from `main`.
2. Keep each pull request to one change, with tests.
3. Run `npm run check`.
4. Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything users would notice.
5. Describe what changed and why. CI must pass before merging.

## Releases

Releases are made by maintainers and are automatic on merge to `main`, driven by `version` in `package.json` ([release workflow](.github/workflows/release.yml)):

1. In a pull request, set the new version in `package.json` and move the "Unreleased" changelog entries under it.
2. On merge, if tag `v<version>` doesn't exist, the workflow runs all checks, creates the tag and a GitHub release with the package attached.
3. If that version isn't on npm and the `NPM_TOKEN` secret is set, it publishes the same package with provenance, then installs it from npm to check it.

Merging without a version change releases nothing. If publishing fails, re-run the workflow; the tag and release are not created twice. A manual run from the Actions tab is a dry run.

One-time setup: the repository secret `NPM_TOKEN` (an npm granular access token with read and write access to the package), and Settings → Pages → Source set to "GitHub Actions" for the website.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
