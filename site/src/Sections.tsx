import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CopyButton, StarButton } from './Chrome'
import { Code, type CodeTab } from './Code'
import {
  AUTHOR,
  BLOB,
  GITHUB_USER,
  INSTALLERS,
  LINKEDIN,
  MCP_CMD,
  NPM_URL,
  PACKAGE,
  RELEASE_DATE,
  REPO,
  TARBALL_URL,
  TEST_COUNT,
  VERSION,
  WHATCMD,
  compact,
  fmt,
  showStars,
} from './data'
import { FAQ } from './faq'
import { usePrefersReducedMotion, useStats } from './hooks'
import {
  IconArrow,
  IconBook,
  IconBug,
  IconChat,
  IconCode,
  IconGithub,
  IconInfo,
  IconLinkedin,
  IconPlus,
  IconSearch,
  IconSpark,
  IconTerminal,
} from './Icons'
import { AGENT_MARKS } from './logos'
import { Term, type TermTab } from './Term'

const BASE = import.meta.env.BASE_URL
const DOCS = `${BASE}docs/`

function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

/* ---------- Agent logos ---------- */
export function Logos() {
  const row = (hidden: boolean) =>
    AGENT_MARKS.map((a) => (
      <span className="logo" key={a.name + String(hidden)} aria-hidden={hidden || undefined}>
        {a.path && (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={a.path} />
          </svg>
        )}
        {a.name}
      </span>
    ))
  return (
    <section className="logos" aria-label="Works with">
      <p className="cap logos__cap">Works with every MCP client, and with plain Node.js</p>
      <div className="marquee">
        <div className="marquee__track">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </section>
  )
}

/* ---------- How it works ---------- */
const STEPS = [
  {
    n: '01',
    title: 'Search',
    body: 'Google loads in your Chrome. The results page is read three independent ways and merged by vote. DuckDuckGo and Bing take over when Google refuses.',
    viz: ['google.com/search?q=…', '✓ layout  ✓ a11y  ✓ selectors', '→ 5 results, merged by vote'],
  },
  {
    n: '02',
    title: 'Read',
    body: 'Each page is fetched over plain HTTP and rendered with scripts off. Pages that need JavaScript get a full Chrome load. The faster way is remembered per site.',
    viz: ['GET nodejs.org/en/learn/…', 'render: http   24 ms', 'render: browser (only if needed)'],
  },
  {
    n: '03',
    title: 'Extract',
    body: 'The main content is found from how the page is laid out, not from class names. Menus, ads, cookie banners and hidden text are dropped.',
    viz: ['– navigation', '– cookie banner', '+ headings, code, tables, lists'],
  },
  {
    n: '04',
    title: 'Fit',
    body: 'The page is split into sections by heading and packed into max_tokens, keeping the sections most relevant to the query. A cursor reads the rest.',
    viz: ['68,928 tokens of HTML', '→ 1,343 tokens of Markdown', 'cursor: continue later'],
  },
]

export function HowItWorks() {
  const [ref, play] = useInView<HTMLOListElement>(0.2)
  return (
    <section className="sec" id="how" aria-labelledby="how-title">
      <div className="sec__head reveal">
        <h2 id="how-title">One tool call from your local agent. Four steps. Only the answer comes back.</h2>
        <p className="sub">Everything runs on your machine, in a Chrome profile of its own, without your cookies.</p>
      </div>
      <ol className="flow reveal" ref={ref} data-play={play} style={{ ['--d' as string]: 1 }}>
        {STEPS.map((s, i) => (
          <li key={s.n} className="flow__step" style={{ ['--i' as string]: i }}>
            <div className="flow__viz" aria-hidden="true">
              {s.viz.map((v) => (
                <p key={v} className={v.startsWith('–') ? 'cut' : v.startsWith('+') || v.startsWith('→') || v.startsWith('✓') ? 'ok' : undefined}>
                  {v}
                </p>
              ))}
            </div>
            <span className="n">{s.n}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/* ---------- Features bento ---------- */
function Tile({ wide, viz, title, children, d }: { wide?: boolean; viz: ReactNode; title: string; children: ReactNode; d: number }) {
  const [ref, play] = useInView<HTMLElement>(0.35)
  return (
    <article ref={ref} className={`tile reveal${wide ? ' tile--wide' : ''}`} data-play={play} style={{ ['--d' as string]: d }}>
      <div className="tile__viz">{viz}</div>
      <div className="tile__txt">
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </article>
  )
}

const Mono = ({ lines }: { lines: [string, string?][] }) => (
  <div className="fv">
    {lines.map(([t, k], i) => (
      <p key={i} className={k} style={{ ['--i' as string]: i }}>
        {t}
      </p>
    ))}
  </div>
)

export function Features() {
  return (
    <section className="sec" id="features" aria-labelledby="features-title">
      <div className="sec__head reveal">
        <h2 id="features-title">Small on disk. Careful on the web. Exact about tokens.</h2>
      </div>
      <div className="bento">
        <Tile
          wide
          d={0}
          title="126 kB, zero dependencies"
          viz={
            <Mono
              lines={[
                ['$ npm pack --dry-run', 'prompt'],
                [`name: ${PACKAGE}`],
                ['package size: 126.6 kB', 'ok'],
                ['total files: 7'],
                ['"dependencies": {}', 'ok'],
                ['no bundled browser · no API keys · no LLM inside', 'dim'],
              ]}
            />
          }
        >
          One package, nothing else installed. It drives the Chrome, Edge, Brave or Chromium already on your computer
          instead of downloading a browser of its own.
        </Tile>
        <Tile
          d={1}
          title="Your browser, found for you"
          viz={
            <Mono
              lines={[
                ['$ tiny-browse doctor', 'prompt'],
                ['[ok] node >= 22', 'ok'],
                ['[ok] browser - Google Chrome', 'ok'],
                ['     also found: Microsoft Edge', 'dim'],
                ['[ok] chrome session - 809 ms', 'ok'],
              ]}
            />
          }
        >
          Detects your browser, starts it headless in a profile of its own and stops it when you are done.
        </Tile>
        <Tile
          d={0}
          title="A hard token budget"
          viz={
            <div className="fv fv--budget">
              <p className="prompt">max_tokens: 1500</p>
              <div className="budget">
                <i />
                <s />
              </div>
              <p className="ok">1,343 tokens · truncated: true</p>
              <p className="dim">cursor: "eyJ1cmwiOi…"  → read the rest</p>
            </div>
          }
        >
          <code>max_tokens</code> is a limit, not a hint. <code>focus</code> keeps the relevant sections; <code>cursor</code>{' '}
          continues a long page.
        </Tile>
        <Tile
          wide
          d={1}
          title="Survives search page redesigns"
          viz={
            <div className="fv fv--vote">
              <div>
                <span className="ok">✓ layout</span>
                <span className="ok">✓ accessibility tree</span>
                <span className="ok">✓ selectors</span>
              </div>
              <p className="ok">→ merged by vote: 5 results</p>
              <p className="dim">google → duckduckgo → bing, when an engine refuses or runs out of budget</p>
            </div>
          }
        >
          Results are parsed three independent ways and merged by vote, so one changed class name rarely breaks
          search. Fallback engines take over automatically.
        </Tile>
        <Tile
          d={0}
          title="Careful by default"
          viz={
            <Mono
              lines={[
                ['google  3/min · 20/h · 100/day', 'dim'],
                ['CAPTCHA → pause 15 min, 1 h, 4 h', 'dim'],
                ['GET http://192.168.1.1', 'prompt'],
                ['× private_address: refused', 'cut'],
                ['cookies: none · profile: its own', 'ok'],
              ]}
            />
          }
        >
          Strict search budgets shared by every process, no private-network access, pages read without your cookies.
          Bot checks are reported, never bypassed.
        </Tile>
        <Tile
          wide
          d={1}
          title="Web text is labelled as web text"
          viz={
            <Mono
              lines={[
                ['<!-- begin untrusted content from nodejs.org -->', 'cut'],
                ['# Backpressuring in Streams'],
                ['> https://nodejs.org/learn/modules/backpressuring-in-streams', 'dim'],
                ['There is a general problem that occurs during data handling…'],
                ['<!-- end untrusted content -->', 'cut'],
              ]}
            />
          }
        >
          Every page arrives wrapped in markers with its URL, so your local agent can tell content from instructions and cite
          its source. Structured results ride along for MCP clients that support them.
        </Tile>
      </div>
    </section>
  )
}

/* ---------- Use cases ---------- */
const CASES = [
  {
    icon: IconSearch,
    title: 'Web search for local agents',
    body: 'A local agent on a local model has no web access. Add tiny-browse as an MCP server and it can search and read pages: no API keys, no cloud service.',
    code: 'claude mcp add tiny-browse -- npx -y @shubhamcodess/tiny-browse mcp',
  },
  {
    icon: IconBook,
    title: 'Answers grounded in sources',
    body: 'Every page comes back with its URL and only its relevant sections, so an assistant answers from current pages and cites them instead of guessing.',
    code: 'web_search { "query": "…", "read": 3 }',
  },
  {
    icon: IconCode,
    title: 'Current docs for local coding agents',
    body: 'Libraries change after a model’s training cutoff. web_fetch with focus pulls just the part of the docs your local agent needs, code blocks intact.',
    code: 'web_fetch { "urls": [docs], "focus": "goroutines" }',
  },
  {
    icon: IconTerminal,
    title: 'Web lookup inside your own tool',
    body: 'Import it like any npm package. Each call starts what it needs and shuts it down, so a CLI exits straight away. whatcmd does exactly this.',
    code: "import { webFetch } from '@shubhamcodess/tiny-browse'",
  },
]

export function UseCases() {
  return (
    <section className="sec" id="use-cases" aria-labelledby="cases-title">
      <div className="sec__head reveal">
        <h2 id="cases-title">For local agents that need the web, and code that needs it too</h2>
        <p className="sub">The same engine behind two doors: MCP tools for your local agent, functions for your Node.js code.</p>
      </div>
      <div className="cases">
        {CASES.map((c, i) => (
          <article className="card case reveal" key={c.title} style={{ ['--d' as string]: i }}>
            <c.icon />
            <h3>{c.title}</h3>
            <p>{c.body}</p>
            <code>{c.code}</code>
          </article>
        ))}
      </div>
    </section>
  )
}

/* ---------- Featured use case: whatcmd ---------- */
const WHATCMD_TABS: TermTab[] = [
  {
    id: 'web',
    label: 'with web lookup',
    foot: 'real output · from the whatcmd README',
    lines: [
      { k: 'com', t: '# kubectl --help lists subcommands, not their flags: the local model has to guess' },
      { k: 'cmd', t: 'whatcmd --no-web kubectl show rollout history of deployment web' },
      { k: 'cut', t: 'whatcmd: not a shell task, nothing generated' },
      { k: 'gap' },
      { k: 'com', t: '# same request, looked up through tiny-browse after the local answer failed' },
      { k: 'cmd', t: 'whatcmd --web kubectl show rollout history of deployment web' },
      { k: 'hi', t: 'kubectl rollout history deployment/web' },
      { k: 'ok', t: 'used web docs from kubernetes.io' },
    ],
  },
  {
    id: 'config',
    label: 'stay local',
    foot: 'from the whatcmd README',
    lines: [
      { k: 'com', t: '# stay fully local (or per request: --no-web, or WHATCMD_WEB=0)' },
      { k: 'cmd', t: 'whatcmd config set web false' },
      { k: 'com', t: '# browser found? search engines rate-limited right now?' },
      { k: 'cmd', t: 'whatcmd doctor' },
    ],
  },
]

const WHATCMD_CODE = `import { webFetch, webSearch } from "@shubhamcodess/tiny-browse";

// 1. A known reference page: plain HTTP, no Chrome, no search budget
const r = await webFetch(
  { urls: ["https://kubernetes.io/docs/reference/kubectl/quick-reference/"], max_tokens: 30000 },
  { mode: "http", timeoutMs: 15_000 },
);

// 2. Otherwise one search, reading the top 2 results, sharing a warm Chrome if one runs
const s = await webSearch(
  { query: "kubectl rollout history command", read: 2, max_tokens: 3000 },
  { timeoutMs: 15_000, useServer: "auto" },
);
// a "blocked" error is never retried: whatcmd pauses its searches for 15 minutes`

export function Featured() {
  return (
    <section className="sec" id="whatcmd" aria-labelledby="whatcmd-title">
      <div className="split">
        <div className="reveal">
          <p className="cap feat__tag">Featured use case</p>
          <div className="sec__head" style={{ marginBottom: 0 }}>
            <h2 id="whatcmd-title">whatcmd: plain English to shell commands, with the web as backup</h2>
            <p className="sub">
              whatcmd runs on a local model. Only when its answer fails does it look the command up, through
              tiny-browse used as a library.
            </p>
          </div>
          <ul className="notes">
            <li>
              <IconInfo />
              <span>
                <b>Reference pages first.</b> For kubectl, helm, gcloud and seven more, a fixed docs page is read over
                plain HTTP with <code>mode: "http"</code>.
              </span>
            </li>
            <li>
              <IconInfo />
              <span>
                <b>One search at most.</b> Otherwise <code>webSearch</code> reads the top 2 results.{' '}
                <code>blocked</code> is never retried.
              </span>
            </li>
            <li>
              <IconInfo />
              <span>
                <b>Measured:</b> 22 / 40 cloud-CLI cases correct with web off, 25 / 40 with it on.
              </span>
            </li>
          </ul>
          <div className="feat__btns">
            <a className="btn btn--line" href={WHATCMD.site}>
              <IconArrow />
              whatcmd website
            </a>
            <a className="btn btn--line" href={WHATCMD.source}>
              <IconGithub />
              src/browse.ts
            </a>
          </div>
        </div>
        <div className="reveal feat__stack" style={{ ['--d' as string]: 1 }}>
          <Term tabs={WHATCMD_TABS} />
          <Code tabs={[{ id: 'browse', label: 'how whatcmd calls it', lang: 'ts', code: WHATCMD_CODE }]} foot="abridged from whatcmd/src/browse.ts" />
        </div>
      </div>
    </section>
  )
}

/* ---------- Install and connect ---------- */
const INSTALL_TABS: TermTab[] = [
  {
    id: 'install',
    label: 'install',
    lines: [
      { k: 'cmd', t: INSTALLERS[0].cmd },
      { k: 'cmd', t: 'tiny-browse doctor' },
      { k: 'out', t: `tiny-browse ${VERSION}` },
      { k: 'out', t: 'node v22.16.0 on darwin-arm64' },
      { k: 'out', t: 'search order: google -> duckduckgo -> bing' },
      { k: 'ok', t: '[ok] node >= 22 - v22.16.0' },
      { k: 'ok', t: '[ok] browser - Google Chrome (/Applications/Google Chrome.app/…)' },
      { k: 'ok', t: '[ok] chrome session - started Chrome/157.0.8103.78 in 809 ms, page load 33 ms' },
      { k: 'out', t: '[-] search: google - used 0/3 per min, 0/20 per hour, 0/100 per day' },
    ],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    foot: 'or tiny-browse config claude-code',
    lines: [
      { k: 'cmd', t: `claude mcp add tiny-browse -- ${MCP_CMD}` },
      { k: 'com', t: '# your local agent now has two tools: web_search and web_fetch' },
    ],
  },
  {
    id: 'vscode',
    label: 'VS Code',
    foot: '.vscode/mcp.json',
    lines: [
      { k: 'cmd', t: 'tiny-browse config vscode' },
      { k: 'out', t: '{' },
      { k: 'out', t: '  "servers": {' },
      { k: 'out', t: `    "tiny-browse": { "type": "stdio", "command": "npx", "args": ["-y", "${PACKAGE}", "mcp"] }` },
      { k: 'out', t: '  }' },
      { k: 'out', t: '}' },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor & others',
    foot: 'Cursor, Claude Desktop, Windsurf and most clients',
    lines: [
      { k: 'cmd', t: 'tiny-browse config cursor' },
      { k: 'out', t: '{' },
      { k: 'out', t: '  "mcpServers": {' },
      { k: 'out', t: `    "tiny-browse": { "command": "npx", "args": ["-y", "${PACKAGE}", "mcp"] }` },
      { k: 'out', t: '  }' },
      { k: 'out', t: '}' },
    ],
  },
  {
    id: 'http',
    label: 'shared server',
    foot: 'output abridged · one warm Chrome for every local agent',
    lines: [
      { k: 'cmd', t: 'tiny-browse serve --http 7777' },
      { k: 'com', t: '# MCP at http://127.0.0.1:7777/mcp · JSON at /search and /fetch' },
      { k: 'cmd', t: `curl -s localhost:7777/fetch -H 'content-type: application/json' -d '{"urls":["https://go.dev/doc/effective_go"],"focus":"goroutines"}'` },
      { k: 'out', t: '{ "markdown": "# Effective Go …", "data": { … }, "images": [] }' },
    ],
  },
  {
    id: 'source',
    label: 'from source',
    lines: [
      { k: 'cmd', t: `git clone ${REPO}.git && cd tiny-browse` },
      { k: 'cmd', t: 'npm ci && npm run build' },
      { k: 'cmd', t: 'node dist/cli.js --version' },
      { k: 'out', t: VERSION },
      { k: 'gap' },
      { k: 'com', t: '# or the release tarball' },
      { k: 'cmd', t: `npm install -g ${TARBALL_URL}` },
    ],
  },
]

export function Install() {
  return (
    <section className="sec" id="install" aria-labelledby="install-title">
      <div className="split">
        <div className="reveal">
          <div className="sec__head" style={{ marginBottom: 0 }}>
            <h2 id="install-title">Set it up in a minute</h2>
            <p className="sub">Install, check your browser, add one line to your local agent.</p>
          </div>
          <ol className="setup">
            <li>
              <b>Install</b> with <code>npm install -g {PACKAGE}</code>, or skip it: your local agent can run it with{' '}
              <code>npx</code>.
            </li>
            <li>
              <b>Check</b> with <code>tiny-browse doctor</code>. It finds your browser and starts it once.
            </li>
            <li>
              <b>Connect</b> your local agent. <code>tiny-browse config &lt;client&gt;</code> prints the exact snippet.
            </li>
            <li>
              <b>Ask</b> something current. Your local agent gets <code>web_search</code> and <code>web_fetch</code>.
            </li>
          </ol>
          <ul className="notes">
            <li>
              <IconInfo />
              <span>
                <b>Requires Node.js 22+</b> and Chrome, Chromium, Edge or Brave. No browser? Use{' '}
                <code>--no-chrome</code>.
              </span>
            </li>
            <li>
              <IconInfo />
              <span>
                <b>Tested on macOS and Linux.</b> Windows is untested.
              </span>
            </li>
          </ul>
          <a className="btn btn--line" href={`${DOCS}#getting-started-install`} style={{ marginTop: 28 }}>
            <IconBook />
            Setup guide
          </a>
        </div>
        <div className="reveal" style={{ ['--d' as string]: 1 }}>
          <Term tabs={INSTALL_TABS} />
        </div>
      </div>
    </section>
  )
}

/* ---------- Library ---------- */
const LIB_TABS: CodeTab[] = [
  {
    id: 'search',
    label: 'search',
    lang: 'ts',
    code: `import { webSearch } from "@shubhamcodess/tiny-browse";

const { results, pages, markdown } = await webSearch({
  query: "node.js stream backpressure",
  read: 2,          // open and read the top 2 results
  max_tokens: 4000, // hard limit on the whole answer
});

for (const r of results) console.log(r.rank, r.title, r.url);`,
  },
  {
    id: 'fetch',
    label: 'fetch',
    lang: 'ts',
    code: `import { webFetch } from "@shubhamcodess/tiny-browse";

const { pages } = await webFetch({
  urls: ["https://go.dev/doc/effective_go"],
  focus: "goroutines", // only the relevant sections
  max_tokens: 2000,
});

console.log(pages[0].markdown);
// cut short? continue where it stopped
if (pages[0].cursor) await webFetch({ cursor: pages[0].cursor });`,
  },
  {
    id: 'client',
    label: 'client',
    lang: 'ts',
    code: `import { createClient } from "@shubhamcodess/tiny-browse";

// one Chrome for many calls
const client = await createClient({ timeoutMs: 15_000 });
try {
  const a = await client.webSearch({ query: "vite 7 release notes" });
  const b = await client.webFetch(
    { urls: ["https://vitejs.dev/blog/"] },
    { signal: AbortSignal.timeout(5000) },
  );
} finally {
  await client.close(); // nothing is left running
}`,
  },
  {
    id: 'errors',
    label: 'errors',
    lang: 'ts',
    code: `import { webSearch, TinyBrowseError } from "@shubhamcodess/tiny-browse";

try {
  await webSearch({ query: "..." });
} catch (err) {
  if (!(err instanceof TinyBrowseError)) throw err;
  switch (err.code) {
    case "blocked":          // every engine refused: try later, never loop
    case "chrome_not_found": // retry with { mode: "http" }
    case "timeout":
    case "network":          // safe to retry once, with backoff
    default: throw err;
  }
}`,
  },
]

export function Library() {
  return (
    <section className="sec" id="library" aria-labelledby="library-title">
      <div className="split split--flip">
        <div className="reveal">
          <div className="sec__head" style={{ marginBottom: 0 }}>
            <h2 id="library-title">Also an npm library</h2>
            <p className="sub">Typed, ESM, side-effect free. Four functions and one error type.</p>
          </div>
          <dl className="api">
            <div>
              <dt>webSearch(input, options?)</dt>
              <dd>Search and read the top results</dd>
            </div>
            <div>
              <dt>webFetch(input, options?)</dt>
              <dd>Read pages by URL, with focus and cursor</dd>
            </div>
            <div>
              <dt>createClient(options?)</dt>
              <dd>Reuse one Chrome across calls</dd>
            </div>
            <div>
              <dt>doctor(options?)</dt>
              <dd>Check Node, the browser and search budgets</dd>
            </div>
            <div>
              <dt>TinyBrowseError.code</dt>
              <dd>Seven stable codes to switch on</dd>
            </div>
          </dl>
          <div className="feat__btns">
            <a className="btn btn--line" href={`${DOCS}#library-api`}>
              <IconBook />
              Library docs
            </a>
            <a className="btn btn--line" href={`${DOCS}#errors`}>
              <IconCode />
              Error handling
            </a>
          </div>
        </div>
        <div className="reveal" style={{ ['--d' as string]: 1 }}>
          <Code tabs={LIB_TABS} foot={`npm install ${PACKAGE}`} />
        </div>
      </div>
    </section>
  )
}

/* ---------- FAQ ---------- */
export function Faq() {
  return (
    <section className="sec" id="faq" aria-labelledby="faq-title">
      <div className="sec__head reveal">
        <h2 id="faq-title">Questions</h2>
        <p className="sub">
          Something missing? <a className="link" href={`${REPO}/issues/new/choose`}>Open an issue</a>.
        </p>
      </div>
      <div className="faq reveal" style={{ ['--d' as string]: 1 }}>
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>
              {f.q}
              <IconPlus />
            </summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

/* ---------- Maker + contribute ---------- */
function TiltCard({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = usePrefersReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el || reduced || !window.matchMedia('(hover: hover)').matches) return
    let raf = 0
    const cur = { x: 0, y: 0 }
    const tgt = { x: 0, y: 0 }
    const tick = () => {
      cur.x += (tgt.x - cur.x) * 0.12
      cur.y += (tgt.y - cur.y) * 0.12
      el.style.transform = `perspective(900px) rotateX(${cur.y * -7}deg) rotateY(${cur.x * 9}deg)`
      if (Math.abs(tgt.x - cur.x) > 0.001 || Math.abs(tgt.y - cur.y) > 0.001) raf = requestAnimationFrame(tick)
      else raf = 0
    }
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width
      const py = (e.clientY - r.top) / r.height
      tgt.x = px - 0.5
      tgt.y = py - 0.5
      el.style.setProperty('--gx', `${px * 100}%`)
      el.style.setProperty('--gy', `${py * 100}%`)
      kick()
    }
    const leave = () => {
      tgt.x = 0
      tgt.y = 0
      kick()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
    }
  }, [reduced])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

const CONTRIB = [
  {
    icon: IconBug,
    title: 'Report a bug',
    body: 'Something broke? The template asks for tiny-browse doctor output and your OS.',
    href: `${REPO}/issues/new?template=bug_report.yml`,
    go: 'bug_report.yml',
  },
  {
    icon: IconSpark,
    title: 'Request a feature',
    body: 'PDF support, an engine, a client. Describe the problem first.',
    href: `${REPO}/issues/new?template=feature_request.yml`,
    go: 'feature_request.yml',
  },
  {
    icon: IconCode,
    title: 'Contribute code',
    body: 'Small, tested pull requests are welcome. Start with the contributing guide.',
    href: `${BLOB}/CONTRIBUTING.md`,
    go: 'CONTRIBUTING.md',
  },
  {
    icon: IconChat,
    title: 'Report a security issue',
    body: 'Privately, please. The policy explains how, and the threat model.',
    href: `${BLOB}/SECURITY.md`,
    go: 'SECURITY.md',
  },
]

export function Maker() {
  const { downloads, stars } = useStats()
  const starsOn = showStars(stars)
  return (
    <section className="sec" id="contribute" aria-labelledby="maker-title">
      <div className="sec__head reveal">
        <h2 id="maker-title">Built in the open</h2>
        <p className="sub">One maintainer, MIT licence, issues read by a human.</p>
      </div>
      <div className="maker">
        <TiltCard className="dev reveal">
          <div className="dev__id">
            <img src={`${BASE}maker-figure.jpg`} alt={AUTHOR} width="148" height="222" loading="lazy" />
            <div>
              <h3>{AUTHOR}</h3>
              <p className="dev__role">Full Stack Developer · AI</p>
              <p className="dev__made">maker of tiny-browse and whatcmd</p>
              <p className="dev__quote">Built so a local agent can read the web without a cloud API or a 300 MB browser download.</p>
            </div>
          </div>
          <dl className="dev__facts">
            <div>
              <dt>latest release</dt>
              <dd>
                <a href={`${REPO}/releases/latest`}>v{VERSION}</a>
                {RELEASE_DATE && ` · ${RELEASE_DATE}`}
              </dd>
            </div>
            <div>
              <dt>adoption</dt>
              <dd>
                <a href={NPM_URL}>{downloads === null ? '—' : fmt(downloads)} npm downloads</a>
                {starsOn && (
                  <>
                    {' · '}
                    <a href={REPO}>{compact(stars)} stars</a>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>tested</dt>
              <dd>{TEST_COUNT} tests · macOS and Linux CI</dd>
            </div>
            <div>
              <dt>stack</dt>
              <dd>TypeScript · Node 22+ · MCP · Chrome DevTools Protocol</dd>
            </div>
            <div>
              <dt>license</dt>
              <dd>MIT, zero runtime dependencies</dd>
            </div>
          </dl>
          <div className="dev__links">
            <a className="btn btn--line btn--social" href={`https://github.com/${GITHUB_USER}`}>
              <IconGithub />@{GITHUB_USER}
            </a>
            {LINKEDIN && (
              <a className="btn btn--line btn--social btn--linkedin" href={LINKEDIN}>
                <IconLinkedin />
                LinkedIn
              </a>
            )}
          </div>
        </TiltCard>
        <div className="contrib">
          {CONTRIB.map((c, i) => (
            <a className="card reveal" key={c.title} href={c.href} style={{ ['--d' as string]: i }}>
              <c.icon />
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <span className="go">
                {c.go}
                <IconArrow />
              </span>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ---------- Final call to action ---------- */
export function GetStarted() {
  return (
    <section className="sec cta" id="get-started" aria-labelledby="cta-title">
      <div className="cta__inner reveal">
        <h2 id="cta-title">Your local agent can read the web now.</h2>
        <p className="sub">One line in its MCP config. No API keys, no browser download.</p>
        <div className="cta__cmd">
          <code>
            <span className="p">$ </span>
            {MCP_CMD}
          </code>
          <CopyButton text={MCP_CMD} />
        </div>
        <div className="cta__btns">
          <StarButton className="btn btn--solid" label="Star on GitHub" />
          <a className="btn btn--line" href={DOCS}>
            <IconBook />
            Read the docs
          </a>
        </div>
      </div>
    </section>
  )
}
