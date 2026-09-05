import { useEffect, useState } from 'react'
import { LOCK_CHOICES } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY, lockRowLabel, refusalSentence, rescueState } from './account-store'
import '../grant-surface.css'

/**
 * THE SECURITY CARD (D3) — shown once right after claiming, and again from
 * Profile → Security.
 *
 * Each row is a single action with its state. Two of them are INERT and both
 * SAY SO AND LOOK IT: passkeys and the authenticator app are the phase 4
 * ladder. A row that reads exactly like the live ones and does nothing when
 * clicked costs the whole card its claim to be telling the truth — so COMING
 * is muted and its badge is dashed, the same "not filled in yet" the empty
 * avatar uses.
 *
 * THE LOCK IS REACHABLE, not just configurable. Setting a delay and having no
 * way to lock now is a lock you can only meet by walking away from the desk.
 */

/** Nobody dismisses the codes by reflex: the primary waits five seconds. */
const CODES_SETTLE_MS = 5_000

function Row({
  kind,
  label,
  state,
  action,
  coming = false,
  saved = false,
}: {
  kind: string
  label: string
  state?: string
  action: React.ReactNode
  /** Phase 4: drawn muted, with a dashed badge, so it cannot be mistaken. */
  coming?: boolean
  saved?: boolean
}): React.JSX.Element {
  return (
    <li className={`cr-acct-secrow${coming ? ' cr-acct-coming' : ''}`}>
      <span className="cr-acct-kind">{kind}</span>
      <span className="cr-acct-seclabel">{label}</span>
      {state && (
        <span className={`cr-acct-secstate${coming ? ' cr-acct-soon' : ''}`}>
          {saved && <span aria-hidden="true">✓ </span>}
          {state}
        </span>
      )}
      {action}
    </li>
  )
}

export function SecurityCard({
  username,
  lockAfterMs,
  recoveryCodesSavedAt,
  recoveryCodesLeft = null,
  onLockAfterMs,
  onLockNow,
  onCodesSaved,
}: {
  username: string
  lockAfterMs: number
  recoveryCodesSavedAt: number | null
  recoveryCodesLeft?: number | null
  onLockAfterMs: (ms: number) => void
  onLockNow: () => void
  onCodesSaved: () => void
}): React.JSX.Element {
  const [codes, setCodes] = useState<readonly string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (codes === null) return
    setSettled(false)
    const timer = window.setTimeout(() => setSettled(true), CODES_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [codes])

  const show = (): void => {
    const call = cookrew().accountRecoveryCodes
    if (!call) return
    setError(null)
    void call()
      .then((result) => {
        if (result.ok) setCodes(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        console.error('recovery codes:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  /** SAVE AS FILE. Main owns the dialog and the codes; this only asks. */
  const saveAsFile = (): void => {
    const call = cookrew().accountSaveRecoveryCodes
    if (!call) return
    setError(null)
    void call()
      .then((result) => {
        if (result.ok) {
          onCodesSaved()
          setCodes(null)
          return
        }
        // Cancelling a save dialog is a decision, not a failure to report.
        if (result.reason !== 'cancelled') setError('Could not write that file. Try another place.')
      })
      .catch((err: unknown) => {
        console.error('save recovery codes:', err)
        setError('Something went wrong on this side. Try again.')
      })
  }

  const putAway = (): void => {
    onCodesSaved()
    setCodes(null)
  }

  if (codes !== null) {
    return (
      <section className="cr-acct-card" aria-label="Recovery codes">
        <h3 className="cr-acct-cardhead">
          Recovery codes <span className="gs-dim">{ACCOUNT_COPY.CODES_EACH}</span>
        </h3>
        {/* Rendered, never logged. A console.log of these is the account. */}
        <ul className="cr-acct-codes">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}
        <div className="gs-sheet-foot">
          <button
            className="gs-ghost"
            onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}
          >
            COPY
          </button>
          <button className="gs-ghost" onClick={saveAsFile}>
            SAVE AS FILE
          </button>
          <button className="gs-primary" disabled={!settled} onClick={putAway}>
            I SAVED THEM
          </button>
        </div>
      </section>
    )
  }

  const rescue = rescueState(recoveryCodesSavedAt, recoveryCodesLeft)
  return (
    <section className="cr-acct-card" aria-label="Security">
      <h3 className="cr-acct-cardhead">
        @{username} is yours <span className="gs-dim">protect it</span>
      </h3>
      <ul className="cr-acct-secrows">
        <Row
          kind="FACTOR"
          label="Add a passkey (Touch ID)"
          state="COMING"
          coming
          action={
            <button className="gs-ghost" disabled title="Phase 4">
              ADD
            </button>
          }
        />
        <Row
          kind="FACTOR"
          label="Add an authenticator app"
          state="COMING"
          coming
          action={
            <button className="gs-ghost" disabled title="Phase 4">
              ADD
            </button>
          }
        />
        <Row
          kind="RESCUE"
          label="Save your recovery codes"
          state={rescue.label}
          saved={rescue.saved}
          action={
            <button className="gs-primary" onClick={show}>
              {rescue.saved ? 'SHOW NEW' : 'SHOW'}
            </button>
          }
        />
        <Row
          kind="LOCK"
          label={lockRowLabel(lockAfterMs)}
          action={
            <select
              className="cr-acct-select"
              aria-label="Lock after idle"
              value={String(lockAfterMs)}
              onChange={(e) => onLockAfterMs(Number(e.target.value))}
            >
              {LOCK_CHOICES.map((choice) => (
                <option key={choice.ms} value={String(choice.ms)}>
                  {choice.label}
                </option>
              ))}
            </select>
          }
        />
        <Row
          kind="LOCK"
          label="Lock this Mac now"
          action={
            <button className="gs-ghost" onClick={onLockNow}>
              LOCK NOW
            </button>
          }
        />
      </ul>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <p className="gs-foot-note">{ACCOUNT_COPY.LOCK_NOW_WHY}</p>
      <p className="gs-foot-note">{ACCOUNT_COPY.SECURITY_WHY}</p>
    </section>
  )
}
