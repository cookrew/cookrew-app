import { useState } from 'react'
import { normaliseJoinCode } from '../../../shared/join-code'
import { JOIN_CODE_EXAMPLE } from '../../../shared/join-code'
import type { FirstRunAction, FirstRunView } from './account-store'
import '../grant-surface.css'

/**
 * FIRST RUN (D8) — one ordinary card, not a modal and not a wall.
 *
 * It sits over the canvas at the top-left, where a fresh canvas has nothing
 * else, and it takes nothing over: no scrim, no focus trap, nothing behind it
 * stops working. The avatar keeps the same door open forever; this card is
 * the one-time pointer to it, and ✕ or NOT NOW closes it for good.
 *
 * WHAT IT DRAWS IS DECIDED ELSEWHERE. `firstRunView` says whether the card
 * exists at all and which buttons it has; this component only renders the
 * answer. JOIN is absent until the cut that ships it, and the join half of
 * the card goes with it rather than standing there disabled.
 *
 * THE JOIN FIELD DOES NOT SPEND THE CODE (v3, D8). It hands it to the card
 * that does (JoinCard), through the surface — one ceremony, whether the code
 * was typed here or arrived as a link. The field's own job is to refuse what
 * cannot be a code at all, before anything is sent anywhere.
 */
export function FirstRunCard({
  view,
  onAction,
  onJoin,
}: {
  view: FirstRunView
  onAction: (action: FirstRunAction) => void
  /** A code the person typed, normalised. Absent = no join half on this card. */
  onJoin?: (code: string) => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const normalised = normaliseJoinCode(code)
  const offer = (): void => {
    if (normalised !== null) onJoin?.(normalised)
  }
  return (
    <section className="gs-sheet gs-small cr-sheet cr-acct-firstrun" aria-label={view.title}>
      <header className="gs-sheet-head">
        <h2 className="cr-acct-cardhead">{view.title}</h2>
        <button className="gs-x" onClick={() => onAction('dismiss')} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="gs-consequence">{view.lede}</p>
      {view.join && onJoin && (
        <div className="cr-acct-firstrun-join">
          <h3 className="gs-label">{view.join.ask}</h3>
          <div className="cr-acct-row">
            <input
              className="gs-input"
              aria-label={view.join.label}
              placeholder={JOIN_CODE_EXAMPLE}
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && offer()}
            />
            <button className="gs-primary" disabled={normalised === null} onClick={offer}>
              {view.join.go}
            </button>
          </div>
          <p className="gs-hint">{view.join.how}</p>
        </div>
      )}
      <div className="gs-sheet-foot cr-acct-firstrun-foot">
        {view.buttons.map((button) => (
          <button
            key={button.action}
            className={button.action === 'dismiss' ? 'gs-ghost' : 'gs-primary'}
            onClick={() => onAction(button.action)}
          >
            {button.label}
          </button>
        ))}
      </div>
    </section>
  )
}
