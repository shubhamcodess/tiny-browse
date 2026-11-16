import { useEffect, useState, type RefObject } from 'react'
import { GITHUB_USER, NPM_SINCE, PACKAGE } from './data'

export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** True once the element has been at least `threshold` visible. Stays true. */
export function useSeen(ref: RefObject<Element | null>, threshold = 0.4): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true)
          io.disconnect()
        }
      },
      { threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen, threshold])
  return seen
}

/** Animates a number from `from` to `to` over `ms` with an exponential ease-out. */
export function animateNumber(
  from: number,
  to: number,
  ms: number,
  onFrame: (v: number) => void,
): () => void {
  let raf = 0
  const start = performance.now()
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / ms)
    const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
    onFrame(from + (to - from) * eased)
    if (t < 1) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

export interface Stats {
  /** npm downloads since the package was first published */
  downloads: number | null
  /** npm downloads in the last 7 days */
  weekly: number | null
  stars: number | null
}

const STATS_KEY = 'tb-stats'
const STATS_TTL = 10 * 60 * 1000 // GitHub allows 60 unauthenticated requests an hour per IP
let pending: Promise<Stats> | null = null

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url)
    return r.ok ? ((await r.json()) as T) : null
  } catch {
    return null
  }
}

function loadStats(): Promise<Stats> {
  if (pending) return pending
  pending = (async () => {
    try {
      const hit = JSON.parse(sessionStorage.getItem(STATS_KEY) ?? 'null') as (Stats & { at: number }) | null
      if (hit && Date.now() - hit.at < STATS_TTL) return hit
    } catch {
      /* storage unavailable: fetch fresh */
    }
    // npm caps a point range at 18 months, so count from whichever is later
    const today = new Date().toISOString().slice(0, 10)
    const cap = new Date(Date.now() - 540 * 864e5).toISOString().slice(0, 10)
    const from = NPM_SINCE > cap ? NPM_SINCE : cap
    const [npm, week, gh] = await Promise.all([
      getJson<{ downloads: number }>(`https://api.npmjs.org/downloads/point/${from}:${today}/${PACKAGE}`),
      getJson<{ downloads: number }>(`https://api.npmjs.org/downloads/point/last-week/${PACKAGE}`),
      getJson<{ stargazers_count: number }>(`https://api.github.com/repos/${GITHUB_USER}/tiny-browse`),
    ])
    const stats: Stats = {
      downloads: npm?.downloads ?? null,
      weekly: week?.downloads ?? null,
      stars: gh?.stargazers_count ?? null,
    }
    try {
      if (stats.downloads !== null && stats.stars !== null)
        sessionStorage.setItem(STATS_KEY, JSON.stringify({ ...stats, at: Date.now() }))
    } catch {
      /* ignore */
    }
    return stats
  })()
  return pending
}

/** Live npm downloads and GitHub stars from the public APIs. Null until loaded or on failure. */
export function useStats(): Stats {
  const [stats, setStats] = useState<Stats>({ downloads: null, weekly: null, stars: null })
  useEffect(() => {
    let live = true
    loadStats().then((s) => live && setStats(s))
    return () => {
      live = false
    }
  }, [])
  return stats
}

/**
 * Counts from 0 up to `target` once it is known (ease-out, like the benchmark bars).
 * Null until the target arrives; jumps straight to it when reduced motion is on.
 */
export function useCountUp(target: number | null, ms = 1400): number | null {
  const reduced = usePrefersReducedMotion()
  const [value, setValue] = useState<number | null>(null)
  useEffect(() => {
    if (target === null || reduced) return
    return animateNumber(0, target, ms, (v) => setValue(Math.round(v)))
  }, [target, reduced, ms])
  return reduced ? target : value
}
