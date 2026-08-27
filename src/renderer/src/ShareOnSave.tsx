import {
  MKT_SERVE,
  fillCopy,
  servedPaymentRailsLabel
} from '../../shared/marketplace-copy'
import type { ServedPaymentRail } from '../../shared/served-payment-rails'

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

/**
 * Can the sheet be submitted?
 *
 * A paid door with no price cannot quote at 402, and a PUBLIC door with no orch
 * cannot answer anybody — the crew would save, start serving, and hand the
 * first caller's prompt to a bare shell (owner ruling, 2026-08-26). Both are
 * refused HERE, at the moment of the act, rather than by the gate a caller
 * meets later: a silent save that 503s a stranger is a failure the owner never
 * sees and the caller cannot explain.
 *
 * `door` is null when nothing in the selection is flagged as the orch. A
 * private save is unaffected — `just-me` publishes nothing, so it needs no
 * door.
 */
export function canSubmitShare(
  access: ShareAccess,
  priceUsd: string,
  door: string | null
): boolean {
  if (access === 'just-me') return true
  if (door === null) return false
  return access !== 'paid' || priceLooksGood(priceUsd)
}

/**
 * A refusal from the main process, in the owner's words.
 *
 * The sheet blocks every reason it can see before the save, so anything that
 * reaches here is a reason it could NOT see — a template deleted underneath it,
 * an orch flag cleared between the sheet opening and the button — and the raw
 * `no-orch` the IPC returns is a token, not a sentence. Unknown reasons keep
 * their own text rather than being flattened to "unknown": a code we have not
 * met yet is still more useful than a word that means nothing.
 */
export function serveRefusalText(reason: string | undefined): string {
  if (reason === undefined) return 'the reason was not reported'
  if (reason === 'no-orch') return MKT_SERVE['mkt.serve.no-orch']
  if (reason === 'bad-price') return MKT_SERVE['mkt.serve.refused.bad-price']
  if (reason === 'priced-free-door') return MKT_SERVE['mkt.serve.refused.priced-free-door']
  if (reason === 'grant-unusable') return MKT_SERVE['mkt.serve.refused.grant-unusable']
  if (reason === 'no-template') return 'that template is no longer on this machine.'
  return reason
}

export function ShareOnSave({
  access,
  priceUsd,
  paymentRails,
  door,
  onAccess,
  onPrice
}: {
  access: ShareAccess
  priceUsd: string
  paymentRails: readonly ServedPaymentRail[]
  /**
   * The orch's name — the one door a caller ever reaches — or null when the
   * selection flags no orch. Null is a refusal, never a placeholder: this used
   * to fall back to the first picked terminal (and then to the word
   * 'Conductor'), which is how the sheet came to promise a door that did not
   * exist.
   */
  door: string | null
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
            aria-label={MKT_SERVE['mkt.serve.price.label']}
            onChange={(e) => onPrice(e.target.value)}
          />
          <span className="sos-unit">{MKT_SERVE['mkt.serve.price.unit']}</span>
          <span className="sos-rails">
            {paymentRails.length > 0
              ? fillCopy(MKT_SERVE['mkt.serve.rails.live'], {
                  rails: servedPaymentRailsLabel(paymentRails)
                })
              : MKT_SERVE['mkt.serve.rails.none']}
          </span>
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
      {access !== 'just-me' && door !== null && (
        <div className="sos-door">
          <span className="sos-door-g">◫</span>
          <span className="sos-door-s">
            {MKT_SERVE['mkt.serve.door'].replace('{orch}', door)}
          </span>
        </div>
      )}

      {/*
        THE REFUSAL, in the same slot the door fact would have occupied — the
        answer to "which of my agents are exposed?" is "none of them, and that
        is the problem". Rendered beside a disabled primary so the button and
        the sentence arrive together; a disabled button with no sentence is the
        touch-invisible dead end this product keeps having to fix.
      */}
      {access !== 'just-me' && door === null && (
        <div className="sos-door sos-door-bad" role="alert">
          <span className="sos-door-g">◆</span>
          <span className="sos-door-s">{MKT_SERVE['mkt.serve.no-orch']}</span>
        </div>
      )}
      <span className="sos-note">{MKT_SERVE['mkt.serve.reversible']}</span>
    </div>
  )
}
