import { useState, type KeyboardEvent } from 'react'
import { CopyButton } from './Chrome'
import { INSTALLERS, LATEST_URL, NPM_URL, REPO, VERSION, compact, fmt, showStars, type InstallerId } from './data'
import { HeroMotion } from './HeroMotion'
import { useCountUp, useStats } from './hooks'
import { IconBook, IconNpm, IconStar } from './Icons'
import { InstallWithAI } from './InstallWithAI'

const TABS = INSTALLERS.map((i) => i.id)

export function Hero() {
  const [tab, setTab] = useState<InstallerId>('npm')
  const installer = INSTALLERS.find((i) => i.id === tab) ?? INSTALLERS[0]
  const hint = 'hint' in installer ? installer.hint : undefined

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.indexOf(tab)
    let n: number
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length
    else return
    e.preventDefault()
    setTab(TABS[n])
    document.getElementById(`tab-${TABS[n]}`)?.focus()
  }

  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero__top">
        <div className="hero__title">
          <a className="pill" href={`${import.meta.env.BASE_URL}docs/`}>
            <span>
              v{VERSION}
              <span className="pill__more"> · MCP server + npm library · MIT</span>
            </span>
            <em>Read the docs</em>
          </a>
          <h1 id="hero-title">
            Give your local AI agent the web, in <span className="ok">126&nbsp;kB</span>.
          </h1>
        </div>
        <div className="hero__subwrap">
          <p className="hero__sub">
            Searches Google in the Chrome you already have, reads the best results and returns clean Markdown inside a
            hard token budget. An MCP server for your local agent and a zero-dependency Node.js library. No API keys, no cloud.
          </p>
          <Proof />
        </div>

        <div className="hero__act">
          <div className="cmd">
            <div className="cmd__tabs" role="tablist" aria-label="Install method" onKeyDown={onKey}>
              {TABS.map((k) => (
                <button
                  key={k}
                  id={`tab-${k}`}
                  type="button"
                  role="tab"
                  className="cmd__tab"
                  aria-selected={tab === k}
                  aria-controls="install-panel"
                  tabIndex={tab === k ? 0 : -1}
                  onClick={() => setTab(k)}
                >
                  {k}
                </button>
              ))}
            </div>
            <div className="cmd__row" role="tabpanel" id="install-panel" aria-labelledby={`tab-${tab}`}>
              <code className="cmd__line">
                <span className="p">$ </span>
                {installer.cmd}
              </code>
              <CopyButton text={installer.cmd} />
            </div>
            {hint && (
              <p className="cmd__hint">
                {hint === 'releases' ? (
                  <>
                    The same file is attached to every <a href={LATEST_URL}>GitHub release</a>.
                  </>
                ) : (
                  hint
                )}
              </p>
            )}
          </div>
          <div className="hero__btns">
            <InstallWithAI />
            <a className="btn btn--line" href={`${import.meta.env.BASE_URL}docs/#library-api`}>
              <IconBook />
              Use it in code
            </a>
          </div>
        </div>
      </div>

      <div className="hero__stage">
        <HeroMotion />
      </div>
    </section>
  )
}

/** Social proof under the subtitle: live npm downloads, and stars once there are enough. */
function Proof() {
  const { downloads, weekly, stars } = useStats()
  const starsOn = showStars(stars)
  const d = useCountUp(downloads)
  const w = useCountUp(weekly)
  const st = useCountUp(starsOn ? stars : null, 1000)
  const width = (n: number | null) => (n === null ? undefined : { minWidth: `${fmt(n).length}ch` })
  return (
    <div className="proof" aria-live="polite">
      <a className="proof__main" href={NPM_URL} aria-label={downloads === null ? undefined : `${fmt(downloads)} npm downloads`}>
        <IconNpm />
        <span className="proof__num" style={width(downloads)}>
          {downloads === null ? '—' : fmt(d ?? 0)}
        </span>
        <span className="proof__label">
          npm downloads
          {weekly !== null && weekly > 0 && <em> · +{fmt(w ?? 0)} this week</em>}
        </span>
      </a>
      {starsOn && (
        <a className="proof__main proof__main--stars" href={REPO} aria-label={`${stars} GitHub stars`}>
          <IconStar />
          <span className="proof__num">{compact(st ?? 0)}</span>
          <span className="proof__label">GitHub stars</span>
        </a>
      )}
    </div>
  )
}
