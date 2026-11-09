import { useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew, type UnlockAnswer } from '../api'
import { initialsOf, lockNote, type LockWaiting } from './account-store'
import { PROVIDER_COPY, providerRefusal } from './provider-store'
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
 *
 * IT KNOWS WHO IS WAITING (D13). The idle lock is the moment a request is
 * most likely to arrive — the owner is at the other machine, asking in. So
 * the lock says so, in one line under the reason it is locked, and unlocking
 * lands on the request (AccountSurface opens the profile sheet). NOTHING IS
 * APPROVABLE FROM HERE: the line is a sentence, not a button, because a lock
 * that let a passer-by admit a device would not be a lock.
 */
export function LockScreen({
  status,
  onUnlocked,
}: {
  status: AccountStatus
  /** Told how many were waiting at the moment of unlocking, so the surface can land on them. */
  onUnlocked: (waiting?: number) => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [outcome, setOutcome] = useState<UnlockAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The names behind `status.requests`. The count is on the status and is
   * always current; the names take a read of the approvals list, which is
   * made only while something is waiting and is dropped the moment the count
   * goes to zero — a lock screen has no business holding a device list.
   */
  const [names, setNames] = useState<readonly string[]>([])
  const field = useRef<HTMLInputElement>(null)
  /**
   * THE WAY BACK FROM A FORGOTTEN PASSCODE IS A RESCUE CODE, NEVER THE PROVIDER.
   * A browser already signed in to GitHub answers without a person, so a
   * provider button here would let anyone at this Mac through the lock.
   */
  const [rescue, setRescue] = useState<string | null>(null)
  const [rescueError, setRescueError] = useState<string | null>(null)
  const passcode = status.unlockBy === 'passcode'
  // Until the account password is first typed here it folds the passcode in
  // (owner, 2026-11-09): both open it, so both are named.
  const word = passcode ? (status.passwordless ? 'passcode' : 'passcode or account password') : 'password'

  useEffect(() => {
    field.current?.focus()
  }, [])

  const touchId = (): void => {
    const call = cookrew().accountUnlockTouchId
    if (!call || busy) return
    setBusy(true)
    void call()
      .then((answer) => {
        if (answer.ok) onUnlocked(status.requests)
      })
      .catch((err: unknown) => console.error('touch id:', err))
      .finally(() => setBusy(false))
  }

  const spendRescue = (): void => {
    const call = cookrew().accountRescueUnlock
    if (!call || busy || rescue === null || rescue === '') return
    setBusy(true)
    setRescueError(null)
    void call(rescue)
      .then((result) => {
        if (result.ok) onUnlocked(status.requests)
        else setRescueError(providerRefusal(result.reason, result.message))
      })
      .catch(() => setRescueError('That did not go through. Try again.'))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    if (status.requests <= 0) {
      setNames([])
      return
    }
    const call = cookrew().accountApprovals
    if (!call) return
    let live = true
    void call()
      .then((list) => {
        if (live) setNames(list.map((request) => request.deviceName))
      })
      // A list that cannot be read leaves the count-only sentence, which is
      // still true. A lock that stayed silent because a fetch failed would
      // hide the one thing the owner came back to answer.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [status.requests])

  const unlock = (): void => {
    const call = cookrew().accountUnlock
    if (!call || busy || password.length === 0) return
    setBusy(true)
    void call(password)
      .then((answer) => {
        setBusy(false)
        setOutcome(answer)
        setPassword('')
        if (answer.ok) onUnlocked(status.requests)
      })
      .catch((err: unknown) => {
        setBusy(false)
        console.error('unlock:', err)
      })
  }

  const username = status.username ?? ''
  const waiting: LockWaiting = { count: status.requests, names }
  // D8: a Mac that joined by a code is meeting its password for the first
  // time here, and the opening line has to say why it is being asked at all.
  const note = lockNote(outcome, waiting, status.passwordPending)
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
          {note.line}
        </p>
        {note.waiting && (
          <p className="gs-sub cr-acct-lock-waiting" role="status">
            {note.waiting}
          </p>
        )}
        <input
          ref={field}
          type="password"
          className="gs-input"
          aria-label={passcode ? 'Passcode' : 'Password'}
          placeholder={word}
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && unlock()}
        />
        <button className="gs-primary" disabled={busy || password.length === 0} onClick={unlock}>
          UNLOCK
        </button>
        {status.touchId?.on && (
          <button className="gs-ghost" disabled={busy} onClick={touchId}>
            USE TOUCH ID
          </button>
        )}
        {passcode && rescue === null && (
          <button className="gs-ghost" onClick={() => setRescue('')}>
            {PROVIDER_COPY.CHOSEN_PASSCODE_FORGOT}
          </button>
        )}
        {rescue !== null && (
          <>
            <p className="gs-sub">
              {status.passwordless
                ? PROVIDER_COPY.CHOSEN_PASSCODE_RESCUE_WHY_NO_PASSWORD
                : PROVIDER_COPY.CHOSEN_PASSCODE_RESCUE_WHY}
            </p>
            <input
              className="gs-input"
              aria-label="Recovery code"
              placeholder="recovery code"
              autoComplete="off"
              value={rescue}
              onChange={(e) => setRescue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && spendRescue()}
            />
            {rescueError && (
              <p className="gs-paste-error" role="alert">
                {rescueError}
              </p>
            )}
            <button className="gs-ghost" disabled={busy || rescue === ''} onClick={spendRescue}>
              USE THIS CODE
            </button>
          </>
        )}
      </div>
    </div>
  )
}
