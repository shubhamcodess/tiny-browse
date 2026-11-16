import { useEffect, useRef } from 'react'

/**
 * The page's backdrop: a dot-matrix of "tokens". A slow diagonal sweep tints the dots it
 * passes (noise) and leaves them dimmed (pruned) before they recover; the pointer lifts
 * nearby dots. Runs at ~30fps, pauses when the tab is hidden, and draws one static frame
 * under reduced motion.
 */
export function Field() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const GAP = 26
    let w = 0
    let h = 0
    let dpr = 1
    let dot = [183, 166, 255]
    let noise = [255, 159, 122]
    let mx = -9999
    let my = -9999
    let raf = 0
    let last = 0

    const readColors = () => {
      const cs = getComputedStyle(document.documentElement)
      const parse = (v: string, fb: number[]) => {
        const p = v.split(',').map((n) => Number(n.trim()))
        return p.length === 3 && p.every((n) => !Number.isNaN(n)) ? p : fb
      }
      dot = parse(cs.getPropertyValue('--dot'), dot)
      noise = parse(cs.getPropertyValue('--dot-cut'), noise)
    }

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h)
      const span = w + h * 0.6
      const sweep = (((t / 11000) % 1) * 1.5 - 0.25) * span
      const cols = Math.ceil(w / GAP) + 1
      const rows = Math.ceil(h / GAP) + 1
      for (let r = 0; r < rows; r++) {
        const y = r * GAP + GAP / 2
        // Fade toward the bottom and the very edges so the field never competes with text.
        const vy = 1 - Math.min(1, y / (h * 1.1)) * 0.55
        for (let c = 0; c < cols; c++) {
          const x = c * GAP + GAP / 2
          const edge = Math.min(1, x / 140, (w - x) / 140)
          const seed = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453
          const jitter = seed - Math.floor(seed)
          let a = (0.11 + jitter * 0.07) * vy * Math.max(0.25, edge)
          let col = dot
          let size = 1.6

          if (!reduced) {
            const d = x + y * 0.6 - sweep
            if (d > -60 && d < 60 && jitter > 0.35) {
              col = noise
              a += 0.22 * (1 - Math.abs(d) / 60)
            } else if (d <= -60 && d > -520 && jitter > 0.35) {
              a *= 0.25 + 0.75 * ((-d - 60) / 460)
            }
            a += Math.sin(t * 0.0011 + jitter * 40) * 0.025
          }

          const dx = x - mx
          const dy = y - my
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 150) {
            const k = 1 - dist / 150
            a += 0.38 * k * k
            size += 1.2 * k
          }

          if (a <= 0.01) continue
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(a, 0.75)})`
          ctx.fillRect(x - size / 2, y - size / 2, size, size)
        }
      }
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 33) return
      last = now
      draw(now)
    }

    const onMove = (e: PointerEvent) => {
      mx = e.clientX
      my = e.clientY
      if (reduced) draw(0)
    }
    const onLeave = () => {
      mx = my = -9999
      if (reduced) draw(0)
    }
    const onVis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden && !reduced) raf = requestAnimationFrame(loop)
    }
    const onResize = () => {
      resize()
      draw(performance.now())
    }

    readColors()
    resize()
    draw(0)
    if (!reduced) raf = requestAnimationFrame(loop)

    const mo = new MutationObserver(() => {
      readColors()
      draw(performance.now())
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return (
    <div className="bgfield" aria-hidden="true">
      <canvas ref={ref} />
    </div>
  )
}
