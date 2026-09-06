import { useEffect, useState } from 'react'
import { APPROVAL_COPY, type TotpEnrolment } from '../../../shared/account-approvals'
import { cookrew } from '../api'
import { refusalSentence } from './account-store'
import { DOING, problemSentence } from './problem'
import { QrCode } from './QrCode'
import '../grant-surface.css'

/**
 * ADDING AN AUTHENTICATOR APP (D3) — a QR, the same secret as text, and a
 * code back.
 *
 * THE SECRET IS SHOWN AS TEXT as well as as a QR, deliberately. The phone
 * that would scan it is often the phone the app is being added to, or the
 * camera cannot see the screen, or the person keeps their codes in a password
 * manager on the same machine — every one of those is a normal way to enrol,
 * and a QR-only sheet quietly excludes all of them.
 *
 * IT IS NOT A FACTOR UNTIL A CODE COMES BACK. The sheet cannot close itself
 * into "ACTIVE" on the strength of having shown a secret: the registry
 * confirms, or the row stays as it was. Anything else is an owner who thinks
 * they have a second way in.
 */

/** Six digits, as the field allows and the primary waits for. */
const SIX = /^[0-9]{6}$/

export function TotpSheet({
  username,
  onClose,
  onActive,
}: {
  username: string
  onClose: () => void
  onActive: () => void
}): React.JSX.Element {
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const call = cookrew().accountTotpEnrol
    if (!call) return
    void call()
      .then((result) => {
        if (result.ok) setEnrolment(result.value)
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => setError(problemSentence(DOING.TOTP_ENROL, err)))
  }, [username])

  const confirm = (): void => {
    const call = cookrew().accountTotpConfirm
    if (!call || busy || !SIX.test(code)) return
    setBusy(true)
    setError(null)
    void call(code)
      .then((result) => {
        setBusy(false)
        if (result.ok) onActive()
        else setError(refusalSentence(result.reason, result.message, username))
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(problemSentence(DOING.TOTP_CONFIRM, err))
      })
  }

  return (
    <div
      className="gs-scrim cr-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Add an authenticator app"
    >
      <div
        className="gs-sheet gs-small cr-sheet cr-acct-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Authenticator app</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="gs-sub">{APPROVAL_COPY.TOTP_HOW}</p>
        {enrolment && (
          <>
            <QrCode rows={enrolment.qr} label="Scan this with your authenticator app" />
            {/* Shown, never logged — the same rule as the recovery codes. */}
            <p className="cr-acct-secret">{enrolment.secret}</p>
          </>
        )}

        <label className="gs-label" htmlFor="cr-acct-totp">
          Code from the app
        </label>
        <input
          id="cr-acct-totp"
          className="gs-input"
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
        />
        <p className="gs-hint">{APPROVAL_COPY.TOTP_CODE_RULE}</p>

        {error && (
          <p className="gs-paste-error" role="alert">
            {error}
          </p>
        )}

        <div className="gs-sheet-foot">
          <button className="gs-ghost" onClick={onClose}>
            NOT NOW
          </button>
          <button
            className="gs-primary"
            disabled={busy || enrolment === null || !SIX.test(code)}
            onClick={confirm}
          >
            CONFIRM
          </button>
        </div>
      </div>
    </div>
  )
}
