import { useEffect, useState } from 'react'
import { usePrefersReducedMotion } from './hooks'
import { IconCheck } from './Icons'
import { INSTALL_PROMPT } from './installPrompt'
import { AGENT_MARKS } from './logos'

const MARKS = AGENT_MARKS.filter((a) => a.path)
const STEP_MS = 1800
const FILE = 'install-tiny-browse.txt'
const NOTE_MS = 8000
const NOTE_EXIT_MS = 350

function Mark({ index, className }: { index: number; className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={MARKS[index].path} />
    </svg>
  )
}

function download() {
  const url = URL.createObjectURL(new Blob([INSTALL_PROMPT], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = FILE
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Copies a short setup prompt to hand to a coding agent. The icon cycles through the agents. */
export function InstallWithAI() {
  const reduced = usePrefersReducedMotion()
  const [i, setI] = useState(0)
  const [note, setNote] = useState<{ id: number; result: 'copied' | 'saved' } | null>(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (reduced) return
    const id = window.setInterval(() => {
      if (!document.hidden) setI((n) => (n + 1) % MARKS.length)
    }, STEP_MS)
    return () => window.clearInterval(id)
  }, [reduced])

  // Each click restarts the message: visible for NOTE_MS, then it animates out and is removed.
  useEffect(() => {
    if (!note) return
    const leave = window.setTimeout(() => setLeaving(true), NOTE_MS)
    const clear = window.setTimeout(() => {
      setNote(null)
      setLeaving(false)
    }, NOTE_MS + NOTE_EXIT_MS)
    return () => {
      window.clearTimeout(leave)
      window.clearTimeout(clear)
    }
  }, [note])

  // Copy only; the file is the fallback when the clipboard is blocked.
  async function run() {
    let result: 'copied' | 'saved' = 'copied'
    try {
      await navigator.clipboard.writeText(INSTALL_PROMPT)
    } catch {
      download()
      result = 'saved'
    }
    setLeaving(false)
    setNote((n) => ({ id: (n?.id ?? 0) + 1, result }))
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--line ai-btn"
        onClick={run}
        title="Copies a short setup prompt for your coding agent"
      >
        <span className="ai-btn__icons" aria-hidden="true">
          <Mark key={`out-${i}`} index={(i - 1 + MARKS.length) % MARKS.length} className="ai-btn__out" />
          <Mark key={`in-${i}`} index={i} className="ai-btn__in" />
        </span>
        Install with AI
      </button>
      <div className="ai-note" role="status">
        {note && (
          <p key={note.id} className={leaving ? 'ai-note__msg is-leaving' : 'ai-note__msg'}>
            <IconCheck />
            {note.result === 'copied'
              ? 'Setup prompt copied. Paste it into your coding agent.'
              : `Saved as ${FILE}. Couldn't copy it, so attach the file to your agent.`}
          </p>
        )}
      </div>
    </>
  )
}
