import { version } from '../../package.json'

export const REPO = 'https://github.com/shubhamcodess/tiny-browse'
export const BLOB = `${REPO}/blob/main`
export const VERSION: string = version
export const AUTHOR = 'Shubham Prakash'
export const GITHUB_USER = 'shubhamcodess'
export const LINKEDIN = 'https://www.linkedin.com/in/shubham-prakash-dev/'
export const PACKAGE = '@shubhamcodess/tiny-browse'
export const NPM_URL = `https://www.npmjs.com/package/${PACKAGE}`
export const LATEST_URL = `${REPO}/releases/latest`
export const TARBALL_URL = `${REPO}/releases/latest/download/tiny-browse.tgz`

/** The featured use case: whatcmd looks commands up on the web through tiny-browse. */
export const WHATCMD = {
  repo: 'https://github.com/shubhamcodess/whatcmd',
  site: 'https://shubhamcodess.github.io/whatcmd/',
  npm: 'https://www.npmjs.com/package/@shubhamcodess/whatcmd',
  source: 'https://github.com/shubhamcodess/whatcmd/blob/main/src/browse.ts',
}

export const MCP_CMD = `npx -y ${PACKAGE} mcp`

export const INSTALLERS = [
  { id: 'npm', cmd: `npm install -g ${PACKAGE}`, hint: 'Then run tiny-browse doctor to check your browser.' },
  { id: 'npx', cmd: MCP_CMD, hint: 'No install: this is the command your local agent runs.' },
  { id: 'library', cmd: `npm install ${PACKAGE}`, hint: 'As a dependency of your own Node.js code.' },
  { id: 'pnpm', cmd: `pnpm add -g ${PACKAGE}` },
  { id: 'bun', cmd: `bun add -g ${PACKAGE}`, hint: 'Runs on Node, so Node 22+ must be installed.' },
  { id: 'release', cmd: `npm install -g ${TARBALL_URL}`, hint: 'releases' },
] as const
export type InstallerId = (typeof INSTALLERS)[number]['id']

/** Real numbers from one run: the Node.js backpressure guide, focus "what is backpressure". */
export const MEASURED = {
  url: 'https://nodejs.org/en/learn/modules/backpressuring-in-streams',
  host: 'nodejs.org',
  htmlTokens: 68928,
  mdTokens: 1343,
  budget: 1500,
}

export const fmt = (n: number) => n.toLocaleString('en-US')

/** 1234 → "1.2k" */
export const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`

// The public site URL (set in vite.config.ts; SITE_URL env overrides it for a custom domain).
export const SITE_URL: string = __SITE_URL__
export const TITLE = 'tiny-browse: web search and page reading for local AI agents (MCP server and Node.js library)'

// Derived from CHANGELOG.md and test/ at build time (see vite.config.ts).
export const RELEASE_DATE: string = __BUILD_FACTS__.releaseDate
export const TEST_COUNT: number = __BUILD_FACTS__.tests

// First day on npm; downloads are counted from here (npm caps a range at 18 months).
export const NPM_SINCE = '2026-11-08'
// Below this many stars the count is hidden and the button just says "Star".
export const STAR_MIN = 25
export const showStars = (stars: number | null): stars is number => stars !== null && stars >= STAR_MIN
