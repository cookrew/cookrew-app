import { useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew, type UnlockAnswer } from '../api'
import { initialsOf, lockNote } from './account-store'
import '../grant-surface.css'

/**
 * THE LOCK SCREEN (D5) — the canvas dims behind a centred card.
 *
 * THE PASSWORD WORKS OFFLINE. It is checked against the local verifier in
 * account.json, never against cookrew.dev: a lock that needed the network
 * would fail closed on a plane, which is where a laptop is most worth locking.
 *
 * AGENTS KEEP RUNNING UNDERNEATH, and the copy says so. Only the owner's view
 * is locked — a lock that stopped the work is a lock nobody leaves on.
 *
 * TOUCH ID IS HIDDEN until a passkey exists (phase 4). An inert Touch ID
 * button on the one screen a person meets when they are already locked out
 * would be the cruellest possible place to put a control that does nothing.
 */
export function LockScreen({
  status,
  onUnlocked,
}: {
  status: AccountStatus
  onUnlocked: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [outcome, setOutcome] = useState<UnlockAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [])

  const unlock = (): void => {
    const call = cookrew().accountUnlock
    if (!call || busy || password.length === 0) return
    setBusy(true)
    void call(password)
      .then((answer) => {
        setBusy(false)
        setOutcome(answer)
        setPassword('')
        if (answer.ok) onUnlocked()
      })
      .catch((err: unknown) => {
        setBusy(false)
        console.error('unlock:', err)
      })
  }

  const username = status.username ?? ''
  return (
    <div className="cr-acct-lock" role="dialog" aria-modal="true" aria-label="Cookrew is locked">
      {/* cr-sheet re-dresses the gs-* field and primary inside the card in the
          house materials; without it they fall to grant-surface's dark theme. */}
      <div className="cr-acct-lockcard cr-sheet">
        <span className="cr-acct-avatar cr-acct-claimed cr-acct-big">
          <span className="cr-acct-initials">{initialsOf(username, status.displayName)}</span>
        </span>
        <h2>@{username.toUpperCase()}</h2>
        <p className="gs-sub" role="status">
          {lockNote(outcome)}
        </p>
        <input
          ref={field}
          type="password"
          className="gs-input"
          aria-label="Password"
          placeholder="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && unlock()}
        />
        <button className="gs-primary" disabled={busy || password.length === 0} onClick={unlock}>
          UNLOCK
        </button>
      </div>
    </div>
  )
}
