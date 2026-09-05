import { useEffect, useRef, useState } from 'react'
import type { AccountStatus, UsernameCheck } from '../../../shared/account-v2'
import { cookrew } from '../api'
import {
  ACCOUNT_COPY,
  claimView,
  migrateView,
  refusalSentence,
  type ClaimFields,
} from './account-store'
import '../grant-surface.css'

/**
 * CLAIM A USERNAME (D2) — one column, in the order a person thinks.
 *
 * The name, then the thing that protects it. The primary is disabled until
 * both lines are green and THE REASON IS ALWAYS WRITTEN NEXT TO THE FIELD: a
 * disabled button with no sentence beside it is a screen refusing to say what
 * is wrong, which is the failure this sheet is drawn to avoid.
 *
 * AVAILABILITY IS NEVER GUESSED. The check debounces, and a registry that does
 * not answer leaves the primary down with the registry-down sentence. Guessing
 * "free" would produce an enabled button and a refused submission.
 *
 * NOT NOW keeps everything local, and says so.
 *
 * PHASE 6 — THE SAME SHEET, MINUS THE CHOICE. On a Mac that already serves
 * under a handle (a key in ~/.cookrew/registry, no account), the name is not
 * up for discussion: it is the one the doors are published under, and the
 * only thing missing is a password. So the username line becomes a statement
 * and the primary sets the password on the name that is already there.
 */

/** Long enough that a typist is not checking on every letter. */
const DEBOUNCE_MS = 350

export function ClaimSheet({
  onClose,
  onClaimed,
  legacy = null,
}: {
  onClose: () => void
  onClaimed: (status: AccountStatus) => void
  /** The handle this Mac held before passwords, when it has one (phase 6). */
  legacy?: { handle: string } | null
}): React.JSX.Element {
  const [fields, setFields] = useState<ClaimFields>({
    username: '',
    check: 'invalid',
    password: '',
    confirm: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  // The first field, never the primary — the same rule the import sheet keeps.
  useEffect(() => {
    field.current?.focus()
  }, [])

  const typed = fields.username
  useEffect(() => {
    const check = cookrew().accountCheck
    // A name that is already ours is never checked for availability: the
    // answer would be "taken", about us, and the primary would go down.
    if (!check || legacy) return
    const name = typed.trim().replace(/^@+/, '')
    if (name.length === 0) {
      setFields((prior) => ({ ...prior, check: 'invalid' }))
      return
    }
    setFields((prior) => ({ ...prior, check: 'checking' }))
    let live = true
    const timer = window.setTimeout(() => {
      void check(name)
        .then((answer: UsernameCheck) => {
          // A late answer for a name that is no longer typed must not decide
          // anything — the sheet would say "taken" about a different name.
          if (live)
            setFields((prior) => (prior.username === typed ? { ...prior, check: answer } : prior))
        })
        .catch(() => {
          if (live) setFields((prior) => ({ ...prior, check: 'unknown' }))
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [typed])

  const crossing = legacy === null ? null : migrateView(fields, legacy.handle)
  const view = claimView(fields)
  const primary = crossing?.primary ?? view.primary
  const canGo = crossing === null ? view.canClaim : crossing.canClaim
  const password = crossing?.password ?? view.password
  const confirm = crossing?.confirm ?? view.confirm

  const claim = (): void => {
    if (busy || !canGo) return
    // Two calls, one button: a name being taken for the first time, or a
    // password being set on one this Mac already answers to. Main decides
    // nothing from the renderer here — the migration carries no username.
    const asked =
      legacy === null
        ? cookrew().accountClaim?.({
            username: fields.username.trim().replace(/^@+/, ''),
            password: fields.password,
          })
        : cookrew().accountMigrate?.({ password: fields.password })
    if (!asked) return
    setBusy(true)
    setError(null)
    void asked
      .then((result) => {
        setBusy(false)
        if (result.ok) onClaimed(result.value)
        else {
          const about = legacy?.handle ?? fields.username
          setError(refusalSentence(result.reason, result.message, about))
        }
      })
      .catch((err: unknown) => {
        setBusy(false)
        // NEVER THE RAW MESSAGE: what reaches here is an IPC rejection, which
        // tells a person nothing while implying they broke something.
        console.error('claim sheet:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  return (
    <div
      className="gs-scrim cr-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={legacy === null ? 'Claim a username' : 'Set a password'}
    >
      <div
        className="gs-sheet gs-small cr-acct-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>{legacy === null ? 'Claim a username' : 'Set a password'}</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {crossing === null ? (
          <>
            <label className="gs-label" htmlFor="cr-acct-username">
              Username
            </label>
            <div className="cr-acct-row">
              <input
                id="cr-acct-username"
                ref={field}
                className={`gs-input${view.username.tone === 'bad' ? ' gs-bad' : ''}`}
                value={fields.username}
                spellCheck={false}
                autoComplete="off"
                placeholder="@drej"
                onChange={(e) => setFields((prior) => ({ ...prior, username: e.target.value }))}
              />
              <span className={`cr-acct-tag cr-acct-${view.username.tone}`}>
                {view.username.tag}
              </span>
            </div>
            <p className={`gs-hint cr-acct-${view.username.tone}`}>{view.username.note}</p>
          </>
        ) : (
          <>
            <label className="gs-label">Username</label>
            <div className="cr-acct-row">
              <input
                id="cr-acct-username"
                className="gs-input"
                value={`@${legacy?.handle ?? ''}`}
                readOnly
                spellCheck={false}
                aria-readonly="true"
              />
              <span className="cr-acct-tag cr-acct-good">yours ✓</span>
            </div>
            <p className="gs-hint cr-acct-good">{crossing.lead}</p>
          </>
        )}

        <label className="gs-label" htmlFor="cr-acct-password">
          Password
        </label>
        <div className="cr-acct-row">
          <input
            id="cr-acct-password"
            type="password"
            // The first field either way: on a Mac with a name already, the
            // password IS the first field, so the focus follows it there.
            ref={legacy === null ? undefined : field}
            className={`gs-input${password.tone === 'bad' ? ' gs-bad' : ''}`}
            value={fields.password}
            autoComplete="new-password"
            onChange={(e) => setFields((prior) => ({ ...prior, password: e.target.value }))}
          />
          <span className={`cr-acct-tag cr-acct-${password.tone}`}>{password.tag}</span>
        </div>
        <p className={`gs-hint cr-acct-${password.tone}`}>{password.note}</p>

        <div className="cr-acct-row">
          <input
            type="password"
            aria-label="Repeat the password"
            className={`gs-input${confirm.tone === 'bad' ? ' gs-bad' : ''}`}
            value={fields.confirm}
            autoComplete="new-password"
            onChange={(e) => setFields((prior) => ({ ...prior, confirm: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && claim()}
          />
          <span className={`cr-acct-tag cr-acct-${confirm.tone}`}>{confirm.tag}</span>
        </div>
        {confirm.note.length > 0 && (
          <p className={`gs-hint cr-acct-${confirm.tone}`}>{confirm.note}</p>
        )}

        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}

        <div className="gs-sheet-foot">
          <button className="gs-ghost" onClick={onClose}>
            NOT NOW
          </button>
          <button className="gs-primary" disabled={!canGo || busy} onClick={claim}>
            {primary}
          </button>
        </div>
        <p className="gs-foot-note">
          {legacy === null ? ACCOUNT_COPY.NOT_NOW : ACCOUNT_COPY.LEGACY_KEEP_SERVING}
        </p>
      </div>
    </div>
  )
}
