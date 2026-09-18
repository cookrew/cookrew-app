import { useEffect, useState } from 'react'
import { accountCopy } from '../../../shared/account-copy'
import { cookrew } from '../api'
import { refusalSentence } from './account-store'
import { DOING, problemSentence } from './problem'
import '../grant-surface.css'

/**
 * ADD A MAC (D12) — a code minted where the trust already is.
 *
 * The new machine types nothing but this: no password on a Mac that has not
 * earned one yet, which is the whole point of the ceremony. The code is minted
 * on a device that is already attached, it works ONCE, it lives ten minutes,
 * and every device is told when the Mac joins — so a code read off a screen by
 * somebody else cannot be used quietly.
 *
 * THE SENTENCE SAYS ALL THREE of those facts before the code is on screen
 * rather than after, because the person reading it is about to say the code
 * out loud to a room they may not have looked at.
 *
 * ASKED ONCE, ON OPEN. A code is spent or it expires; polling for a change
 * that cannot happen while the sheet is up would be a clock with nothing to
 * count — the same reason the pairing popout dropped its own.
 */

/** Two groups of four, as the design prints it: `7KQ4 · M2XB`. */
export const groupJoinCode = (code: string): string => {
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (clean.length !== 8) return clean
  return `${clean.slice(0, 4)} · ${clean.slice(4)}`
}

export function AddMacSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [code, setCode] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    let live = true
    const call = cookrew().accountJoinCode
    if (!call) {
      setAsked(true)
      return
    }
    void call()
      .then((result) => {
        if (!live) return
        setAsked(true)
        if (result.ok) setCode(result.value.code)
        else setProblem(refusalSentence(result.reason as never, result.message))
      })
      .catch((err: unknown) => {
        if (!live) return
        setAsked(true)
        setProblem(problemSentence(DOING.PROFILE, err))
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Add a Mac">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Add a Mac</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {/* THE SENTENCE FIRST: what the code is worth, how long it lives, and
            who finds out it was used. */}
        <p className="gs-sub">{accountCopy('d12.add-a-mac')}</p>
        {code !== null && <code className="cmd cr-acct-joincode">{groupJoinCode(code)}</code>}
        {problem !== null && (
          <p className="gs-paste-error" role="alert">
            {problem}
          </p>
        )}
        {asked && code === null && problem === null && (
          <p className="gs-hint">This build cannot mint a code yet.</p>
        )}
      </div>
    </div>
  )
}
