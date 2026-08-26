import { MKT_SERVE } from '../../shared/marketplace-copy'

/**
 * SHARE ON SAVE — the one publish entry (owner ruling, 2026-08-26).
 *
 * The share question rides INSIDE the save sheet, not a second sheet after it:
 * one breath, one act. A follow-up sheet is a place to abandon; a section is a
 * place to glance past, and the default answers it safely — `just-me` publishes
 * nothing, so a user who reads none of this cannot open a door by accident.
 *
 * Retires the Board's WHO CAN CALL panel and the per-agent export toggles. R30
 * already deleted the per-agent grant matrix server-side (a caller talks to the
 * orch and nothing else); this is the UI finally agreeing with the protocol.
 */

export type ShareAccess = 'just-me' | 'account' | 'paid'

/** A well-formed price — mirrors `validPrice` in session-served.ts. */
export function priceLooksGood(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0
}

/**
 * The primary's label. It renames when the click gains a consequence — a plain
 * SAVE that also published would be exactly the quiet-consequence bug this
 * product refuses everywhere else.
 */
export function saveButtonLabel(access: ShareAccess, busy: boolean): string {
  if (busy) return 'SAVING…'
  return access === 'just-me' ? 'SAVE' : 'SAVE · START SERVING'
}

/** Can the sheet be submitted? A paid door with no price cannot quote at 402. */
export function canSubmitShare(access: ShareAccess, priceUsd: string): boolean {
  return access !== 'paid' || priceLooksGood(priceUsd)
}

export function ShareOnSave({
  access,
  priceUsd,
  door,
  onAccess,
  onPrice
}: {
  access: ShareAccess
  priceUsd: string
  /** The orch's name — the one door a caller ever reaches. */
  door: string
  onAccess: (next: ShareAccess) => void
  onPrice: (next: string) => void
}): React.JSX.Element {
  const option = (
    value: ShareAccess,
    title: string,
    sub: string
  ): React.JSX.Element => (
    <button
      type="button"
      className={`sos-opt${access === value ? ' sel' : ''}`}
      aria-pressed={access === value}
      onClick={() => onAccess(value)}
    >
      <span className="sos-dot" />
      <span className="sos-text">
        <span className="sos-t">{title}</span>
        <span className="sos-s">{sub}</span>
      </span>
    </button>
  )

  return (
    <div className="sos">
      <span className="tf-label">{MKT_SERVE['mkt.serve.who'].toUpperCase()}</span>
      {option(
        'just-me',
        MKT_SERVE['mkt.serve.who.none'],
        MKT_SERVE['mkt.serve.who.none.sub']
      )}
      {option(
        'account',
        MKT_SERVE['mkt.serve.who.free'],
        MKT_SERVE['mkt.serve.who.free.sub']
      )}
      {option('paid', MKT_SERVE['mkt.serve.who.paid'], MKT_SERVE['mkt.serve.who.paid.sub'])}

      {access === 'paid' && (
        <div className="sos-price">
          <input
            className="tf-input sos-price-input"
            value={priceUsd}
            inputMode="decimal"
            placeholder="2.50"
            aria-label="Price in USDC per session"
            onChange={(e) => onPrice(e.target.value)}
          />
          <span className="sos-unit">USDC · per session</span>
          {priceUsd.length > 0 && !priceLooksGood(priceUsd) && (
            <span className="sos-bad">a price has to be a number above zero</span>
          )}
        </div>
      )}

      {/*
        THE DOOR FACT, shown only once a public option is picked: it answers the
        fear that arrives at that exact moment ("which of my agents are
        exposed?"). Before then it is noise.
      */}
      {access !== 'just-me' && (
        <div className="sos-door">
          <span className="sos-door-g">◫</span>
          <span className="sos-door-s">
            {MKT_SERVE['mkt.serve.door'].replace('{orch}', door)}
          </span>
        </div>
      )}
      <span className="sos-note">{MKT_SERVE['mkt.serve.reversible']}</span>
    </div>
  )
}
