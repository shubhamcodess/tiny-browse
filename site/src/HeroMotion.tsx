import { useEffect, useRef, useState } from 'react'
import { MEASURED, fmt } from './data'
import { usePrefersReducedMotion } from './hooks'
import { IconPause, IconPlay, IconReplay } from './Icons'

/**
 * The hero replay: a local agent asks a question, tiny-browse searches Google in a headless Chrome,
 * votes on the results, reads the top page, strips its noise and hands back Markdown inside the
 * token budget. One timeline drives two panes (the agent, tiny-browse at work); on narrow screens
 * only the active pane shows. Runs only while on screen; reduced motion shows the finished state.
 */

const LOOP = 16500
const END = 14200 // the finished frame (reduced motion, paused at end)

const PROMPT = 'How does backpressure work in Node.js streams? Cite the docs.'
const ANSWER =
  'Backpressure is data building up behind a buffer when the receiver is slower than the source. In Node.js streams, write() returns false when the buffer is full: stop writing and wait for the drain event.'

const RESULTS = [
  { title: 'Backpressuring in Streams | Node.js Learn', host: 'nodejs.org › learn › modules' },
  { title: 'Stream | Node.js Documentation', host: 'nodejs.org › api › stream' },
  { title: 'Understanding backpressure in Node.js streams', host: 'blog · 2025' },
]
const PARSERS = ['layout', 'a11y tree', 'selectors']

const MD: { k: 'h' | 'src' | 'p' | 'h2' | 'mark' | 'code'; t: string }[] = [
  { k: 'mark', t: `<!-- begin untrusted content from ${MEASURED.host} -->` },
  { k: 'h', t: '# Backpressuring in Streams' },
  { k: 'src', t: '> https://nodejs.org/learn/modules/backpressuring-in-streams' },
  { k: 'p', t: 'There is a general problem that occurs during data handling called backpressure and describes a buildup of data behind a buffer during data transfer.' },
  { k: 'h2', t: '## How Does Backpressure Resolve These Issues?' },
  { k: 'p', t: 'In Node.js, there is an internal built-in function called .pipe() …' },
  { k: 'code', t: '_[Showing the sections most relevant to the query]_' },
]

type Stage = 'ask' | 'search' | 'read' | 'fit' | 'answer'
const STEPS: { id: Stage; label: string; at: number }[] = [
  { id: 'ask', label: 'ask', at: 0 },
  { id: 'search', label: 'search', at: 2500 },
  { id: 'read', label: 'read', at: 5400 },
  { id: 'fit', label: 'fit', at: 8400 },
  { id: 'answer', label: 'answer', at: 11200 },
]

const stageAt = (t: number): Stage => [...STEPS].reverse().find((s) => t >= s.at)?.id ?? 'ask'
/** Text typed between two times. */
const typed = (text: string, t: number, from: number, to: number) =>
  t <= from ? '' : t >= to ? text : text.slice(0, Math.round(((t - from) / (to - from)) * text.length))
/** 0..1 progress between two times, eased out. */
const ease = (t: number, from: number, to: number) => {
  const k = Math.min(1, Math.max(0, (t - from) / (to - from)))
  return k === 1 ? 1 : 1 - Math.pow(2, -8 * k)
}
const on = (t: number, at: number) => t >= at

export function HeroMotion() {
  const reduced = usePrefersReducedMotion()
  const root = useRef<HTMLElement>(null)
  const [t, setT] = useState(END)
  const [visible, setVisible] = useState(false)
  const [paused, setPaused] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.1 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // The clock: elapsed time is added up on a short interval, so it runs at real speed, survives
  // re-renders, and simply stops while off screen, paused or in a hidden tab.
  useEffect(() => {
    // ?hm=<ms> freezes the replay at that moment (for reviewing frames)
    const frozen = Number(new URLSearchParams(location.search).get('hm'))
    if (frozen > 0) {
      setT(frozen % LOOP)
      return
    }
    if (reduced) {
      setT(END)
      return
    }
    if (!visible || paused) return
    if (!started.current) {
      started.current = true
      setT(0)
    }
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      const dt = Math.min(250, now - last)
      last = now
      if (!document.hidden) setT((v) => (v + dt) % LOOP)
    }, 40)
    return () => window.clearInterval(id)
  }, [visible, paused, reduced])

  const stage = stageAt(t)
  const fade = t > LOOP - 500 ? (LOOP - t) / 500 : 1

  // tiny-browse pane: results page, then the article, then the Markdown it returns
  const onPage = on(t, 5400)
  const voted = on(t, 4300)
  const flagged = on(t, 6500)
  const struck = on(t, 7600)
  const fitting = on(t, 8400)
  const mdShown = MD.filter((_, i) => on(t, 8500 + i * 260)).length
  const shrink = ease(t, 8700, 10600)
  const tokens = Math.round(MEASURED.htmlTokens - (MEASURED.htmlTokens - MEASURED.mdTokens) * shrink)
  const done = on(t, 10800)

  const active: 'agent' | 'browser' = stage === 'ask' || stage === 'answer' ? 'agent' : 'browser'

  function replay() {
    started.current = true
    setT(0)
    setPaused(false)
  }

  return (
    <figure className="hm" ref={root} aria-labelledby="hm-cap" data-stage={stage} data-active={active}>
      <figcaption id="hm-cap" className="sr-only">
        Replay: a local agent asks how backpressure works in Node.js streams and calls the web_search tool.
        tiny-browse searches Google in a headless Chrome, reads the results page three ways and votes, opens the
        top result, drops its navigation, cookie banner, sidebar and footer, and returns{' '}
        {fmt(MEASURED.mdTokens)} tokens of Markdown instead of {fmt(MEASURED.htmlTokens)} tokens of HTML. The local
        agent answers and cites nodejs.org.
      </figcaption>
      <div className="hm__bar">
        <span className="app__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="hm__title">local agent · web_search</span>
        <span className="hm__ctl">
          {!reduced && (
            <>
              <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
                {paused ? <IconPlay /> : <IconPause />}
              </button>
              <button type="button" onClick={replay} aria-label="Replay from the start">
                <IconReplay />
              </button>
            </>
          )}
        </span>
      </div>

      <div className="hm__body" style={{ opacity: fade }} aria-hidden="true">
        {/* ---------- the local agent ---------- */}
        <section className={`hm__pane hm__agent${active === 'agent' ? ' is-active' : ''}`}>
          <p className="hm__label">
            <span>01</span> your local agent
          </p>
          <div className="hm__msg hm__msg--user">
            {typed(PROMPT, t, 250, 1900)}
            {t > 250 && t < 1900 && <span className="caret" />}
          </div>
          {on(t, 2100) && (
            <div className={`hm__call${done ? ' is-done' : ''}`}>
              <div className="hm__call-head">
                <span className="hm__tool">tiny-browse · web_search</span>
                <span className="hm__status">{done ? `✓ ${fmt(MEASURED.mdTokens)} tokens` : 'running…'}</span>
              </div>
              <pre>
                {'{ '}
                <span className="k">"query"</span>: <span className="s">"node.js stream backpressure"</span>,{'\n  '}
                <span className="k">"read"</span>: 1, <span className="k">"max_tokens"</span>: {fmt(MEASURED.budget)}
                {' }'}
              </pre>
            </div>
          )}
          {on(t, 11300) && (
            <div className="hm__msg hm__msg--bot">
              {typed(ANSWER, t, 11400, 13600)}
              {on(t, 13600) && (
                <>
                  {' '}
                  <span className="hm__cite">nodejs.org</span>
                </>
              )}
            </div>
          )}
        </section>

        {/* ---------- tiny-browse at work ---------- */}
        <section className={`hm__pane hm__browser${active === 'browser' ? ' is-active' : ''}`}>
          <p className="hm__label">
            <span>02</span> tiny-browse · your Chrome, headless
          </p>
          <div className="hm__addr">
            <span className="hm__lock" />
            {onPage ? 'nodejs.org/en/learn/modules/backpressuring-in-streams' : 'google.com/search?q=node.js+stream+backpressure'}
          </div>
          <div className="hm__view">
            {!on(t, 2600) ? (
              <p className="hm__wait">waiting for a tool call…</p>
            ) : !onPage ? (
              <div className="hm__serp">
                {RESULTS.map((r, i) =>
                  on(t, 2700 + i * 220) ? (
                    <div key={r.title} className={`hm__res${voted && i === 0 ? ' is-pick' : ''}`}>
                      <small>{r.host}</small>
                      <b>{r.title}</b>
                      <i />
                      {voted && i === 0 && <em>read</em>}
                    </div>
                  ) : null,
                )}
                <div className="hm__vote">
                  {PARSERS.map((p, i) => (
                    <span key={p} className={on(t, 3400 + i * 280) ? 'is-on' : ''}>
                      {on(t, 3400 + i * 280) ? '✓ ' : ''}
                      {p}
                    </span>
                  ))}
                  <span className={`hm__voted${voted ? ' is-on' : ''}`}>→ merged by vote</span>
                </div>
              </div>
            ) : !fitting ? (
              <div className={`hm__page${flagged ? ' is-flagged' : ''}${struck ? ' is-struck' : ''}`}>
                <div className="hm__blk hm__blk--noise hm__nav">
                  <em>navigation</em>
                </div>
                <div className="hm__blk hm__blk--noise hm__cookie">
                  <em>cookie banner</em>
                </div>
                <div className="hm__cols">
                  <div className="hm__main">
                    <div className="hm__h" />
                    <div className="hm__l" />
                    <div className="hm__l" />
                    <div className="hm__l hm__l--s" />
                    <div className="hm__code" />
                    <div className="hm__l" />
                    <div className="hm__l hm__l--m" />
                  </div>
                  <div className="hm__blk hm__blk--noise hm__side">
                    <em>sidebar</em>
                  </div>
                </div>
                <div className="hm__blk hm__blk--noise hm__pagefoot">
                  <em>footer</em>
                </div>
              </div>
            ) : (
              <div className="hm__md">
                {MD.slice(0, mdShown).map((l) => (
                  <p key={l.t} className={`md-${l.k}`}>
                    {l.t}
                  </p>
                ))}
              </div>
            )}
          </div>
          {onPage && (
            <div className="hm__meter">
              <div className="hm__meter-row">
                <span>{shrink > 0 ? 'Markdown to the model' : 'page HTML'}</span>
                <b>{fmt(tokens)} tokens</b>
              </div>
              <div className="hm__track">
                <i style={{ width: `${Math.max(2.2, (tokens / MEASURED.htmlTokens) * 100)}%` }} />
                <s style={{ left: `${(MEASURED.budget / MEASURED.htmlTokens) * 100}%` }} />
              </div>
              <div className="hm__meter-row hm__meter-row--sub">
                <span>max_tokens {fmt(MEASURED.budget)}</span>
                <span>{done ? `−${(100 - (MEASURED.mdTokens / MEASURED.htmlTokens) * 100).toFixed(1)}%` : ''}</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <ol className="hm__steps" aria-hidden="true">
        {STEPS.map((s) => (
          <li key={s.id} className={s.id === stage ? 'is-on' : t >= s.at ? 'is-past' : ''}>
            {s.label}
          </li>
        ))}
      </ol>
      <p className="hm__note">replay · token counts measured with tiny-browse on {MEASURED.host}</p>
    </figure>
  )
}
