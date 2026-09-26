import { useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import { cookrew } from '../api'
import { ACCOUNT_COPY, joinRefusalSentence } from './account-store'
import { DOING, problemSentence } from './problem'
import '../grant-surface.css'

/**
 * A JOIN CODE ARRIVED (D8) — one card, one act, and it spends the code.
 *
 * Two doors reach it and they are the same ceremony: `cookrew://join#<code>`
 * handed over by the OS, and the code typed into the first-run card. Neither
 * spends anything until JOIN is pressed, because a link that attached a
 * machine on arrival would be a link anybody could send.
 *
 * WHAT IT MAY SAY IS LESS THAN THE MOCK DRAWS, and the difference is the
 * point. The mock heads it "JOIN @DREJ ON THIS MAC?" and dates the code —
 * neither fact is on this Mac. The link carries eight characters; the
 * account's name arrives in the registry's 201 and not before, because the
 * mint and the redeem answer a stranger the same 401 whatever they guessed.
 * So the card says what it can prove and the handle appears on the avatar the
 * moment it is true. See ACCOUNT_COPY.JOIN_TITLE.
 *
 * THE CODE IS DEAD WHATEVER HAPPENS NEXT — the registry spends it before it
 * looks at the device (v2-join.ts). So a refusal is never "press it again":
 * the sentence for a spent code names the only next step there is, which is
 * another code from the device that has one.
 */
export function JoinCard({
  code,
  onJoined,
  onDismiss,
}: {
  /** `XXXX-XXXX`, already normalised by the parser or the field. */
  code: string
  onJoined: (status: AccountStatus) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const join = (): void => {
    const call = cookrew().accountJoin
    if (!call || busy) return
    setBusy(true)
    setError(null)
    void call({ code })
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          onJoined(result.value)
          return
        }
        setError(joinRefusalSentence(result.reason, result.message))
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(problemSentence(DOING.JOIN, err))
      })
  }

  return (
    <section className="gs-sheet gs-small cr-sheet cr-acct-firstrun" aria-label={ACCOUNT_COPY.JOIN_TITLE}>
      <header className="gs-sheet-head">
        <h2 className="cr-acct-cardhead">{ACCOUNT_COPY.JOIN_TITLE}</h2>
        <button className="gs-x" onClick={onDismiss} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="gs-consequence">{ACCOUNT_COPY.JOIN_LEDE}</p>
      {/* The code is SHOWN, not editable: a person who typed it has already
          checked it, and a person who followed a link never saw it. Changing
          it here would be a second field for the same value. */}
      <p className="cr-acct-joincode">{code}</p>
      <div className="gs-sheet-foot cr-acct-firstrun-foot">
        <button className="gs-ghost" onClick={onDismiss} disabled={busy}>
          NOT NOW
        </button>
        <button className="gs-primary" onClick={join} disabled={busy}>
          {ACCOUNT_COPY.JOIN_GO}
        </button>
      </div>
      {error ? (
        <p className="gs-paste-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="gs-foot-note">{ACCOUNT_COPY.JOIN_ONCE}</p>
      )}
    </section>
  )
}
