import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CopyButton } from './Chrome'

export interface CodeTab {
  id: string
  label: string
  lang: 'ts' | 'json' | 'bash'
  code: string
}

const KEYWORDS = /\b(import|from|const|let|await|async|for|of|if|else|try|catch|finally|throw|switch|case|default|return|new|instanceof|export|function)\b/g

/** A tiny highlighter for TypeScript snippets: comments, strings, keywords, numbers. */
export function highlightTs(code: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(\d[\d_]*)\b/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  const plain = (text: string) => {
    let i = 0
    let k: RegExpExecArray | null
    KEYWORDS.lastIndex = 0
    while ((k = KEYWORDS.exec(text))) {
      if (k.index > i) out.push(text.slice(i, k.index))
      out.push(
        <span key={`k${key++}`} className="kw">
          {k[0]}
        </span>,
      )
      i = k.index + k[0].length
    }
    if (i < text.length) out.push(text.slice(i))
  }
  while ((m = re.exec(code))) {
    if (m.index > last) plain(code.slice(last, m.index))
    const cls = m[1] ? 'c' : m[2] ? 's' : 'n'
    out.push(
      <span key={`t${key++}`} className={cls}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < code.length) plain(code.slice(last))
  return out
}

/** An editor-style code window with tabs and a copy button. */
export function Code({ tabs, foot }: { tabs: CodeTab[]; foot?: string }) {
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const tab = tabs[active]

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    let n: number
    if (e.key === 'ArrowRight') n = (active + 1) % tabs.length
    else if (e.key === 'ArrowLeft') n = (active - 1 + tabs.length) % tabs.length
    else return
    e.preventDefault()
    setActive(n)
    root.current?.querySelector<HTMLButtonElement>(`[data-tab="${n}"]`)?.focus()
  }

  return (
    <div className="term codewin" ref={root}>
      <div className="term__bar">
        <span className="app__dots">
          <i />
          <i />
          <i />
        </span>
        {tabs.length > 1 ? (
          <div className="term__tabs" role="tablist" aria-label="Examples" onKeyDown={onKey}>
            {tabs.map((t, i) => (
              <button
                key={t.id}
                data-tab={i}
                type="button"
                role="tab"
                className="term__tab"
                aria-selected={i === active}
                tabIndex={i === active ? 0 : -1}
                onClick={() => setActive(i)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <span>{tab.label}</span>
        )}
      </div>
      <pre className="codewin__body" role={tabs.length > 1 ? 'tabpanel' : undefined} aria-label={tab.label}>
        <code>{tab.lang === 'ts' ? highlightTs(tab.code) : tab.code}</code>
      </pre>
      <div className="term__foot">
        <span>{foot ?? tab.lang}</span>
        <CopyButton text={tab.code} label="Copy code" />
      </div>
    </div>
  )
}
