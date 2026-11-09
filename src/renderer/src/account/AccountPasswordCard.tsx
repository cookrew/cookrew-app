import { useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { PROVIDER_COPY, firstPasswordView, providerRefusal } from './provider-store'
import '../grant-surface.css'

/**
 * SET YOUR ACCOUNT PASSWORD — what a new machine of a provider-only account is
 * asked, once (owner, 2026-11-09). There is no separate passcode: the account
 * password locks Cookrew here and lets a phone into the account's machines, so
 * this is the same first-password path as the security card (a provider trip
 * only when cookrew.dev asks for one), and the result is this machine's lock.
 *
 * Never shown on a machine signed in from a terminal (`cookrew login`): nobody
 * can type at its screen. LATER leaves the lock off until a password exists.
 */
export function AccountPasswordCard({
  status,
  onDone,
  onLater
}: {
  status: AccountStatus
  onDone: (next: AccountStatus) => void
  onLater: () => void
}): React.JSX.Element {
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = firstPasswordView(next, confirm)

  const save = (): void => {
    const call = cookrew().accountSetPassword
    if (!call || busy || !view.canGo) return
    setBusy(true)
    setError(null)
    void call({ current: '', next })
      .then(async (result) => {
        if (!result.ok) {
          setError(providerRefusal(result.reason, result.message))
          return
        }
        const refreshed = await cookrew().accountStatus?.()
        if (refreshed) onDone(refreshed)
      })
      .catch(() => setError('The password could not be set. Try again.'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label={PROVIDER_COPY.ACCOUNT_PASSWORD_TITLE}>
      <div className="gs-sheet gs-small cr-sheet cr-acct-sheet">
        <header className="gs-sheet-head">
          <h2>{PROVIDER_COPY.ACCOUNT_PASSWORD_TITLE}</h2>
        </header>
        <p className="gs-hint">{PROVIDER_COPY.ACCOUNT_PASSWORD_WHY}</p>
        <p className="gs-hint">Signed in as @{status.username}.</p>
        <div className="cr-acct-providers">
          <input
            type="password"
            className="gs-input"
            aria-label="New account password"
            placeholder="new account password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            type="password"
            className="gs-input"
            aria-label="New account password again"
            placeholder="new account password again"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </div>
        {next.length > 0 && view.note !== '' && <p className="gs-hint">{view.note}</p>}
        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}
        <div className="gs-sheet-foot">
          <button className="gs-ghost" disabled={busy} onClick={onLater}>
            LATER
          </button>
          <button className="gs-primary" disabled={busy || !view.canGo} onClick={save}>
            SET PASSWORD
          </button>
        </div>
        <p className="gs-foot-note">{PROVIDER_COPY.ACCOUNT_PASSWORD_LATER}</p>
      </div>
    </div>
  )
}
