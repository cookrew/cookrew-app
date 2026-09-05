import { useState } from 'react'
import { MIN_PASSWORD, passwordStrength } from '../../../shared/account-v2'
import { APPROVAL_COPY } from '../../../shared/account-approvals'
import { cookrew } from '../api'
import { ACCOUNT_COPY, refusalSentence } from './account-store'
import '../grant-surface.css'

/**
 * SET A NEW PASSWORD — the second half of "not me" (D6).
 *
 * The registry ends every other session and marks the account
 * `mustChangePassword`; this is where the owner finishes the job. It is a
 * BANNER AND A FORM, not a lock: the person is at their own Mac, already
 * unlocked, and shutting them out of their canvas to enforce a password
 * change would be the app punishing the victim of the thing it just
 * protected them from.
 *
 * The CURRENT password is still required. "Not me" means someone else was
 * trying to get in — it does not mean this Mac gets to change the account's
 * password without proving it knows the old one, because this Mac is exactly
 * what an attacker would be sitting at if they had got that far.
 */
export function NewPasswordCard({
  username,
  onDone,
}: {
  username: string
  onDone: () => void
}): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const strong = next.length >= MIN_PASSWORD
  const ready = current.length > 0 && strong && !busy

  const submit = (): void => {
    const call = cookrew().accountSetPassword
    if (!call || !ready) return
    setBusy(true)
    setError(null)
    void call({ current, next })
      .then((result) => {
        setBusy(false)
        if (!result.ok) {
          setError(refusalSentence(result.reason, result.message, username))
          return
        }
        setCurrent('')
        setNext('')
        onDone()
      })
      .catch(() => {
        setBusy(false)
        setError('Something went wrong on this side. Try again.')
      })
  }

  return (
    <section className="cr-acct-card cr-acct-mustchange" aria-label="Set a new password">
      <h3 className="cr-acct-cardhead">{APPROVAL_COPY.MUST_CHANGE}</h3>

      <label className="gs-label" htmlFor="cr-acct-current">
        Current password
      </label>
      <input
        id="cr-acct-current"
        type="password"
        className="gs-input"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />

      <label className="gs-label" htmlFor="cr-acct-next">
        New password
      </label>
      <div className="cr-acct-row">
        <input
          id="cr-acct-next"
          type="password"
          className={`gs-input${next.length > 0 && !strong ? ' gs-bad' : ''}`}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <span className={`cr-acct-tag cr-acct-${strong ? 'good' : 'bad'}`}>
          {next.length === 0 ? '' : passwordStrength(next)}
        </span>
      </div>
      <p className={`gs-hint${next.length > 0 && !strong ? ' cr-acct-bad' : ''}`}>
        {next.length > 0 && !strong ? ACCOUNT_COPY.PASSWORD_WEAK : ACCOUNT_COPY.PASSWORD_RULE}
      </p>

      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}

      <div className="gs-sheet-foot">
        <button className="gs-primary" disabled={!ready} onClick={submit}>
          SET A NEW PASSWORD
        </button>
      </div>
    </section>
  )
}
