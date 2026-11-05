import { useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { PROVIDER_COPY, passcodeView, providerRefusal } from './provider-store'
import '../grant-surface.css'

/**
 * NO PASSWORD WAS TYPED HERE, SO THE LOCK NEEDS SOMETHING ELSE.
 *
 * A passcode is this Mac's alone: it goes to main and stops there. LATER is
 * honest about what it means, because until there is a passcode there is
 * nothing to check, and the idle lock stays off rather than shutting the owner
 * out of their own canvas.
 */
export function PasscodeCard({
  status,
  onDone,
  onLater,
}: {
  status: AccountStatus
  onDone: (next: AccountStatus) => void
  onLater: () => void
}): React.JSX.Element {
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = passcodeView(next, confirm)

  const save = (): void => {
    const call = cookrew().accountSetPasscode
    if (!call || busy || !view.canGo) return
    setBusy(true)
    setError(null)
    void call({ next })
      .then((result) => {
        if (result.ok) onDone(result.value)
        else setError(providerRefusal(result.reason, result.message))
      })
      .catch(() => setError('That could not be saved on this Mac. Try again.'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label={PROVIDER_COPY.PASSCODE_TITLE}>
      <div className="gs-sheet gs-small cr-sheet cr-acct-sheet">
        <header className="gs-sheet-head">
          <h2>{PROVIDER_COPY.PASSCODE_TITLE}</h2>
        </header>
        <p className="gs-hint">{PROVIDER_COPY.PASSCODE_LOCAL}</p>
        <p className="gs-hint">Signed in as @{status.username}.</p>
        <div className="cr-acct-providers">
        <input
          type="password"
          className="gs-input"
          aria-label="Passcode"
          placeholder="passcode"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          type="password"
          className="gs-input"
          aria-label="Passcode again"
          placeholder="passcode again"
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
            SET PASSCODE
          </button>
        </div>
        <p className="gs-foot-note">{PROVIDER_COPY.PASSCODE_LATER}</p>
      </div>
    </div>
  )
}
