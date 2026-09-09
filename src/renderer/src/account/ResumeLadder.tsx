import { useEffect, useRef, useState } from 'react'
import {
  ladderIsOver,
  type AccountStatus,
  type LadderFactor,
  type SecondFactorStep,
} from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY } from './account-store'
import { DOING, problemSentence, refusedSentence } from './problem'

/**
 * ONE MORE STEP, AND SOMEWHERE TO TAKE IT.
 *
 * The card above this one asked for the password and cookrew.dev answered 401
 * `second_factor`: the account has an authenticator, or a phone that could
 * approve, or codes in a drawer. The live bug is that the card stopped there —
 * it printed the registry's "One more step. Prove it is you." and offered no
 * step, which on the only Mac of an account means no relay line, no reach and
 * a door that reads offline, with nothing on screen to press.
 *
 * SO THE RUNGS ARE HERE, IN THE SAME CARD. Nothing is hidden abruptly: the
 * sentence stays, the field for the commonest rung is already open, and the
 * other ways are one button each rather than a menu to find.
 *
 * NO PASSKEY RUNG, DELIBERATELY. webauthn.ts owns the assertion/attestation
 * translation for ENROLMENT only (`toCreationOptions`, `fromCredential`) —
 * there is no `get()` path in it, and this build measured
 * `isUserVerifyingPlatformAuthenticatorAvailable()` as FALSE on this Electron
 * anyway. A PASSKEY button that raised the OS security-key dialog and then
 * failed would be a rung nobody can stand on, which is worse than a shorter
 * ladder (the registry's own rule in v2-factor-routes.ts). When webauthn.ts
 * grows an assertion, this is the one place that adds the row.
 *
 * THE PASSWORD IS NOT HERE. Main is holding it for the length of the ladder
 * (account-ladder.ts); these calls carry the pending id and a typed code, so
 * nothing on this side is the custodian of a secret across a ten-minute poll.
 */

/** Which field is on screen. 'approve' is a button and a wait, not a field. */
type Rung = 'totp' | 'recovery' | 'approve'

/** The rung to open on: the account's best typed one, else the wait. */
function firstRung(next: readonly LadderFactor[]): Rung {
  if (next.includes('totp')) return 'totp'
  if (next.includes('recovery')) return 'recovery'
  return 'approve'
}

const FIELD = {
  totp: {
    label: ACCOUNT_COPY.LADDER_TOTP_LABEL,
    hint: ACCOUNT_COPY.LADDER_TOTP_HINT,
    placeholder: '123456',
    maxLength: 6,
    inputMode: 'numeric' as const,
  },
  recovery: {
    label: ACCOUNT_COPY.LADDER_RECOVERY_LABEL,
    hint: ACCOUNT_COPY.LADDER_RECOVERY_HINT,
    placeholder: 'ABCD-EFGH',
    maxLength: 20,
    inputMode: 'text' as const,
  },
}

export function ResumeLadder({
  step,
  lede,
  onSignedIn,
  onOver,
}: {
  step: SecondFactorStep
  /** The registry's own sentence for this step, when it sent one. */
  lede: string
  onSignedIn: (status: AccountStatus) => void
  /** The ladder is finished and the password step is the way back. */
  onOver: (sentence: string) => void
}): React.JSX.Element {
  const [rung, setRung] = useState<Rung>(() => firstRung(step.next))
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [asked, setAsked] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  /**
   * A card that closed while a rung was in flight must not answer into a
   * component the document no longer holds — the approve rung's wait can be
   * minutes long, and the owner may well have gone to their phone and back.
   */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  /** Every rung ends the same three ways, so it is written once. */
  const settle = (result: {
    ok: boolean
    value?: AccountStatus
    reason?: Parameters<typeof ladderIsOver>[0]
    message?: string
  }): void => {
    if (!live.current) return
    setBusy(false)
    if (result.ok && result.value) {
      onSignedIn(result.value)
      return
    }
    const reason = result.reason ?? 'unknown'
    const sentence = refusedSentence(DOING.RESUME, { reason, ...(result.message ? { message: result.message } : {}) })
    // A wrong code leaves the field open — the registry allows five tries and
    // a card that closed on the first fat-fingered digit spends the other four
    // on nothing. A pending that is gone sends the owner back to the password.
    if (ladderIsOver(reason)) onOver(sentence)
    else setSaid(sentence)
  }

  const failed = (error: unknown): void => {
    if (!live.current) return
    setBusy(false)
    setSaid(problemSentence(DOING.RESUME, error))
  }

  const verify = (): void => {
    const call = cookrew().accountResumeCode
    if (!call || busy || code.trim().length === 0 || rung === 'approve') return
    setBusy(true)
    setSaid(null)
    void call({ pending: step.pending, factor: rung, code: code.trim() })
      .then((result) => {
        if (live.current) setCode('')
        settle(result)
      })
      .catch(failed)
  }

  const ask = (): void => {
    const request = cookrew().accountResumeAsk
    const wait = cookrew().accountResumeWait
    if (!request || !wait || busy) return
    setBusy(true)
    setSaid(null)
    void request(step.pending)
      .then((out) => {
        if (!live.current) return
        setBusy(false)
        if (!out.ok) {
          settle(out)
          return
        }
        setRung('approve')
        setAsked(true)
        setSaid(ACCOUNT_COPY.LADDER_ASKED)
        // The wait is one long call rather than a timer here: main polls on
        // the two-second interval cookrew.dev's own waiting screen uses, and
        // this side simply drops the promise if the card closes.
        void wait(step.pending).then(settle).catch(failed)
      })
      .catch(failed)
  }

  const other: Rung | null =
    rung === 'totp' && step.next.includes('recovery')
      ? 'recovery'
      : rung !== 'totp' && step.next.includes('totp')
        ? 'totp'
        : rung === 'approve' && step.next.includes('recovery')
          ? 'recovery'
          : null
  const field = rung === 'approve' ? null : FIELD[rung]

  return (
    <div className="cr-acct-ladder">
      <p className="gs-consequence">{lede}</p>
      {field && (
        <>
          <label className="gs-label" htmlFor="cr-acct-ladder-code">
            {field.label}
          </label>
          <div className="cr-acct-row">
            <input
              id="cr-acct-ladder-code"
              className="gs-input"
              aria-label={field.label}
              inputMode={field.inputMode}
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
            />
            <button
              className="gs-primary"
              disabled={busy || code.trim().length === 0}
              onClick={verify}
            >
              VERIFY
            </button>
          </div>
          <p className="gs-hint">{field.hint}</p>
        </>
      )}
      <div className="cr-acct-row cr-acct-ladder-ways">
        {other !== null && (
          <button
            className="gs-ghost"
            disabled={busy}
            onClick={() => {
              setCode('')
              setSaid(null)
              setRung(other)
            }}
          >
            {other === 'recovery' ? 'Use a recovery code' : 'Use the authenticator'}
          </button>
        )}
        {step.next.includes('approve') && !asked && (
          <button className="gs-ghost" disabled={busy} onClick={ask}>
            {ACCOUNT_COPY.LADDER_ASK}
          </button>
        )}
      </div>
      {said && (
        <p className="gs-paste-error" role="alert">
          {said}
        </p>
      )}
    </div>
  )
}
