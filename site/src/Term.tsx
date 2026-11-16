import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CopyButton } from './Chrome'
import { usePrefersReducedMotion } from './hooks'

export type LineKind = 'cmd' | 'com' | 'out' | 'ok' | 'hi' | 'cut' | 'gap'
export interface Line {
  k: LineKind
  t?: string
}
export interface TermTab {
  id: string
  label: string
  lines: Line[]
  foot?: string
}

const CHAR_MS = 22
const LINE_MS = 70

/**
 * A terminal that plays its active tab: commands are typed, output streams in line by line.
 * Plays when scrolled into view and on every tab change; reduced motion shows the end state.
 */
export function Term({ tabs, title = 'zsh' }: { tabs: TermTab[]; title?: string }) {
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ line: 0, char: 0 })
  const [visible, setVisible] = useState(false)
  const reduced = usePrefersReducedMotion()
  const root = useRef<HTMLDivElement>(null)
  const tab = tabs[active]

  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const lines = tab.lines
    if (reduced) {
      setPos({ line: lines.length, char: 0 })
      return
    }
    if (!visible) return
    setPos({ line: 0, char: 0 })
    let line = 0
    let char = 0
    let timer = 0
    const step = () => {
      if (line >= lines.length) return
      const l = lines[line]
      if (l.k === 'cmd' && l.t && char < l.t.length) {
        // long commands type in chunks so none takes more than about a second
        char = Math.min(l.t.length, char + Math.max(1, Math.ceil(l.t.length / 45)))
        setPos({ line, char })
        timer = window.setTimeout(step, CHAR_MS)
        return
      }
      line += 1
      char = 0
      setPos({ line, char })
      const next = lines[line]
      const wait = !next ? 0 : next.k === 'cmd' ? 380 : l.k === 'cmd' ? 260 : LINE_MS
      timer = window.setTimeout(step, wait)
    }
    timer = window.setTimeout(step, 300)
    return () => window.clearTimeout(timer)
  }, [active, visible, reduced, tab.lines])

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    let n: number
    if (e.key === 'ArrowRight') n = (active + 1) % tabs.length
    else if (e.key === 'ArrowLeft') n = (active - 1 + tabs.length) % tabs.length
    else return
    e.preventDefault()
    setActive(n)
    root.current?.querySelector<HTMLButtonElement>(`[data-tab="${n}"]`)?.focus()
  }

  const commands = tab.lines
    .filter((l) => l.k === 'cmd')
    .map((l) => l.t)
    .join('\n')

  return (
    <div className="term" ref={root}>
      <div className="term__bar">
        <span className="app__dots">
          <i />
          <i />
          <i />
        </span>
        {tabs.length > 1 ? (
          <div className="term__tabs" role="tablist" aria-label={`${title} sessions`} onKeyDown={onKey}>
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
          <span>{title}</span>
        )}
      </div>
      <div className="term__body" role="tabpanel" aria-label={tab.label}>
        <div className="term__scroll">
          {tab.lines.map((l, i) => {
            if (i > pos.line) return null
            if (l.k === 'gap') return <div key={i} className="t-gap" />
            const text = l.t ?? ''
            if (l.k === 'cmd') {
              const typing = i === pos.line
              return (
                <p key={i} className="t-cmd">
                  <span className="p">$ </span>
                  {typing ? text.slice(0, pos.char) : text}
                  {typing && <span className="caret" />}
                </p>
              )
            }
            if (i === pos.line) return null
            return (
              <p key={i} className={`t-${l.k}`}>
                {text}
              </p>
            )
          })}
          {pos.line >= tab.lines.length && (
            <p className="t-cmd">
              <span className="p">$ </span>
              <span className="caret" />
            </p>
          )}
        </div>
      </div>
      <div className="term__foot">
        <span>{tab.foot ?? 'real output'}</span>
        {commands && <CopyButton text={commands} label="Copy commands" />}
      </div>
    </div>
  )
}
