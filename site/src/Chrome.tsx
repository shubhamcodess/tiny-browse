import { useEffect, useState } from 'react'
import { AUTHOR, BLOB, NPM_URL, REPO, WHATCMD, compact, showStars } from './data'
import { useStats } from './hooks'
import { IconCheck, IconCopy, IconGithub, IconMoon, IconNpm, IconStar, IconSun, Mark } from './Icons'

type Theme = 'light' | 'dark'

const YEAR = new Date().getFullYear()

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function Nav({ page = 'home' }: { page?: 'home' | 'docs' }) {
  const base = import.meta.env.BASE_URL
  const home = page === 'home' ? '' : base
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try {
      localStorage.setItem('tb-theme', next)
    } catch {
      /* storage can be unavailable; the theme still applies for this visit */
    }
  }

  return (
    <header className="nav">
      <div className="nav__row">
        <a className="brand" href={page === 'home' ? '#top' : base} aria-label="tiny-browse home">
          <Mark />
          <span className="brand__name">tiny-browse</span>
        </a>
        <nav className="nav__links" aria-label="Main">
          <span className="nav__anchors">
            <a href={`${home}#how`}>How it works</a>
            <a href={`${home}#features`}>Features</a>
            <a href={`${home}#use-cases`}>Use cases</a>
            <a href={`${home}#install`}>Install</a>
            <a href={`${home}#faq`}>FAQ</a>
          </span>
          <a href={`${base}docs/`} aria-current={page === 'docs' ? 'page' : undefined}>
            Docs
          </a>
          <span className="nav__sep" aria-hidden="true" />
          <StarButton className="nav__star" />
          <a href={NPM_URL} aria-label="npm package" title="npm">
            <IconNpm />
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </nav>
      </div>
    </header>
  )
}

/** GitHub star call to action. The live count shows once it reaches STAR_MIN. */
export function StarButton({ className = '', label = 'Star' }: { className?: string; label?: string }) {
  const { stars } = useStats()
  const show = showStars(stars)
  return (
    <a
      className={`star ${className}`}
      href={REPO}
      aria-label={show ? `Star on GitHub, ${stars} stars` : 'Star on GitHub'}
      title="Star on GitHub"
    >
      <IconGithub />
      <span className="star__label">{label}</span>
      {show && (
        <span className="star__count">
          <IconStar />
          {compact(stars)}
        </span>
      )}
    </a>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch {
      setState('failed')
    }
    window.setTimeout(() => setState('idle'), 1800)
  }

  return (
    <button type="button" className="copy" onClick={copy} data-done={state === 'done'} aria-live="polite">
      {state === 'done' ? <IconCheck /> : <IconCopy />}
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Select it' : label}
    </button>
  )
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot__id">
        <span>
          © {YEAR} {AUTHOR} · tiny-browse · MIT · runs on your machine, no telemetry
          <span className="foot__privacy">
            Privacy: this site sets no cookies and runs no analytics. Download and star counts load from the
            public npm and GitHub APIs.
          </span>
        </span>
      </div>
      <ul>
        <li>
          <a href={REPO}>GitHub</a>
        </li>
        <li>
          <a href={NPM_URL}>npm</a>
        </li>
        <li>
          <a href={`${import.meta.env.BASE_URL}docs/`}>Docs</a>
        </li>
        <li>
          <a href={`${BLOB}/CHANGELOG.md`}>Changelog</a>
        </li>
        <li>
          <a href={`${BLOB}/SECURITY.md`}>Security</a>
        </li>
        <li>
          <a href={`${BLOB}/CONTRIBUTING.md`}>Contributing</a>
        </li>
        <li>
          <a href={WHATCMD.site}>whatcmd</a>
        </li>
      </ul>
    </footer>
  )
}
