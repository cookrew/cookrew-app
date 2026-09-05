import { useEffect, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import type { ApprovalDecision, ApprovalRequest } from '../../../shared/account-approvals'
import { cookrew } from '../api'
import { approvalView, refusalSentence } from './account-store'
import '../grant-surface.css'

/**
 * A DEVICE ASKS TO SIGN IN (D6) — at the top of the profile sheet, and
 * nowhere else.
 *
 * NOT A MODAL OVER THE CANVAS. The design says this lives in the avatar's
 * rose badge and in the system notification, and both lead here. A dialog
 * that appeared over the work would be answered by reflex to get rid of it,
 * which is precisely the click this screen exists to prevent.
 *
 * THREE ANSWERS, WEIGHTED HONESTLY. Approve is the primary because it is the
 * common case — it is usually the owner's own phone. Deny is next to it and
 * does nothing else: a device that was denied can ask again. "Not me" is a
 * GHOST and asks for a second press, because it signs every other device out
 * of the account and forces a new password — the right thing to do when a
 * stranger is asking, and a bad afternoon when it was a mis-click.
 *
 * The clock is live. "Started 12 seconds ago" going stale while the card sits
 * open is how a person approves something that started asking an hour ago.
 */

/** The sentence ticks in seconds, so it is re-read once a second. */
const TICK_MS = 1_000

function Card({
  request,
  username,
  hasSecondFactor,
  now,
  onStatus,
}: {
  request: ApprovalRequest
  username: string
  hasSecondFactor: boolean
  now: number
  onStatus: (next: AccountStatus) => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = approvalView(request, { username, hasSecondFactor, now })

  const decide = (decision: ApprovalDecision): void => {
    const call = cookrew().accountDecide
    if (!call || busy) return
    setBusy(true)
    setError(null)
    void call({ id: request.id, decision })
      .then((result) => {
        setBusy(false)
        if (result.ok) onStatus(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        setBusy(false)
        console.error('approval decision:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  return (
    <section className="cr-acct-card cr-acct-request" aria-label="A device asks to sign in">
      <p className="cr-acct-asklead">{view.lead}</p>
      <p className="gs-sub cr-acct-askdetail">{view.detail}</p>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <div className="gs-sheet-foot cr-acct-askfoot">
        <button className="gs-primary" disabled={busy} onClick={() => decide('approve')}>
          APPROVE
        </button>
        <button className="gs-revoke" disabled={busy} onClick={() => decide('deny')}>
          DENY
        </button>
        <button className="gs-ghost" disabled={busy} onClick={() => setConfirming(true)}>
          NOT ME — LOCK ACCOUNT
        </button>
      </div>
      {confirming && (
        <p className="gs-consequence">
          {view.confirm}{' '}
          <button className="gs-revoke" disabled={busy} onClick={() => decide('not-me')}>
            NOT ME, LOCK IT
          </button>
        </p>
      )}
    </section>
  )
}

export function ApprovalCard({
  requests,
  username,
  hasSecondFactor = false,
  focusId = null,
  onStatus,
  now,
}: {
  requests: readonly ApprovalRequest[]
  username: string
  hasSecondFactor?: boolean
  /** The one a notification was clicked for; it is shown first. */
  focusId?: string | null
  onStatus: (next: AccountStatus) => void
  /** Fixed by a test; otherwise the wall clock, ticking. */
  now?: number
}): React.JSX.Element | null {
  const [tick, setTick] = useState(now ?? Date.now())

  useEffect(() => {
    if (now !== undefined || requests.length === 0) return
    const timer = window.setInterval(() => setTick(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [now, requests.length])

  if (requests.length === 0) return null
  const ordered =
    focusId === null
      ? requests
      : [...requests].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))

  return (
    <>
      {ordered.map((request) => (
        <Card
          key={request.id}
          request={request}
          username={username}
          hasSecondFactor={hasSecondFactor}
          now={now ?? tick}
          onStatus={onStatus}
        />
      ))}
    </>
  )
}
