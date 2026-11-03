import { useEffect, useRef, useState } from 'react'
import { still } from './face-flip'
import './prompt-motion.css'

/**
 * SEND (owner design 2026-11-04, motion table: "Send presses .92; the words
 * leave as a toast over the box · 180 ms"). The key dips as the words go, by
 * a click or by Enter alike, and the words rise out of the box into a short
 * toast over it, read out as they leave (role=status). Under reduced motion
 * nothing moves: the toast is simply there for its moment.
 */

export const PRESS_MS = 180
/** The toast's whole stay: up in 180 ms, read, gone. */
export const TOAST_MS = 1800

export interface Sent {
  /** A new toast for each send, even of the same words. */
  readonly key: number
  readonly who: string
  readonly words: string
}

/** The words as the toast reads them: one line; nothing for none. */
export function sentLine(words: string): string | null {
  const line = words.replace(/\s+/g, ' ').trim()
  return line === '' ? null : line
}

/** The send key dips to .92 and comes back. */
export function pressKey(key: HTMLElement | null): void {
  if (!key || typeof key.animate !== 'function' || still()) return
  key.animate([{ transform: 'none' }, { transform: 'scale(0.92)', offset: 0.4 }, { transform: 'none' }], { duration: PRESS_MS, easing: 'ease-out' })
}

export function useSentToast(): { sent: Sent | null; leave: (who: string, words: string) => void } {
  const [sent, setSent] = useState<Sent | null>(null)
  const count = useRef(0)
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [sent])
  const leave = (who: string, words: string): void => {
    const line = sentLine(words)
    if (!line) return
    count.current += 1
    setSent({ key: count.current, who, words: line })
  }
  return { sent, leave }
}

/** Always in the box, so a reader hears each toast as it lands. */
export function SentToast({ sent }: { sent: Sent | null }): React.JSX.Element {
  return (
    <span className="cr-prompt-sent-live" role="status">
      {sent && (
        <span key={sent.key} className="cr-prompt-sent">
          <span className="cr-prompt-sent-sr">Sent to </span>
          <b>{sent.who}</b> {sent.words}
        </span>
      )}
    </span>
  )
}
