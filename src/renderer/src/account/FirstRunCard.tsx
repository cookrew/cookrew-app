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
 */
export function FirstRunCard({
  view,
  onAction,
}: {
  view: FirstRunView
  onAction: (action: FirstRunAction) => void
}): React.JSX.Element {
  return (
    <section className="gs-sheet gs-small cr-sheet cr-acct-firstrun" aria-label={view.title}>
      <header className="gs-sheet-head">
        <h2 className="cr-acct-cardhead">{view.title}</h2>
        <button className="gs-x" onClick={() => onAction('dismiss')} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="gs-consequence">{view.lede}</p>
      {view.join && (
        <div className="cr-acct-firstrun-join">
          <h3 className="gs-label">{view.join.ask}</h3>
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
