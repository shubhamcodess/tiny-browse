import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'
import readme from '../../README.md?raw'
import configuration from '../../docs/CONFIGURATION.md?raw'
import errors from '../../docs/ERRORS.md?raw'
import library from '../../docs/LIBRARY.md?raw'
import tools from '../../docs/TOOLS.md?raw'
import { Footer, Nav } from './Chrome'
import { BLOB, NPM_URL, PACKAGE, REPO, VERSION } from './data'
import { IconBook, IconCode, IconGithub, IconNpm } from './Icons'

/**
 * The docs page: the repository's own guides, rendered at build time, so it never drifts from
 * what ships on npm. Each guide becomes a part with its own anchor; its "##" sections are the
 * table of contents. Relative links between guides become in-page anchors.
 */

interface Guide {
  file: string
  id: string
  title: string
  group: string
  md: string
  /** README: only these sections */
  only?: string[]
  intro?: string
}

const GUIDES: Guide[] = [
  {
    file: 'README.md',
    id: 'getting-started',
    title: 'Getting started',
    group: 'GET STARTED',
    md: readme,
    only: ['Install', 'Connect to an agent', 'Use as a dependency', 'How it works', 'Limitations', 'Troubleshooting'],
    intro: `tiny-browse is one npm package, **${PACKAGE}**, with two faces: an MCP server that gives your local agent \`web_search\` and \`web_fetch\`, and a Node.js library with the same engine. Version ${VERSION}.`,
  },
  { file: 'docs/LIBRARY.md', id: 'library-api', title: 'Library API', group: 'NPM LIBRARY', md: library },
  { file: 'docs/ERRORS.md', id: 'errors', title: 'Errors and how to handle them', group: 'NPM LIBRARY', md: errors },
  { file: 'docs/TOOLS.md', id: 'mcp-tools', title: 'MCP tools and server', group: 'MCP SERVER', md: tools },
  { file: 'docs/CONFIGURATION.md', id: 'configuration', title: 'Configuration', group: 'REFERENCE', md: configuration },
]

const byFile = Object.fromEntries(GUIDES.map((g) => [g.file, g]))

/** GitHub's heading anchor algorithm on plain text, so the guides' own cross-links keep working. */
function slug(text: string) {
  return text
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

function repoPath(from: string, href: string) {
  const parts = from.split('/').slice(0, -1)
  for (const seg of href.replace(/^\.\//, '').split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** Links to another guide on this page → its anchor; anything else in the repo → GitHub. */
function rewriteLinks(md: string, g: Guide) {
  return md.replace(/\]\((?!https?:|mailto:)([^)\s]+)\)/g, (_m, href: string) => {
    const [path, hash] = href.split('#')
    if (!path) return `](#${g.id}-${hash})`
    const target = repoPath(g.file, path)
    const other = byFile[target]
    if (other) return `](#${hash ? `${other.id}-${hash}` : other.id})`
    return `](${BLOB}/${target}${hash ? `#${hash}` : ''})`
  })
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Light syntax colouring on escaped code: comments, strings, keywords. */
function colour(code: string, lang: string) {
  return code
    .split('\n')
    .map((line) => {
      let l = esc(line)
      const comment = lang === 'bash' || lang === 'sh' ? /(^|\s)(#.*)$/ : lang === 'ts' || lang === 'js' ? /(^|[^:])(\/\/.*)$/ : null
      let tail = ''
      if (comment) {
        const m = l.match(comment)
        if (m && m.index !== undefined) {
          tail = `${m[1]}<span class="c">${m[2]}</span>`
          l = l.slice(0, m.index)
        }
      }
      l = l.replace(/(&quot;|")((?:(?!\1).)*?)\1/g, '<span class="s">"$2"</span>')
      if (lang === 'ts' || lang === 'js')
        l = l.replace(/\b(import|from|const|let|await|async|return|if|else|try|catch|finally|throw|new|for|of|switch|case|default|function|type)\b(?![^<]*<\/span>)/g, '<span class="kw">$1</span>')
      if (lang === 'json') l = l.replace(/<span class="s">("[^"]*")<\/span>(\s*:)/g, '<span class="k">$1</span>$2')
      return l + tail
    })
    .join('\n')
}

interface Part {
  guide: Guide
  html: string
  sections: { id: string; title: string }[]
}

function buildParts(): Part[] {
  return GUIDES.map((g) => {
    let body = g.md.replace(/^# .*\n/, '') // the part title replaces the guide's own h1
    if (g.only) {
      const chunks = body.split(/\n(?=## )/)
      body = chunks.filter((c) => g.only!.some((t) => c.startsWith(`## ${t}\n`))).join('\n')
    }
    if (g.intro) body = `${g.intro}\n\n${body}`
    body = rewriteLinks(body, g)
    const sections: Part['sections'] = []
    const renderer = new marked.Renderer()
    renderer.heading = ({ tokens, depth, text }) => {
      const id = `${g.id}-${slug(text)}`
      // guides start at "##": render one level down, under the part's h2
      const level = Math.min(6, depth + 1)
      if (depth === 2) sections.push({ id, title: text.replace(/`/g, '') })
      return `<h${level} id="${id}">${marked.Parser.parseInline(tokens)}</h${level}>`
    }
    renderer.code = ({ text, lang }) => {
      const l = (lang ?? 'text').split(/\s/)[0]
      return `<pre><code class="language-${l}">${colour(text, l)}</code></pre>`
    }
    const html = marked.parse(body, { renderer, async: false }) as string
    return { guide: g, html, sections }
  })
}

export default function Docs() {
  const parts = useMemo(buildParts, [])
  const [on, setOn] = useState(parts[0]?.guide.id)
  const groups = [...new Set(GUIDES.map((g) => g.group))]

  useEffect(() => {
    // scroll-spy: the active entry is the last heading above the nav line
    const heads = [...document.querySelectorAll<HTMLElement>('.md h2, .md h3')]
    const update = () => {
      let current = heads[0]?.id
      for (const h of heads) {
        if (h.getBoundingClientRect().top - 120 <= 0) current = h.id
        else break
      }
      setOn(current)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])

  useEffect(() => {
    // honour a deep link once layout and fonts settle
    if (!location.hash) return
    const go = () => {
      document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior: 'instant', block: 'start' })
      window.dispatchEvent(new Event('scroll'))
    }
    requestAnimationFrame(go)
    document.fonts?.ready.then(go)
    window.addEventListener('load', go, { once: true })
    return () => window.removeEventListener('load', go)
  }, [])

  return (
    <>
      <Nav page="docs" />
      <div className="frame">
        <div className="docs">
          <aside className="toc" aria-label="Documentation contents">
            {groups.map((grp) => (
              <div key={grp}>
                <p>{grp}</p>
                {parts
                  .filter((p) => p.guide.group === grp)
                  .map((p) => (
                    <div key={p.guide.id} className="toc__part">
                      <a href={`#${p.guide.id}`} className={`toc__title${on === p.guide.id ? ' on' : ''}`}>
                        {p.guide.title}
                      </a>
                      {p.sections.map((s) => (
                        <a key={s.id} href={`#${s.id}`} className={on === s.id ? 'on' : undefined}>
                          {s.title}
                        </a>
                      ))}
                    </div>
                  ))}
              </div>
            ))}
          </aside>
          <main className="doc">
            <header className="doc__top">
              <h1>Documentation</h1>
              <p className="sub">
                Install it, connect your local agent, call it from Node.js, handle every error. Rendered from the guides in the
                repository, so it matches the package on npm.
              </p>
              <div className="doc__install">
                <code>
                  <span className="p">$ </span>npm install {PACKAGE}
                </code>
              </div>
              <div className="doc__meta">
                <a href={NPM_URL}>
                  <IconNpm />
                  {PACKAGE}
                </a>
                <a href={`${REPO}/tree/main/docs`}>
                  <IconGithub />
                  docs/
                </a>
                <a href={`${BLOB}/CHANGELOG.md`}>
                  <IconBook />
                  CHANGELOG.md
                </a>
                <a href={`${REPO}/tree/main/src`}>
                  <IconCode />
                  src/
                </a>
              </div>
            </header>
            <article className="md">
              {parts.map((p) => (
                <section key={p.guide.id} aria-labelledby={p.guide.id}>
                  <h2 id={p.guide.id}>{p.guide.title}</h2>
                  <div className="src">
                    <a href={`${BLOB}/${p.guide.file}`}>{p.guide.file}</a>
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: p.html }} />
                </section>
              ))}
            </article>
          </main>
        </div>
        <Footer />
      </div>
    </>
  )
}
