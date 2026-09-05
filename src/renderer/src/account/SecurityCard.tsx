import { useEffect, useState } from 'react'
import { DEFAULT_LOCK_AFTER_MS } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY, refusalSentence } from './account-store'
import '../grant-surface.css'

/**
 * THE SECURITY CARD (D3) — shown once right after claiming, and again from
 * Profile → Security.
 *
 * Four rows, each a single action with its state. Two of them are INERT and
 * say so: passkeys and the authenticator app are the phase 4 ladder, and a
 * button that opens nothing is worse than a row that admits it is coming —
 * the person clicks it, nothing happens, and the whole card loses its claim
 * to be telling them the truth about their account.
 *
 * The recovery codes are the one factor this phase can actually give, and the
 * idle lock is the one it can actually enforce.
 */

/** Nobody dismisses the codes by reflex: the primary waits five seconds. */
const CODES_SETTLE_MS = 5_000

function Row({
  kind,
  label,
  state,
  action,
}: {
  kind: string
  label: string
  state?: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="cr-acct-secrow">
      <span className="cr-acct-kind">{kind}</span>
      <span className="cr-acct-seclabel">{label}</span>
      {state && <span className="cr-acct-secstate">{state}</span>}
      {action}
    </li>
  )
}

export function SecurityCard({
  username,
  lockAfterMs,
  onLockAfterMs,
}: {
  username: string
  lockAfterMs: number
  onLockAfterMs: (ms: number) => void
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
        <div className="gs-sheet-foot">
          <button
            className="gs-ghost"
            onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}
          >
            COPY
          </button>
          <button className="gs-primary" disabled={!settled} onClick={() => setCodes(null)}>
            I SAVED THEM
          </button>
        </div>
      </section>
    )
  }

  const lockOn = lockAfterMs > 0
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
          action={
            <button className="gs-ghost" disabled title="Phase 4">
              ADD
            </button>
          }
        />
        <Row
          kind="RESCUE"
          label="Save your recovery codes"
          state="NOT SAVED"
          action={
            <button className="gs-primary" onClick={show}>
              SHOW
            </button>
          }
        />
        <Row
          kind="LOCK"
          label="Lock Cookrew after 15 min idle"
          action={
            <button
              className={`gs-ghost${lockOn ? ' on' : ''}`}
              aria-pressed={lockOn}
              onClick={() => onLockAfterMs(lockOn ? 0 : DEFAULT_LOCK_AFTER_MS)}
            >
              {lockOn ? 'ON' : 'OFF'}
            </button>
          }
        />
      </ul>
      {error && (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      )}
      <p className="gs-foot-note">{ACCOUNT_COPY.SECURITY_WHY}</p>
    </section>
  )
}
