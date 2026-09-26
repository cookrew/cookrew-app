import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import '../grant-surface.css'

/**
 * account:changed, IN THE WINDOW (D11 · A4).
 *
 * A system notification is for the person who is not looking at Cookrew. This
 * is for the one who IS: a device joined, one was revoked, the password
 * changed, a door moved, somebody pressed "not me". Those are facts about the
 * account that arrive with nobody having clicked anything, and a person
 * working on the canvas should not have to have OS notification permissions
 * turned on to learn them.
 *
 * THE SENTENCE IS NOT WRITTEN HERE. It arrives already written, by the same
 * view model main used for the notification (shared/account-requests.ts), so
 * the toast and the toast's own notification cannot word the same event
 * differently.
 *
 * IT NEVER STEALS A CLICK. No buttons, no focus: the queue is where an account
 * event is acted on, and a toast that could be answered would be a modal over
 * the canvas by another name.
 */

/** Long enough to read a sentence, short enough not to sit on the canvas. */
export const TOAST_MS = 6_000
/** More than this on screen at once is a wall, not a notice. */
export const TOAST_MAX = 3

export interface AccountToast {
  key: number
  kind: string
  sentence: string
}

/** Newest first, bounded. Pure, so the bound is checked without a clock. */
export function withToast(
  toasts: readonly AccountToast[],
  next: AccountToast,
  limit = TOAST_MAX,
): AccountToast[] {
  return [next, ...toasts].slice(0, limit)
}

export function AccountToasts(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<readonly AccountToast[]>([])

  useEffect(() => {
    let seq = 0
    const off = cookrew().onAccountEvent?.((event) => {
      const toast = { key: (seq += 1), kind: event.kind, sentence: event.sentence }
      setToasts((prior) => withToast(prior, toast))
      window.setTimeout(() => {
        setToasts((prior) => prior.filter((held) => held.key !== toast.key))
      }, TOAST_MS)
    })
    return off
  }, [])

  if (toasts.length === 0) return null
  return (
    <div className="cr-acct-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <p key={toast.key} className="cr-acct-toast" data-kind={toast.kind}>
          {toast.sentence}
        </p>
      ))}
    </div>
  )
}
